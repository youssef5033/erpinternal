import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accountHealthOverrides, activities, changeRequests, deliverables, engagements, invoices, opportunities } from "@/db/schema";
import { addDaysISO, daysBetween } from "@/lib/dates";
import { d } from "@/lib/money";
import { agencyToday, getSettings } from "../system/settings";
import { outstandingSql } from "../finance/invoices";
import { engagementProfitability } from "../finance/profitability";

/**
 * Explainable account health (0–100). Starts at 100 and subtracts documented
 * penalties, each with evidence and a link to the source record. A manual
 * override is shown alongside the computed score and is always logged.
 *
 *  Overdue invoices          −15 each (max −30); −10 more if any is >60 days overdue
 *  Late deliverables         −10 each (max −20)
 *  Engagement over budget    −15 each (max −30)
 *  No client contact          −15 if >45 days, −25 if >90 days (active/onboarding accounts)
 *  Renewal at risk           −10 per retainer ending within the renewal window with no renewal
 *  Scope change waiting      −5 per change request pending >14 days
 *  Bands: ≥75 healthy · 50–74 watch · <50 at risk
 */
export type HealthFactor = { key: string; label: string; impact: number; evidence: string; href: string };
export type AccountHealth = { score: number; computedScore: number; band: "healthy" | "watch" | "at_risk"; factors: HealthFactor[]; override: { score: number; reason: string; createdAt: Date; createdBy: string | null } | null };

export function band(score: number): AccountHealth["band"] {
  return score >= 75 ? "healthy" : score >= 50 ? "watch" : "at_risk";
}

export async function accountHealth(tx: Tx, accountId: string, opts: { includeBudget?: boolean } = {}): Promise<AccountHealth> {
  const today = await agencyToday(tx);
  const s = await getSettings(tx);
  const factors: HealthFactor[] = [];

  const overdue = (
    await tx
      .select({ id: invoices.id, number: invoices.number, dueDate: invoices.dueDate, currency: invoices.currency, outstanding: outstandingSql })
      .from(invoices)
      .where(and(eq(invoices.accountId, accountId), eq(invoices.status, "issued"), lt(invoices.dueDate, today)))
  ).filter((i) => d(i.outstanding).greaterThan(0));
  if (overdue.length) {
    factors.push({ key: "overdue_invoices", label: "Overdue invoices", impact: -Math.min(30, overdue.length * 15), evidence: overdue.map((i) => `${i.number}: ${i.currency} ${d(i.outstanding).toFixed(2)} due ${i.dueDate}`).join("; "), href: `/finance/invoices?account=${accountId}&status=overdue` });
    const worst = overdue.reduce((m, i) => Math.max(m, daysBetween(i.dueDate!, today)), 0);
    if (worst > 60) factors.push({ key: "severely_overdue", label: "Severely overdue (>60 days)", impact: -10, evidence: `Oldest overdue by ${worst} days`, href: `/finance/invoices?account=${accountId}&status=overdue` });
  }

  const engs = await tx.select().from(engagements).where(eq(engagements.accountId, accountId));
  const engIds = engs.map((e) => e.id);
  if (engIds.length) {
    const late = await tx
      .select()
      .from(deliverables)
      .where(and(inArray(deliverables.engagementId, engIds), lt(deliverables.dueDate, today), sql`${deliverables.approvalStatus} not in ('approved','rejected')`));
    if (late.length) factors.push({ key: "late_deliverables", label: "Late deliverables", impact: -Math.min(20, late.length * 10), evidence: late.map((x) => `${x.name} (due ${x.dueDate})`).join("; "), href: `/delivery/engagements/${late[0].engagementId}?tab=deliverables` });

    if (opts.includeBudget !== false) {
      const prof = await engagementProfitability(tx, { engagementIds: engIds.filter((id) => ["active", "onboarding", "on_hold"].includes(engs.find((e) => e.id === id)!.status)) });
      const over = prof.rows.filter((r) => r.overBudget);
      if (over.length) factors.push({ key: "over_budget", label: "Engagement over budget", impact: -Math.min(30, over.length * 15), evidence: over.map((r) => `${r.number}: ${r.hoursUsedPct ?? "–"}% of hours, ${r.costUsedPct ?? "–"}% of cost budget`).join("; "), href: `/delivery/engagements/${over[0].engagementId}?tab=budget` });
    }

    const renewWindow = addDaysISO(today, s.renewalLeadDays);
    const renewals = engs.filter((e) => e.billingModel === "retainer" && ["active", "onboarding"].includes(e.status) && e.endDate && e.endDate <= renewWindow && e.endDate >= today);
    for (const e of renewals) {
      const [renewalOpp] = await tx.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.parentEngagementId, e.id), eq(opportunities.kind, "renewal"), inArray(opportunities.status, ["open", "won"])));
      if (!renewalOpp) factors.push({ key: "renewal_risk", label: "Renewal not yet secured", impact: -10, evidence: `${e.number} ends ${e.endDate} with no renewal recorded`, href: `/delivery/engagements/${e.id}?tab=renewal` });
    }

    const pending = await tx
      .select()
      .from(changeRequests)
      .where(and(inArray(changeRequests.engagementId, engIds), eq(changeRequests.status, "submitted"), lt(changeRequests.createdAt, new Date(Date.now() - 14 * 86400000))));
    if (pending.length) factors.push({ key: "scope_change_waiting", label: "Scope change waiting >14 days", impact: -5 * pending.length, evidence: pending.map((p) => p.number).join(", "), href: `/delivery/engagements/${pending[0].engagementId}?tab=scope` });
  }

  const [acc] = await tx.execute<{ lifecycle_status: string }>(sql`select lifecycle_status from accounts where id = ${accountId}`).then((r) => r.rows);
  if (acc && ["active", "onboarding"].includes(acc.lifecycle_status)) {
    const [last] = await tx
      .select({ at: activities.occurredAt })
      .from(activities)
      .where(and(eq(activities.accountId, accountId), inArray(activities.type, ["email", "call", "meeting", "message", "linkedin"]), sql`coalesce(${activities.direction}, '') <> 'internal'`))
      .orderBy(desc(activities.occurredAt))
      .limit(1);
    const days = last ? Math.floor((Date.now() - last.at.getTime()) / 86400000) : null;
    if (days === null || days > 45) {
      factors.push({ key: "no_contact", label: "No recent client contact", impact: days === null || days > 90 ? -25 : -15, evidence: days === null ? "No calls, meetings or messages logged" : `Last interaction ${days} days ago`, href: `/crm/accounts/${accountId}?tab=activity` });
    }
  }

  const computed = Math.max(0, Math.min(100, 100 + factors.reduce((a, f) => a + f.impact, 0)));
  const [ov] = await tx
    .select()
    .from(accountHealthOverrides)
    .where(and(eq(accountHealthOverrides.accountId, accountId), isNull(accountHealthOverrides.revokedAt), or(isNull(accountHealthOverrides.expiresAt), gt(accountHealthOverrides.expiresAt, today))))
    .orderBy(desc(accountHealthOverrides.createdAt))
    .limit(1);
  const score = ov ? ov.score : computed;
  return { score, computedScore: computed, band: band(score), factors, override: ov ? { score: ov.score, reason: ov.reason, createdAt: ov.createdAt, createdBy: ov.createdBy } : null };
}

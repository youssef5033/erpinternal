import { and, desc, eq, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  activities,
  bankAccounts,
  bankTransactions,
  changeRequests,
  contracts,
  deliverables,
  engagements,
  expenses,
  invoices,
  leads,
  leaveRequests,
  opportunities,
  people,
  pipelineStages,
  proposals,
  signalEvents,
  signals,
  timeEntries,
  user,
  type SignalSeverity,
} from "@/db/schema";
import { addDaysISO, daysBetween } from "@/lib/dates";
import { d, formatMoney } from "@/lib/money";
import { isSystem, type Actor } from "../auth/actor";
import { NotFoundError, ValidationError } from "../errors";
import { agencyToday, getSettings } from "../system/settings";
import { outstandingSql } from "../finance/invoices";
import { engagementProfitability } from "../finance/profitability";
import { cashForecast } from "../finance/forecast";

export type DetectedSignal = {
  ruleKey: string;
  category: "collections" | "delivery" | "sales" | "finance" | "people" | "renewals";
  severity: SignalSeverity;
  title: string;
  reason: string;
  resolutionAction: string;
  entityType: string;
  entityId: string;
  href: string;
  ownerId: string | null;
  metadata?: Record<string, unknown>;
};

export const SIGNAL_RULES: { key: string; label: string; description: string }[] = [
  { key: "invoice_overdue", label: "Overdue invoice", description: "Issued invoice past its due date with an outstanding balance (derived from allocations and credit notes)." },
  { key: "engagement_over_budget", label: "Project over budget", description: "Approved hours or direct costs exceed the engagement budget." },
  { key: "scope_change_pending", label: "Scope change awaiting approval", description: "Change request submitted and not yet approved or rejected." },
  { key: "deliverable_late", label: "Late deliverable", description: "Deliverable past its due date and not yet approved by the client." },
  { key: "revision_limit_exceeded", label: "Revision limit exceeded", description: "Client revision rounds exceed the included revisions." },
  { key: "retainer_renewal_due", label: "Retainer approaching renewal", description: "Retainer ends within the renewal window and no next period or renewal opportunity exists." },
  { key: "missing_time", label: "Missing time entries", description: "A team member logged no time on working days in the look-back window (excluding approved leave)." },
  { key: "bank_unreconciled", label: "Unreconciled bank transactions", description: "Statement lines older than 7 days not matched to a record." },
  { key: "spend_over_threshold", label: "Spending outside threshold", description: "Submitted expense above the configured approval threshold." },
  { key: "cash_below_threshold", label: "Low forecast cash", description: "Base-scenario 13-week forecast falls below the minimum cash threshold." },
  { key: "sales_followup_overdue", label: "Sales follow-up overdue", description: "Open opportunity or active lead whose next action date has passed." },
  { key: "proposal_followup", label: "Proposal awaiting follow-up", description: "Proposal sent more than 7 days ago with no client interaction since." },
  { key: "contract_missing", label: "Unsigned or missing contract", description: "Active engagement without a signed or active contract." },
];

async function detect(tx: Tx): Promise<DetectedSignal[]> {
  const today = await agencyToday(tx);
  const s = await getSettings(tx);
  const out: DetectedSignal[] = [];

  // Overdue invoices
  const inv = await tx
    .select({ i: invoices, accountName: accounts.name, ownerId: accounts.ownerId, outstanding: outstandingSql })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .where(and(eq(invoices.status, "issued"), lt(invoices.dueDate, today)));
  for (const r of inv) {
    if (d(r.outstanding).lessThanOrEqualTo(0)) continue;
    const days = daysBetween(r.i.dueDate!, today);
    const partial = d(r.outstanding).lessThan(d(r.i.total));
    out.push({
      ruleKey: "invoice_overdue",
      category: "collections",
      severity: days > 30 ? "critical" : "warning",
      title: `${r.i.number} overdue ${days} days — ${r.accountName}`,
      reason: `${formatMoney(r.outstanding, r.i.currency)} outstanding${partial ? ` of ${formatMoney(r.i.total, r.i.currency)} (partially paid)` : ""}; due ${r.i.dueDate}.`,
      resolutionAction: "Follow up with the client, then record and allocate the payment (or a credit note).",
      entityType: "invoice",
      entityId: r.i.id,
      href: `/finance/invoices/${r.i.id}`,
      ownerId: r.ownerId,
      metadata: { daysOverdue: days, outstanding: r.outstanding, currency: r.i.currency },
    });
  }

  // Engagements over budget
  const prof = await engagementProfitability(tx, { where: inArray(engagements.status, ["onboarding", "active", "on_hold"]) });
  const engOwners = new Map((await tx.select({ id: engagements.id, ownerId: engagements.ownerId }).from(engagements)).map((e) => [e.id, e.ownerId]));
  for (const r of prof.rows.filter((x) => x.overBudget)) {
    out.push({
      ruleKey: "engagement_over_budget",
      category: "delivery",
      severity: d(r.hoursUsedPct ?? 0).greaterThan(120) || d(r.costUsedPct ?? 0).greaterThan(120) ? "critical" : "warning",
      title: `${r.number} over budget — ${r.accountName}`,
      reason: [r.hoursUsedPct ? `${r.approvedHours}h approved = ${r.hoursUsedPct}% of ${d(r.budgetHours).toFixed(0)}h budget` : null, r.costUsedPct ? `direct cost ${r.costUsedPct}% of budget` : null].filter(Boolean).join("; "),
      resolutionAction: "Review remaining scope; raise a change request or re-plan the work.",
      entityType: "engagement",
      entityId: r.engagementId,
      href: `/delivery/engagements/${r.engagementId}?tab=budget`,
      ownerId: engOwners.get(r.engagementId) ?? null,
    });
  }

  // Scope changes pending
  const crs = await tx.select({ c: changeRequests, e: engagements }).from(changeRequests).innerJoin(engagements, eq(engagements.id, changeRequests.engagementId)).where(eq(changeRequests.status, "submitted"));
  for (const { c, e } of crs) {
    out.push({
      ruleKey: "scope_change_pending",
      category: "delivery",
      severity: Date.now() - c.createdAt.getTime() > 7 * 86400000 ? "warning" : "info",
      title: `${c.number} awaiting approval — ${c.title}`,
      reason: `Fee impact ${formatMoney(c.feeImpact, c.currency)}, ${c.deadlineImpactDays} days on ${e.number}. Submitted ${c.createdAt.toISOString().slice(0, 10)}.`,
      resolutionAction: "Get the client's decision and record approval evidence, or reject/withdraw it.",
      entityType: "change_request",
      entityId: c.id,
      href: `/delivery/engagements/${e.id}?tab=scope`,
      ownerId: e.ownerId,
    });
  }

  // Late deliverables & revision limit
  const dls = await tx
    .select({ dl: deliverables, e: engagements })
    .from(deliverables)
    .innerJoin(engagements, eq(engagements.id, deliverables.engagementId))
    .where(and(inArray(engagements.status, ["onboarding", "active", "on_hold"]), sql`${deliverables.approvalStatus} not in ('approved','rejected')`));
  for (const { dl, e } of dls) {
    if (dl.dueDate && dl.dueDate < today) {
      const days = daysBetween(dl.dueDate, today);
      out.push({
        ruleKey: "deliverable_late",
        category: "delivery",
        severity: days > 7 ? "critical" : "warning",
        title: `${dl.name} is ${days} days late — ${e.number}`,
        reason: `Due ${dl.dueDate}; status ${dl.approvalStatus.replace(/_/g, " ")}.`,
        resolutionAction: dl.approvalStatus === "awaiting_client" ? "Chase the client for a decision and record it." : "Submit the deliverable or agree a new date with the client.",
        entityType: "deliverable",
        entityId: dl.id,
        href: `/delivery/engagements/${e.id}?tab=deliverables#${dl.id}`,
        ownerId: dl.ownerId ?? e.ownerId,
      });
    }
    if (dl.includedRevisions != null && dl.revisionsUsed > dl.includedRevisions) {
      out.push({
        ruleKey: "revision_limit_exceeded",
        category: "delivery",
        severity: "warning",
        title: `${dl.name}: ${dl.revisionsUsed} revision rounds (${dl.includedRevisions} included)`,
        reason: `Client revisions exceed the scope on ${e.number}.`,
        resolutionAction: "Raise a change request for the extra rounds or record why they are absorbed.",
        entityType: "deliverable",
        entityId: dl.id,
        href: `/delivery/engagements/${e.id}?tab=deliverables#${dl.id}`,
        ownerId: e.ownerId,
      });
    }
  }

  // Retainers approaching renewal
  const window = addDaysISO(today, s.renewalLeadDays);
  const rets = await tx.select().from(engagements).where(and(eq(engagements.billingModel, "retainer"), inArray(engagements.status, ["onboarding", "active"]), lte(engagements.endDate, window)));
  for (const e of rets) {
    const [renewal] = await tx.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.parentEngagementId, e.id), eq(opportunities.kind, "renewal"), ne(opportunities.status, "lost"), sql`${opportunities.createdAt} > now() - interval '120 days'`));
    if (renewal) continue;
    const days = daysBetween(today, e.endDate!);
    out.push({
      ruleKey: "retainer_renewal_due",
      category: "renewals",
      severity: days < 0 ? "critical" : days <= 14 ? "critical" : "warning",
      title: `${e.number} retainer ${days < 0 ? `ended ${-days} days ago` : `ends in ${days} days`}`,
      reason: `Current period ends ${e.endDate}${e.noticePeriodDays ? `; notice period ${e.noticePeriodDays} days` : ""}. No renewal recorded.`,
      resolutionAction: "Hold the renewal conversation; renew the retainer or open a renewal opportunity.",
      entityType: "engagement",
      entityId: e.id,
      href: `/delivery/engagements/${e.id}?tab=renewal`,
      ownerId: e.ownerId,
    });
  }

  // Missing time entries (employees & contractors with logins, working days in look-back)
  const lookback = s.missingTimeLookbackDays;
  const days: string[] = [];
  for (let i = 1; days.length < lookback && i < 21; i++) {
    const dt = addDaysISO(today, -i);
    const dow = new Date(`${dt}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(dt);
  }
  if (days.length) {
    const ppl = await tx.select().from(people).where(and(eq(people.status, "active"), sql`${people.userId} is not null`));
    for (const p of ppl) {
      if (p.startDate && p.startDate > days[days.length - 1]) continue;
      const wd = (p.workingDays ?? [1, 2, 3, 4, 5]) as number[];
      const required = days.filter((dt) => wd.includes(new Date(`${dt}T00:00:00Z`).getUTCDay()));
      if (!required.length) continue;
      const logged = new Set((await tx.select({ dt: timeEntries.workDate }).from(timeEntries).where(and(eq(timeEntries.personId, p.id), inArray(timeEntries.workDate, required)))).map((r) => r.dt));
      const leave = await tx.select().from(leaveRequests).where(and(eq(leaveRequests.personId, p.id), eq(leaveRequests.status, "approved"), lte(leaveRequests.startDate, required[0])));
      const missing = required.filter((dt) => !logged.has(dt) && !leave.some((l) => l.startDate <= dt && l.endDate >= dt));
      if (missing.length >= 2) {
        out.push({
          ruleKey: "missing_time",
          category: "people",
          severity: missing.length >= 4 ? "warning" : "info",
          title: `${p.fullName}: no time logged on ${missing.length} working days`,
          reason: `Missing: ${missing.sort().join(", ")}.`,
          resolutionAction: "Log time for those days (or record leave).",
          entityType: "person",
          entityId: p.id,
          href: `/people/timesheets?tab=approvals&person=${p.id}`,
          ownerId: p.userId,
        });
      }
    }
  }

  // Unreconciled bank transactions (>7 days)
  const old = await tx
    .select({ bankAccountId: bankTransactions.bankAccountId, n: sql<number>`count(*)`, oldest: sql<string>`min(${bankTransactions.txnDate})` })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.status, "unreconciled"), lt(bankTransactions.txnDate, addDaysISO(today, -7))))
    .groupBy(bankTransactions.bankAccountId);
  for (const r of old) {
    const [b] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, r.bankAccountId));
    out.push({
      ruleKey: "bank_unreconciled",
      category: "finance",
      severity: Number(r.n) > 10 ? "warning" : "info",
      title: `${r.n} unreconciled transactions in ${b.name}`,
      reason: `Oldest unmatched line dated ${r.oldest}.`,
      resolutionAction: "Match each line to its payment, bill or expense, or categorise it.",
      entityType: "bank_account",
      entityId: r.bankAccountId,
      href: `/finance/bank?account=${r.bankAccountId}`,
      ownerId: null,
    });
  }

  // Spending outside threshold (awaiting approval)
  const exps = await tx.select().from(expenses).where(and(eq(expenses.status, "submitted"), eq(expenses.exceedsThreshold, true)));
  for (const e of exps) {
    out.push({
      ruleKey: "spend_over_threshold",
      category: "finance",
      severity: "warning",
      title: `${e.number} above approval threshold — ${formatMoney(d(e.amount).plus(d(e.taxAmount)), e.currency)}`,
      reason: `${e.description} (${e.expenseDate}) exceeds the configured threshold and needs approval.`,
      resolutionAction: "Approve with justification or reject the expense.",
      entityType: "expense",
      entityId: e.id,
      href: `/finance/bills/expenses/${e.id}`,
      ownerId: null,
    });
  }

  // Low forecast cash
  if (s.minimumCashThreshold) {
    try {
      const fc = await cashForecast(tx, "base");
      if (fc.lowest && d(fc.lowest.closing).lessThan(d(s.minimumCashThreshold))) {
        out.push({
          ruleKey: "cash_below_threshold",
          category: "finance",
          severity: d(fc.lowest.closing).isNegative() ? "critical" : "warning",
          title: `Forecast cash drops to ${formatMoney(fc.lowest.closing, fc.baseCurrency)} (week of ${fc.lowest.week})`,
          reason: `Below the minimum threshold of ${formatMoney(s.minimumCashThreshold, fc.baseCurrency)} in the base scenario.`,
          resolutionAction: "Chase receivables, bring billing forward or defer payments.",
          entityType: "cash_forecast",
          entityId: "base",
          href: "/finance/cash",
          ownerId: null,
        });
      }
    } catch {
      // Missing FX rates surface in System health; no fabricated forecast.
    }
  }

  // Sales follow-ups overdue
  const opps = await tx.select({ o: opportunities, accountName: accounts.name }).from(opportunities).innerJoin(accounts, eq(accounts.id, opportunities.accountId)).where(and(eq(opportunities.status, "open"), lt(opportunities.nextActionDate, today)));
  for (const { o, accountName } of opps) {
    out.push({
      ruleKey: "sales_followup_overdue",
      category: "sales",
      severity: daysBetween(o.nextActionDate!, today) > 7 ? "warning" : "info",
      title: `Follow-up overdue: ${o.number} ${accountName}`,
      reason: `"${o.nextAction ?? "Next action"}" was due ${o.nextActionDate}.`,
      resolutionAction: "Do the follow-up, log it, and set the next action.",
      entityType: "opportunity",
      entityId: o.id,
      href: `/crm/opportunities/${o.id}`,
      ownerId: o.ownerId,
    });
  }
  const ls = await tx
    .select()
    .from(leads)
    .where(and(inArray(leads.status, ["new", "researching", "qualified", "nurture"]), sql`coalesce(${leads.nextActionDate}, ${leads.followUpDate}) < ${today}`));
  for (const l of ls) {
    const due = l.nextActionDate ?? l.followUpDate!;
    out.push({
      ruleKey: "sales_followup_overdue",
      category: "sales",
      severity: "info",
      title: `Lead follow-up overdue: ${l.companyName}`,
      reason: `${l.nextAction ? `"${l.nextAction}" ` : "Follow-up "}was due ${due}.`,
      resolutionAction: "Contact the lead or update its next action.",
      entityType: "lead",
      entityId: l.id,
      href: `/crm/leads/${l.id}`,
      ownerId: l.ownerId,
    });
  }

  // Proposals awaiting follow-up
  const sent = await tx.select().from(proposals).where(and(eq(proposals.status, "sent"), lt(proposals.sentAt, new Date(Date.now() - 7 * 86400000))));
  for (const p of sent) {
    const [last] = await tx
      .select({ at: activities.occurredAt })
      .from(activities)
      .where(and(eq(activities.opportunityId, p.opportunityId), inArray(activities.type, ["email", "call", "meeting", "message", "linkedin"]), sql`coalesce(${activities.direction}, '') <> 'internal'`))
      .orderBy(desc(activities.occurredAt))
      .limit(1);
    if (last && p.sentAt && last.at > p.sentAt) continue;
    out.push({
      ruleKey: "proposal_followup",
      category: "sales",
      severity: "warning",
      title: `${p.number} sent ${Math.floor((Date.now() - p.sentAt!.getTime()) / 86400000)} days ago without follow-up`,
      reason: `"${p.title}" — valid until ${p.validUntil ?? "n/a"}.`,
      resolutionAction: "Follow up with the client and log the conversation.",
      entityType: "proposal",
      entityId: p.id,
      href: `/crm/opportunities/${p.opportunityId}?tab=proposals`,
      ownerId: p.ownerId,
    });
  }

  // Active engagements without a signed contract
  const active = await tx.select().from(engagements).where(inArray(engagements.status, ["onboarding", "active"]));
  for (const e of active) {
    const [c] = await tx.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.engagementId, e.id), inArray(contracts.status, ["signed", "active"]))).limit(1);
    if (c) continue;
    out.push({
      ruleKey: "contract_missing",
      category: "delivery",
      severity: e.status === "active" ? "warning" : "info",
      title: `${e.number} has no signed contract`,
      reason: `${e.name} is ${e.status} without a signed or active contract on file.`,
      resolutionAction: "Upload the signed contract/SOW and mark it signed.",
      entityType: "engagement",
      entityId: e.id,
      href: `/delivery/engagements/${e.id}?tab=contracts`,
      ownerId: e.ownerId,
    });
  }
  return out;
}

const fp = (s: Pick<DetectedSignal, "ruleKey" | "entityType" | "entityId">) => `${s.ruleKey}:${s.entityType}:${s.entityId}`;

/**
 * Recalculate signals from source records. One open signal per fingerprint
 * (rule + record); re-detection updates it; disappearance resolves it
 * automatically (history in signal_events). Serialised with an advisory lock.
 */
export async function refreshSignals(tx: Tx): Promise<{ created: number; updated: number; resolved: number }> {
  const lock = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(424242) as ok`);
  if (!lock.rows[0]?.ok) return { created: 0, updated: 0, resolved: 0 };
  const detected = await detect(tx);
  const byFp = new Map<string, DetectedSignal>();
  for (const s of detected) if (!byFp.has(fp(s))) byFp.set(fp(s), s);
  const open = await tx.select().from(signals).where(isNull(signals.resolvedAt));
  const openByFp = new Map(open.map((o) => [o.fingerprint, o]));
  let created = 0, updated = 0, resolved = 0;
  const now = new Date();
  for (const [key, s] of byFp) {
    const existing = openByFp.get(key);
    if (existing) {
      const wake = existing.status === "snoozed" && existing.snoozedUntil && existing.snoozedUntil <= now;
      await tx
        .update(signals)
        .set({ lastDetectedAt: now, severity: s.severity, title: s.title, reason: s.reason, resolutionAction: s.resolutionAction, href: s.href, ownerId: s.ownerId, metadata: s.metadata ?? {}, status: wake ? "active" : existing.status, snoozedUntil: wake ? null : existing.snoozedUntil })
        .where(eq(signals.id, existing.id));
      if (wake) await tx.insert(signalEvents).values({ signalId: existing.id, event: "reopened", note: "Snooze ended; issue still present" });
      updated++;
    } else {
      const [row] = await tx
        .insert(signals)
        .values({ ruleKey: s.ruleKey, fingerprint: key, category: s.category, severity: s.severity, title: s.title, reason: s.reason, resolutionAction: s.resolutionAction, entityType: s.entityType, entityId: s.entityId, href: s.href, ownerId: s.ownerId, metadata: s.metadata ?? {} })
        .onConflictDoNothing()
        .returning();
      if (row) {
        await tx.insert(signalEvents).values({ signalId: row.id, event: "detected", note: s.reason });
        created++;
      }
    }
  }
  for (const o of open) {
    if (byFp.has(o.fingerprint)) continue;
    await tx.update(signals).set({ status: "resolved", resolution: o.status === "dismissed" ? "dismissed" : "source_resolved", resolvedAt: now }).where(eq(signals.id, o.id));
    await tx.insert(signalEvents).values({ signalId: o.id, event: "resolved", note: "Source issue no longer present" });
    resolved++;
  }
  return { created, updated, resolved };
}

export async function snoozeSignal(tx: Tx, actor: Actor, id: string, until: string, note?: string | null) {
  const [s] = await tx.select().from(signals).where(eq(signals.id, id));
  if (!s) throw new NotFoundError("Signal");
  if (s.resolvedAt) throw new ValidationError("This signal is already resolved.");
  await tx.update(signals).set({ status: "snoozed", snoozedUntil: new Date(`${until}T00:00:00Z`) }).where(eq(signals.id, id));
  await tx.insert(signalEvents).values({ signalId: id, event: "snoozed", note: note || `Until ${until}`, actorId: isSystem(actor) ? null : actor.userId });
}

/** Dismiss = acknowledged; it stays hidden while the issue persists and resolves when the source clears. */
export async function dismissSignal(tx: Tx, actor: Actor, id: string, note: string) {
  if (!note.trim()) throw new ValidationError("Say why you are dismissing this signal.");
  const [s] = await tx.select().from(signals).where(eq(signals.id, id));
  if (!s) throw new NotFoundError("Signal");
  await tx.update(signals).set({ status: "dismissed" }).where(eq(signals.id, id));
  await tx.insert(signalEvents).values({ signalId: id, event: "dismissed", note, actorId: isSystem(actor) ? null : actor.userId });
}

export async function signalHistory(tx: Tx, id: string) {
  return tx.select({ e: signalEvents, actorName: user.name }).from(signalEvents).leftJoin(user, eq(user.id, signalEvents.actorId)).where(eq(signalEvents.signalId, id)).orderBy(desc(signalEvents.createdAt));
}

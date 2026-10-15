import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { engagements, milestones, revenueRecognitions, servicePeriods, timeEntries } from "@/db/schema";
import { addMonthsISO, monthEndISO, monthStartISO } from "@/lib/dates";
import { allocateProportionally, d, Decimal, toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ValidationError } from "../errors";
import { getSettings } from "../system/settings";
import { getRate, postJournal, revenueAccountForService } from "./ledger";

/**
 * Revenue recognition (see docs/ACCOUNTING.md). Each method produces a list of
 * recognition events with a unique key; posting is idempotent, so the job can
 * run repeatedly and only posts what is newly earned.
 *
 *  straight_line       retainers: monthly fee for each service-period month that has ENDED by asOf
 *  milestone           client-accepted milestones: their billing amount (or an equal share of the
 *                      contract value when milestones carry no amounts)
 *  time_and_materials  approved billable hours × bill rate, per completed month
 *  percent_complete    contract value × min(1, approved hours / budget hours), cumulative at each
 *                      completed month end; recognises the delta
 *  on_completion       full contract value when the engagement is completed
 *
 * Postings: Dr Deferred revenue / Cr Revenue (service stream).
 */
export type RecognitionEvent = { key: string; periodStart: string | null; periodEnd: string; amount: string; basis: string; milestoneId?: string | null; servicePeriodId?: string | null };

export async function recognitionPlan(tx: Tx, engagementId: string, asOf: string): Promise<RecognitionEvent[]> {
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  if (!eng) return [];
  const posted = await tx.select().from(revenueRecognitions).where(and(eq(revenueRecognitions.engagementId, engagementId), eq(revenueRecognitions.status, "posted")));
  const postedKeys = new Set(posted.map((p) => p.recognitionKey));
  const recognisedSoFar = posted.reduce((a, p) => a.plus(d(p.amount)), new Decimal(0));
  const events: RecognitionEvent[] = [];

  switch (eng.recognitionMethod) {
    case "straight_line": {
      const periods = await tx.select().from(servicePeriods).where(and(eq(servicePeriods.engagementId, engagementId), sql`${servicePeriods.status} <> 'cancelled'`));
      for (const p of periods) {
        const months: string[] = [];
        for (let m = p.startDate; m <= p.endDate; m = addMonthsISO(m, 1)) months.push(m);
        const shares = allocateProportionally(p.fee, months.map(() => "1"));
        months.forEach((m, i) => {
          const end = i === months.length - 1 ? p.endDate : monthEndBefore(addMonthsISO(m, 1));
          if (end <= asOf) {
            events.push({ key: `rr:${eng.id}:sp:${p.id}:${i + 1}`, periodStart: m, periodEnd: end, amount: shares[i], basis: `Retainer month ${i + 1}/${months.length} of period ${p.periodNumber} (${p.startDate} – ${p.endDate}): ${eng.currency} ${p.fee} ÷ ${months.length}`, servicePeriodId: p.id });
          }
        });
      }
      break;
    }
    case "milestone": {
      const ms = await tx.select().from(milestones).where(eq(milestones.engagementId, engagementId));
      const accepted = ms.filter((m) => m.status === "accepted" && m.acceptedAt && m.acceptedAt <= asOf);
      const withAmounts = ms.some((m) => m.billingAmount);
      for (const m of accepted) {
        const amount = withAmounts ? toMoney(m.billingAmount) : toMoney(d(eng.contractValue).div(ms.length || 1));
        if (d(amount).isZero()) continue;
        events.push({ key: `rr:${eng.id}:ms:${m.id}`, periodStart: null, periodEnd: m.acceptedAt!, amount, basis: withAmounts ? `Milestone "${m.name}" accepted ${m.acceptedAt}: billing amount ${eng.currency} ${m.billingAmount}` : `Milestone "${m.name}" accepted: contract value ÷ ${ms.length} milestones`, milestoneId: m.id });
      }
      break;
    }
    case "time_and_materials": {
      const rows = await tx
        .select({ month: sql<string>`to_char(${timeEntries.workDate}::date, 'YYYY-MM')`, hours: sql<string>`sum(${timeEntries.hours})`, value: sql<string>`sum(${timeEntries.hours} * coalesce(${timeEntries.billRate}, 0))` })
        .from(timeEntries)
        .where(and(eq(timeEntries.engagementId, engagementId), eq(timeEntries.status, "approved"), eq(timeEntries.billable, true)))
        .groupBy(sql`1`);
      for (const r of rows) {
        const start = `${r.month}-01`;
        const end = monthEndISO(start);
        if (end > asOf || d(r.value).isZero()) continue;
        events.push({ key: `rr:${eng.id}:tm:${r.month}`, periodStart: start, periodEnd: end, amount: toMoney(r.value), basis: `${d(r.hours).toFixed(2)} approved billable hours in ${r.month} × agreed rates` });
      }
      break;
    }
    case "percent_complete": {
      if (!eng.budgetHours || d(eng.budgetHours).isZero()) break;
      const start = eng.startDate ?? asOf;
      let cumulativeRecognised = recognisedSoFar;
      for (let m = monthStartISO(start); monthEndISO(m) <= asOf; m = addMonthsISO(m, 1)) {
        const end = monthEndISO(m);
        const key = `rr:${eng.id}:pc:${m.slice(0, 7)}`;
        if (postedKeys.has(key)) continue;
        const [h] = await tx
          .select({ hours: sql<string>`coalesce(sum(${timeEntries.hours}),0)` })
          .from(timeEntries)
          .where(and(eq(timeEntries.engagementId, engagementId), eq(timeEntries.status, "approved"), lte(timeEntries.workDate, end)));
        const pct = Decimal.min(1, d(h.hours).div(d(eng.budgetHours)));
        const target = d(toMoney(d(eng.contractValue).times(pct)));
        const delta = target.minus(cumulativeRecognised);
        if (delta.greaterThan(0)) {
          events.push({ key, periodStart: m, periodEnd: end, amount: delta.toFixed(2), basis: `${d(h.hours).toFixed(1)} of ${d(eng.budgetHours).toFixed(1)} budgeted hours approved by ${end} = ${pct.times(100).toFixed(1)}% × contract ${eng.currency} ${eng.contractValue}, less ${cumulativeRecognised.toFixed(2)} already recognised` });
          cumulativeRecognised = target;
        }
      }
      break;
    }
    case "on_completion": {
      if (eng.status === "completed" && eng.completedAt) {
        const date = eng.completedAt.toISOString().slice(0, 10);
        const remaining = d(eng.contractValue).minus(recognisedSoFar);
        if (date <= asOf && remaining.greaterThan(0)) events.push({ key: `rr:${eng.id}:complete`, periodStart: eng.startDate, periodEnd: date, amount: remaining.toFixed(2), basis: `Engagement completed ${date}: full contract value ${eng.currency} ${eng.contractValue}` });
      }
      break;
    }
  }
  return events.filter((e) => !postedKeys.has(e.key));
}

function monthEndBefore(nextMonthStart: string) {
  const dt = new Date(`${nextMonthStart}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export async function postRecognition(tx: Tx, actor: Actor, engagementId: string, asOf: string) {
  const plan = await recognitionPlan(tx, engagementId, asOf);
  if (!plan.length) return 0;
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  const settings = await getSettings(tx);
  const revenue = await revenueAccountForService(tx, eng.serviceId);
  let n = 0;
  for (const ev of plan) {
    const inserted = await tx
      .insert(revenueRecognitions)
      .values({ engagementId, recognitionKey: ev.key, method: eng.recognitionMethod, periodStart: ev.periodStart, periodEnd: ev.periodEnd, amount: ev.amount, currency: eng.currency, basis: ev.basis, milestoneId: ev.milestoneId ?? null, servicePeriodId: ev.servicePeriodId ?? null, createdBy: actor.userId || null })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) continue;
    const { rate } = await getRate(tx, eng.currency, settings.baseCurrency, ev.periodEnd);
    const { entry } = await postJournal(tx, actor, {
      entryDate: ev.periodEnd,
      memo: `Revenue recognised — ${eng.number}: ${ev.basis}`.slice(0, 500),
      sourceType: "revenue_recognition",
      sourceId: inserted[0].id,
      postingKey: ev.key,
      currency: eng.currency,
      rate,
      lines: [
        { systemKey: "deferred_revenue", amount: ev.amount, accountId: eng.accountId, engagementId: eng.id, serviceId: eng.serviceId, description: "Earned" },
        { ledgerAccountId: revenue.id, amount: d(ev.amount).negated().toString(), accountId: eng.accountId, engagementId: eng.id, serviceId: eng.serviceId, description: ev.basis.slice(0, 200) },
      ],
    });
    await tx.update(revenueRecognitions).set({ journalEntryId: entry.id }).where(eq(revenueRecognitions.id, inserted[0].id));
    n++;
  }
  await audit(tx, actor, { action: "revenue.recognised", entityType: "engagement", entityId: engagementId, summary: `Recognised ${n} revenue event(s) for ${eng.number} through ${asOf}` });
  return n;
}

/** Run recognition across all non-cancelled engagements (job + manual "Run now"). */
export async function runRevenueRecognition(tx: Tx, actor: Actor, asOf: string) {
  if (actor.roleKeys.length && !actor.roleKeys.includes("system")) assertCan(actor, "finance.post");
  const engs = await tx.select({ id: engagements.id }).from(engagements).where(inArray(engagements.status, ["onboarding", "active", "on_hold", "completed"]));
  let total = 0;
  for (const e of engs) total += await postRecognition(tx, actor, e.id, asOf);
  return total;
}

export async function recognitionSummary(tx: Tx, engagementId: string) {
  const rows = await tx.select().from(revenueRecognitions).where(eq(revenueRecognitions.engagementId, engagementId)).orderBy(revenueRecognitions.periodEnd);
  const total = rows.filter((r) => r.status === "posted").reduce((a, r) => a.plus(d(r.amount)), new Decimal(0));
  return { rows, total: total.toFixed(2) };
}

export function assertMethod(m: string) {
  if (!["straight_line", "milestone", "time_and_materials", "percent_complete", "on_completion"].includes(m)) throw new ValidationError("Unknown recognition method.");
}

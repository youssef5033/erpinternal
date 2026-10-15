import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { bankAccounts, billingScheduleItems, bills, expenses, forecastAdjustments, forecastScenarios, invoices, opportunities, pipelineStages } from "@/db/schema";
import { addDaysISO, addMonthsISO, weekStartISO } from "@/lib/dates";
import { d, Decimal } from "@/lib/money";
import { getSettings, agencyToday } from "../system/settings";
import { getRate } from "./ledger";
import { bankLedgerBalance } from "./bank";
import { outstandingSql } from "./invoices";
import { billOutstandingSql } from "./payables";

export type ForecastScenarioKey = "base" | "conservative" | "upside";

export type ForecastMovement = { week: string; kind: "actual_opening" | "receivable" | "billing" | "pipeline" | "payable" | "reimbursement" | "adjustment"; label: string; href: string | null; amount: string; currency: string; baseAmount: string; assumption: string | null };

/**
 * Thirteen-week cash forecast in base currency. Opening cash is ACTUAL (posted
 * bank balances); every other line is a FORECAST movement with its assumption
 * shown, never mixed with actual transactions.
 */
export async function cashForecast(tx: Tx, scenarioKey: ForecastScenarioKey = "base") {
  const s = await getSettings(tx);
  const base = s.baseCurrency;
  const today = await agencyToday(tx);
  const start = weekStartISO(today);
  const weeks = Array.from({ length: 13 }, (_, i) => addDaysISO(start, i * 7));
  const end = addDaysISO(weeks[12], 6);
  const [scenario] = await tx.select().from(forecastScenarios).where(eq(forecastScenarios.key, scenarioKey));
  const sc = scenario ?? { key: scenarioKey, name: scenarioKey, collectionDelayDays: 0, collectionRatePercent: 100, pipelineInclusionPercent: 0, expenseMultiplierPercent: 100, notes: null };
  const weekOf = (date: string) => {
    const w = weekStartISO(date < start ? start : date);
    return w > weeks[12] ? null : w;
  };
  const convert = async (amount: Decimal, currency: string) => (currency === base ? amount : amount.times(d((await getRate(tx, currency, base, today)).rate)));

  const movements: ForecastMovement[] = [];
  let opening = new Decimal(0);
  const openingDetail: { name: string; native: string; currency: string; base: string }[] = [];
  for (const b of await tx.select().from(bankAccounts).where(eq(bankAccounts.active, true))) {
    const bal = await bankLedgerBalance(tx, b.id, today);
    const inBase = await convert(d(bal.native), b.currency);
    opening = opening.plus(inBase);
    openingDetail.push({ name: b.name, native: bal.native, currency: b.currency, base: inBase.toFixed(2) });
  }

  // Receivables: outstanding issued invoices at due date + scenario delay × collection rate.
  const inv = await tx.select({ id: invoices.id, number: invoices.number, dueDate: invoices.dueDate, currency: invoices.currency, outstanding: outstandingSql }).from(invoices).where(eq(invoices.status, "issued"));
  for (const i of inv) {
    if (d(i.outstanding).lessThanOrEqualTo(0)) continue;
    const expected = addDaysISO(i.dueDate! < today ? today : i.dueDate!, sc.collectionDelayDays);
    const w = weekOf(expected);
    if (!w) continue;
    const amt = d(i.outstanding).times(sc.collectionRatePercent).div(100);
    movements.push({ week: w, kind: "receivable", label: `Collect ${i.number}`, href: `/finance/invoices/${i.id}`, amount: amt.toFixed(2), currency: i.currency, baseAmount: (await convert(amt, i.currency)).toFixed(2), assumption: `Due ${i.dueDate}; +${sc.collectionDelayDays}d delay; ${sc.collectionRatePercent}% collected` });
  }
  // Planned billing not yet invoiced: billed on planned date, collected after default terms.
  const bsi = await tx.select().from(billingScheduleItems).where(and(inArray(billingScheduleItems.status, ["planned", "draft"]), sql`${billingScheduleItems.invoiceId} is null`, sql`${billingScheduleItems.plannedDate} is not null`));
  for (const b of bsi) {
    const expected = addDaysISO(b.plannedDate!, s.defaultPaymentTermsDays + sc.collectionDelayDays);
    const w = weekOf(expected);
    if (!w || expected < today) continue;
    const amt = d(b.amount).times(sc.collectionRatePercent).div(100);
    movements.push({ week: w, kind: "billing", label: b.label, href: `/delivery/engagements/${b.engagementId}?tab=billing`, amount: amt.toFixed(2), currency: b.currency, baseAmount: (await convert(amt, b.currency)).toFixed(2), assumption: `Invoice ${b.plannedDate} + ${s.defaultPaymentTermsDays}d terms${b.status === "draft" ? " (draft schedule)" : ""}` });
  }
  // Pipeline (scenario-dependent): weighted value of open opportunities.
  if (sc.pipelineInclusionPercent > 0) {
    const opps = await tx.select({ o: opportunities, p: pipelineStages.probability }).from(opportunities).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).where(eq(opportunities.status, "open"));
    for (const { o, p } of opps) {
      if (!o.expectedCloseDate) continue;
      const expected = addDaysISO(o.expectedCloseDate, 30 + sc.collectionDelayDays);
      const w = weekOf(expected);
      if (!w || expected < today) continue;
      const prob = o.probabilityOverride ?? p;
      const amt = d(o.value).times(prob).div(100).times(sc.pipelineInclusionPercent).div(100);
      if (amt.isZero()) continue;
      movements.push({ week: w, kind: "pipeline", label: `${o.number} ${o.name}`, href: `/crm/opportunities/${o.id}`, amount: amt.toFixed(2), currency: o.currency, baseAmount: (await convert(amt, o.currency)).toFixed(2), assumption: `${prob}% probability × ${sc.pipelineInclusionPercent}% inclusion; first cash 30d after close` });
    }
  }
  // Payables: approved bills outstanding at due date.
  const bl = await tx.select({ id: bills.id, number: bills.number, dueDate: bills.dueDate, currency: bills.currency, outstanding: billOutstandingSql }).from(bills).where(eq(bills.status, "approved"));
  for (const b of bl) {
    if (d(b.outstanding).lessThanOrEqualTo(0)) continue;
    const w = weekOf(b.dueDate);
    if (!w) continue;
    const amt = d(b.outstanding).times(sc.expenseMultiplierPercent).div(100).negated();
    movements.push({ week: w, kind: "payable", label: `Pay ${b.number}`, href: `/finance/bills/${b.id}`, amount: amt.toFixed(2), currency: b.currency, baseAmount: (await convert(amt, b.currency)).toFixed(2), assumption: `Due ${b.dueDate}` });
  }
  const reimb = await tx.select().from(expenses).where(and(eq(expenses.status, "approved"), eq(expenses.paidFrom, "personal")));
  for (const e of reimb) {
    const amt = d(e.amount).plus(d(e.taxAmount)).negated();
    movements.push({ week: weeks[0], kind: "reimbursement", label: `Reimburse ${e.number}`, href: `/finance/expenses/${e.id}`, amount: amt.toFixed(2), currency: e.currency, baseAmount: (await convert(amt, e.currency)).toFixed(2), assumption: "Approved, reimbursed this week" });
  }
  // Manual assumptions (payroll, rent, taxes, owner draws...).
  const adj = await tx.select().from(forecastAdjustments).where(inArray(forecastAdjustments.scenarioKey, ["all", scenarioKey]));
  for (const a of adj) {
    const dates: string[] = [];
    if (a.recurring === "none") dates.push(a.weekStart);
    else for (let dt = a.weekStart; dt <= end; dt = a.recurring === "weekly" ? addDaysISO(dt, 7) : addMonthsISO(dt, 1)) dates.push(dt);
    for (const dt of dates) {
      const w = weekOf(dt);
      if (!w || dt < start) continue;
      let amt = d(a.amount).times(a.direction === "outflow" ? -1 : 1);
      if (a.direction === "outflow") amt = amt.times(sc.expenseMultiplierPercent).div(100);
      movements.push({ week: w, kind: "adjustment", label: a.description, href: "/finance/cash?tab=assumptions", amount: amt.toFixed(2), currency: a.currency, baseAmount: (await convert(amt, a.currency)).toFixed(2), assumption: `Manual assumption (${a.recurring})` });
    }
  }

  let running = opening;
  const threshold = s.minimumCashThreshold ? d(s.minimumCashThreshold) : null;
  const table = weeks.map((w) => {
    const ms = movements.filter((m) => m.week === w);
    const inflow = ms.filter((m) => d(m.baseAmount).isPositive()).reduce((a, m) => a.plus(d(m.baseAmount)), new Decimal(0));
    const outflow = ms.filter((m) => d(m.baseAmount).isNegative()).reduce((a, m) => a.plus(d(m.baseAmount)), new Decimal(0));
    const open = running;
    running = running.plus(inflow).plus(outflow);
    return { week: w, opening: open.toFixed(2), inflow: inflow.toFixed(2), outflow: outflow.toFixed(2), closing: running.toFixed(2), belowThreshold: threshold ? running.lessThan(threshold) : false };
  });
  const lowest = table.reduce((min, r) => (d(r.closing).lessThan(d(min.closing)) ? r : min), table[0]);
  return {
    scenario: sc,
    baseCurrency: base,
    rateDate: today,
    today,
    opening: opening.toFixed(2),
    openingDetail,
    weeks: table,
    movements,
    threshold: threshold?.toFixed(2) ?? null,
    lowest,
    basis: `Opening cash is the actual posted bank balance at ${today}. All other figures are forecasts using the "${sc.name}" scenario assumptions. Foreign currencies converted to ${base} at the latest rate on or before ${today}.`,
  };
}

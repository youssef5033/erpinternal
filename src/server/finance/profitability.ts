import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accounts, engagements, journalEntries, journalLines, ledgerAccounts, offers, services, timeEntries } from "@/db/schema";
import { d, Decimal } from "@/lib/money";
import { getSettings } from "../system/settings";
import { getRate } from "./ledger";

/**
 * Management profitability (base currency). Definitions (docs/DEFINITIONS.md):
 *  - Recognised revenue: posted revenue lines tagged to the engagement.
 *  - Labour cost: approved time × the internal cost rate snapshotted at approval
 *    (historical; later rate changes do not alter it). Management figure — salaries
 *    are booked to overhead in the general ledger.
 *  - Contractor costs: approved supplier bills on direct-cost accounts tagged to the engagement.
 *  - Other direct costs: approved expenses / other postings on direct-cost accounts.
 *  - Gross margin = recognised revenue − labour − contractor − other direct costs.
 *  - Overhead is NOT allocated to engagements (contribution margin). See docs.
 */
export type EngagementProfit = {
  engagementId: string;
  number: string;
  name: string;
  accountId: string;
  accountName: string;
  serviceId: string;
  serviceName: string;
  offerId: string | null;
  offerName: string | null;
  currency: string;
  contractValue: string;
  billingModel: string;
  status: string;
  revenue: string;
  invoicedNet: string;
  laborCost: string;
  contractorCost: string;
  otherDirectCost: string;
  directCost: string;
  grossMargin: string;
  marginPct: string | null;
  approvedHours: string;
  budgetHours: string | null;
  budgetCost: string | null;
  hoursUsedPct: string | null;
  costUsedPct: string | null;
  overBudget: boolean;
  missingCostRateHours: string;
};

export async function engagementProfitability(tx: Tx, opts: { engagementIds?: string[]; from?: string; to?: string; where?: SQL } = {}): Promise<{ baseCurrency: string; rows: EngagementProfit[] }> {
  const s = await getSettings(tx);
  const base = s.baseCurrency;
  const engs = await tx
    .select({ e: engagements, accountName: accounts.name, serviceName: services.name, offerName: offers.name })
    .from(engagements)
    .innerJoin(accounts, eq(accounts.id, engagements.accountId))
    .innerJoin(services, eq(services.id, engagements.serviceId))
    .leftJoin(offers, eq(offers.id, engagements.offerId))
    .where(and(opts.engagementIds ? inArray(engagements.id, opts.engagementIds.length ? opts.engagementIds : ["00000000-0000-0000-0000-000000000000"]) : undefined, opts.where));
  if (!engs.length) return { baseCurrency: base, rows: [] };
  const ids = engs.map((x) => x.e.id);
  const dateConds = [opts.from ? gte(journalEntries.entryDate, opts.from) : undefined, opts.to ? lte(journalEntries.entryDate, opts.to) : undefined];

  const ledgerRows = await tx
    .select({
      engagementId: journalLines.engagementId,
      subtype: ledgerAccounts.subtype,
      type: ledgerAccounts.type,
      isDirect: ledgerAccounts.isDirectCost,
      sourceType: journalEntries.sourceType,
      fromSupplier: sql<boolean>`(${journalLines.supplierId} is not null)`,
      dr: sql<string>`sum(${journalLines.debit})`,
      cr: sql<string>`sum(${journalLines.credit})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.ledgerAccountId))
    .where(and(inArray(journalLines.engagementId, ids), ...dateConds))
    .groupBy(journalLines.engagementId, ledgerAccounts.subtype, ledgerAccounts.type, ledgerAccounts.isDirectCost, journalEntries.sourceType, sql`(${journalLines.supplierId} is not null)`);

  const timeRows = await tx
    .select({ engagementId: timeEntries.engagementId, workDate: timeEntries.workDate, hours: timeEntries.hours, costAmount: timeEntries.costAmount, costCurrency: timeEntries.costCurrency })
    .from(timeEntries)
    .where(and(inArray(timeEntries.engagementId, ids), eq(timeEntries.status, "approved"), opts.from ? gte(timeEntries.workDate, opts.from) : undefined, opts.to ? lte(timeEntries.workDate, opts.to) : undefined));

  const invoicedRows = await tx.execute<{ engagement_id: string; net: string }>(sql`
    select i.engagement_id, sum((i.subtotal - i.discount_total) * i.exchange_rate)
      - coalesce(sum((select sum(cn.subtotal * cn.exchange_rate) from credit_notes cn where cn.invoice_id = i.id and cn.status = 'issued')),0) as net
    from invoices i where i.status = 'issued' and i.engagement_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
    ${opts.from ? sql`and i.issue_date >= ${opts.from}` : sql``} ${opts.to ? sql`and i.issue_date <= ${opts.to}` : sql``}
    group by i.engagement_id`);

  const rateCache = new Map<string, string>();
  async function conv(amount: string, currency: string | null, date: string) {
    if (!currency || currency === base) return d(amount);
    const key = `${currency}|${date.slice(0, 7)}`;
    let rate = rateCache.get(key);
    if (!rate) {
      rate = (await getRate(tx, currency, base, date)).rate;
      rateCache.set(key, rate);
    }
    return d(amount).times(d(rate));
  }

  const rows: EngagementProfit[] = [];
  for (const { e, accountName, serviceName, offerName } of engs) {
    const lr = ledgerRows.filter((r) => r.engagementId === e.id);
    const revenue = lr.filter((r) => r.type === "income" && r.subtype === "revenue").reduce((a, r) => a.plus(d(r.cr)).minus(d(r.dr)), new Decimal(0));
    const direct = lr.filter((r) => r.type === "expense" && r.isDirect);
    // Supplier bill lines (and their reversals) carry the supplier id.
    const contractor = direct.filter((r) => r.fromSupplier).reduce((a, r) => a.plus(d(r.dr)).minus(d(r.cr)), new Decimal(0));
    const allDirect = direct.reduce((a, r) => a.plus(d(r.dr)).minus(d(r.cr)), new Decimal(0));
    const other = allDirect.minus(contractor);
    const tr = timeRows.filter((t) => t.engagementId === e.id);
    let labor = new Decimal(0);
    let missing = new Decimal(0);
    let hours = new Decimal(0);
    for (const t of tr) {
      hours = hours.plus(d(t.hours));
      if (t.costAmount === null) missing = missing.plus(d(t.hours));
      else labor = labor.plus(await conv(t.costAmount, t.costCurrency, t.workDate));
    }
    const directTotal = labor.plus(allDirect);
    const margin = revenue.minus(directTotal);
    const inv = invoicedRows.rows.find((r) => r.engagement_id === e.id);
    const hoursPct = e.budgetHours && !d(e.budgetHours).isZero() ? hours.div(d(e.budgetHours)).times(100) : null;
    const budgetCostBase = e.budgetCost ? await conv(e.budgetCost, e.currency, e.startDate ?? new Date().toISOString().slice(0, 10)) : null;
    const costPct = budgetCostBase && !budgetCostBase.isZero() ? directTotal.div(budgetCostBase).times(100) : null;
    rows.push({
      engagementId: e.id,
      number: e.number,
      name: e.name,
      accountId: e.accountId,
      accountName,
      serviceId: e.serviceId,
      serviceName,
      offerId: e.offerId,
      offerName: offerName ?? null,
      currency: e.currency,
      contractValue: e.contractValue,
      billingModel: e.billingModel,
      status: e.status,
      revenue: revenue.toFixed(2),
      invoicedNet: d(inv?.net).toFixed(2),
      laborCost: labor.toFixed(2),
      contractorCost: contractor.toFixed(2),
      otherDirectCost: other.toFixed(2),
      directCost: directTotal.toFixed(2),
      grossMargin: margin.toFixed(2),
      marginPct: revenue.isZero() ? null : margin.div(revenue).times(100).toFixed(1),
      approvedHours: hours.toFixed(2),
      budgetHours: e.budgetHours,
      budgetCost: budgetCostBase ? budgetCostBase.toFixed(2) : null,
      hoursUsedPct: hoursPct ? hoursPct.toFixed(1) : null,
      costUsedPct: costPct ? costPct.toFixed(1) : null,
      overBudget: (hoursPct?.greaterThan(100) ?? false) || (costPct?.greaterThan(100) ?? false),
      missingCostRateHours: missing.toFixed(2),
    });
  }
  return { baseCurrency: base, rows };
}

/** Roll engagement profitability up by a key (client, service or offer). */
export function rollUp(rows: EngagementProfit[], key: "accountId" | "serviceId" | "offerId") {
  const nameKey = key === "accountId" ? "accountName" : key === "serviceId" ? "serviceName" : "offerName";
  const map = new Map<string, { id: string; name: string; revenue: Decimal; directCost: Decimal; laborCost: Decimal; contractorCost: Decimal; otherDirectCost: Decimal; invoicedNet: Decimal; engagements: number }>();
  for (const r of rows) {
    const id = (r[key] as string | null) ?? "none";
    const name = (r[nameKey] as string | null) ?? "No offer";
    const g = map.get(id) ?? { id, name, revenue: new Decimal(0), directCost: new Decimal(0), laborCost: new Decimal(0), contractorCost: new Decimal(0), otherDirectCost: new Decimal(0), invoicedNet: new Decimal(0), engagements: 0 };
    g.revenue = g.revenue.plus(d(r.revenue));
    g.directCost = g.directCost.plus(d(r.directCost));
    g.laborCost = g.laborCost.plus(d(r.laborCost));
    g.contractorCost = g.contractorCost.plus(d(r.contractorCost));
    g.otherDirectCost = g.otherDirectCost.plus(d(r.otherDirectCost));
    g.invoicedNet = g.invoicedNet.plus(d(r.invoicedNet));
    g.engagements++;
    map.set(id, g);
  }
  return Array.from(map.values())
    .map((g) => ({
      id: g.id,
      name: g.name,
      engagements: g.engagements,
      revenue: g.revenue.toFixed(2),
      invoicedNet: g.invoicedNet.toFixed(2),
      laborCost: g.laborCost.toFixed(2),
      contractorCost: g.contractorCost.toFixed(2),
      otherDirectCost: g.otherDirectCost.toFixed(2),
      directCost: g.directCost.toFixed(2),
      grossMargin: g.revenue.minus(g.directCost).toFixed(2),
      marginPct: g.revenue.isZero() ? null : g.revenue.minus(g.directCost).div(g.revenue).times(100).toFixed(1),
    }))
    .sort((a, b) => d(b.revenue).comparedTo(d(a.revenue)));
}

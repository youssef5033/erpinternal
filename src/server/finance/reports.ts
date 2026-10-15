import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accounts, bankAccounts, bills, budgetLines, invoices, journalEntries, journalLines, ledgerAccounts, suppliers, type LedgerType } from "@/db/schema";
import { daysBetween } from "@/lib/dates";
import { d, Decimal, toMoney } from "@/lib/money";
import { getSettings } from "../system/settings";
import { outstandingSql } from "./invoices";
import { billOutstandingSql } from "./payables";

/**
 * All statements are computed from POSTED journal lines in base currency.
 * Draft documents never appear. Each report returns its basis so the UI can
 * explain the calculation, date range and currency.
 */

type Ledger = typeof ledgerAccounts.$inferSelect;
export type AccountLine = { account: Ledger; amount: string };

async function balancesBy(tx: Tx, from: string | null, to: string) {
  const rows = await tx
    .select({
      ledgerAccountId: journalLines.ledgerAccountId,
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(lte(journalEntries.entryDate, to), from ? gte(journalEntries.entryDate, from) : undefined))
    .groupBy(journalLines.ledgerAccountId);
  return new Map(rows.map((r) => [r.ledgerAccountId, d(r.debit).minus(d(r.credit))]));
}

/** Natural sign: assets/expenses are debit-positive; liabilities/equity/income credit-positive. */
function natural(type: LedgerType, debitMinusCredit: Decimal) {
  return type === "asset" || type === "expense" ? debitMinusCredit : debitMinusCredit.negated();
}

export async function trialBalance(tx: Tx, asOf: string) {
  const s = await getSettings(tx);
  const accs = await tx.select().from(ledgerAccounts).orderBy(asc(ledgerAccounts.code));
  const rows = await tx
    .select({ ledgerAccountId: journalLines.ledgerAccountId, debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`, credit: sql<string>`coalesce(sum(${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(lte(journalEntries.entryDate, asOf))
    .groupBy(journalLines.ledgerAccountId);
  const lines = accs
    .map((a) => {
      const r = rows.find((x) => x.ledgerAccountId === a.id);
      const net = d(r?.debit).minus(d(r?.credit));
      return { account: a, debit: net.isPositive() ? net.toFixed(2) : "0.00", credit: net.isNegative() ? net.abs().toFixed(2) : "0.00" };
    })
    .filter((l) => l.debit !== "0.00" || l.credit !== "0.00");
  const totalDebit = lines.reduce((a, l) => a.plus(d(l.debit)), new Decimal(0));
  const totalCredit = lines.reduce((a, l) => a.plus(d(l.credit)), new Decimal(0));
  return { asOf, currency: s.baseCurrency, lines, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), balanced: totalDebit.equals(totalCredit) };
}

export async function profitAndLoss(tx: Tx, from: string, to: string) {
  const s = await getSettings(tx);
  const accs = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.type, ["income", "expense"])).orderBy(asc(ledgerAccounts.code));
  const bal = await balancesBy(tx, from, to);
  const pick = (filter: (a: Ledger) => boolean) =>
    accs.filter(filter).map((a) => ({ account: a, amount: natural(a.type, bal.get(a.id) ?? new Decimal(0)).toFixed(2) })).filter((l) => l.amount !== "0.00");
  const revenue = pick((a) => a.type === "income" && a.subtype === "revenue");
  const otherIncome = pick((a) => a.type === "income" && a.subtype !== "revenue");
  const directCosts = pick((a) => a.type === "expense" && a.isDirectCost);
  const overhead = pick((a) => a.type === "expense" && !a.isDirectCost);
  const t = (ls: AccountLine[]) => ls.reduce((acc, l) => acc.plus(d(l.amount)), new Decimal(0));
  const totalRevenue = t(revenue);
  const grossProfit = totalRevenue.minus(t(directCosts));
  const netProfit = grossProfit.plus(t(otherIncome)).minus(t(overhead));
  return {
    from,
    to,
    currency: s.baseCurrency,
    basis: "Accrual basis: recognised revenue and approved costs from posted journal entries dated within the period. Invoices credit deferred revenue until earned.",
    revenue,
    directCosts,
    otherIncome,
    overhead,
    totalRevenue: totalRevenue.toFixed(2),
    totalDirectCosts: t(directCosts).toFixed(2),
    grossProfit: grossProfit.toFixed(2),
    grossMarginPct: totalRevenue.isZero() ? null : grossProfit.div(totalRevenue).times(100).toFixed(1),
    totalOtherIncome: t(otherIncome).toFixed(2),
    totalOverhead: t(overhead).toFixed(2),
    netProfit: netProfit.toFixed(2),
  };
}

export async function balanceSheet(tx: Tx, asOf: string) {
  const s = await getSettings(tx);
  const accs = await tx.select().from(ledgerAccounts).orderBy(asc(ledgerAccounts.code));
  const bal = await balancesBy(tx, null, asOf);
  const lines = (type: LedgerType) =>
    accs.filter((a) => a.type === type).map((a) => ({ account: a, amount: natural(type, bal.get(a.id) ?? new Decimal(0)).toFixed(2) })).filter((l) => l.amount !== "0.00");
  const assets = lines("asset");
  const liabilities = lines("liability");
  const equity = lines("equity");
  // Current earnings = all income − expenses to date not yet closed to retained earnings.
  const earnings = accs
    .filter((a) => a.type === "income" || a.type === "expense")
    .reduce((acc, a) => acc.plus((bal.get(a.id) ?? new Decimal(0)).negated()), new Decimal(0));
  const t = (ls: AccountLine[]) => ls.reduce((acc, l) => acc.plus(d(l.amount)), new Decimal(0));
  const totalAssets = t(assets);
  const totalLiabilities = t(liabilities);
  const totalEquity = t(equity).plus(earnings);
  return {
    asOf,
    currency: s.baseCurrency,
    basis: "Cumulative posted balances to the date. Current-period earnings are shown within equity (no year-end close entry is required). A debit balance on Deferred revenue represents unbilled revenue.",
    assets,
    liabilities,
    equity,
    currentEarnings: earnings.toFixed(2),
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    totalEquity: totalEquity.toFixed(2),
    balanced: totalAssets.equals(totalLiabilities.plus(totalEquity)),
  };
}

/**
 * Cash flow statement (direct method): every posted movement on bank/cash
 * ledger accounts, classified by its source document. Transfers between own
 * accounts net to zero and are excluded.
 */
export async function cashFlowStatement(tx: Tx, from: string, to: string) {
  const s = await getSettings(tx);
  const bankLedgerIds = (await tx.select({ id: bankAccounts.ledgerAccountId }).from(bankAccounts)).map((b) => b.id);
  if (!bankLedgerIds.length) return { from, to, currency: s.baseCurrency, sections: [], opening: "0.00", closing: "0.00", netChange: "0.00", basis: "No bank accounts configured." };
  const rows = await tx
    .select({ sourceType: journalEntries.sourceType, entryId: journalEntries.id, amount: sql<string>`sum(${journalLines.debit} - ${journalLines.credit})` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(inArray(journalLines.ledgerAccountId, bankLedgerIds), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .groupBy(journalEntries.sourceType, journalEntries.id);
  // Reversals: classify by the source of the reversed entry.
  const reversalIds = rows.filter((r) => r.sourceType === "reversal").map((r) => r.entryId);
  const reversalSources = new Map<string, string>();
  if (reversalIds.length) {
    const revs = await tx.select({ id: journalEntries.id, of: journalEntries.reversalOfId }).from(journalEntries).where(inArray(journalEntries.id, reversalIds));
    const origIds = revs.map((r) => r.of!).filter(Boolean);
    const origs = origIds.length ? await tx.select({ id: journalEntries.id, st: journalEntries.sourceType }).from(journalEntries).where(inArray(journalEntries.id, origIds)) : [];
    for (const r of revs) reversalSources.set(r.id, origs.find((o) => o.id === r.of)?.st ?? "manual");
  }
  const classify = (st: string): [string, string] => {
    switch (st) {
      case "customer_payment": return ["operating", "Receipts from customers"];
      case "supplier_payment": return ["operating", "Payments to suppliers and contractors"];
      case "expense": case "expense_reimbursement": return ["operating", "Expenses paid"];
      case "bank_transaction": return ["operating", "Other bank movements (fees, interest, categorised lines)"];
      case "bank_transfer": return ["transfers", "Transfers between own accounts"];
      case "opening_balance": return ["opening", "Opening balances"];
      default: return ["financing", "Manual journals (owner funding, loans, adjustments)"];
    }
  };
  const groups = new Map<string, { section: string; label: string; amount: Decimal }>();
  for (const r of rows) {
    const st = r.sourceType === "reversal" ? reversalSources.get(r.entryId) ?? "manual" : r.sourceType;
    const [section, label] = classify(st);
    if (section === "transfers" || section === "opening") continue;
    const k = `${section}|${label}`;
    const g = groups.get(k) ?? { section, label, amount: new Decimal(0) };
    g.amount = g.amount.plus(d(r.amount));
    groups.set(k, g);
  }
  const sectionOrder = ["operating", "investing", "financing"];
  const sections = sectionOrder.map((sec) => {
    const items = Array.from(groups.values()).filter((g) => g.section === sec);
    return { section: sec, items: items.map((i) => ({ label: i.label, amount: i.amount.toFixed(2) })), total: items.reduce((a, i) => a.plus(i.amount), new Decimal(0)).toFixed(2) };
  });
  const openingRows = await tx
    .select({ v: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(inArray(journalLines.ledgerAccountId, bankLedgerIds), sql`${journalEntries.entryDate} < ${from}`));
  const inPeriodOpening = rows.filter((r) => r.sourceType === "opening_balance").reduce((a, r) => a.plus(d(r.amount)), new Decimal(0));
  const opening = d(openingRows[0].v).plus(inPeriodOpening);
  const net = sections.reduce((a, s2) => a.plus(d(s2.total)), new Decimal(0));
  return {
    from,
    to,
    currency: s.baseCurrency,
    basis: "Direct method from posted movements on bank and cash ledger accounts (base currency). Opening balances posted within the period are included in the opening cash figure.",
    sections,
    opening: opening.toFixed(2),
    netChange: net.toFixed(2),
    closing: opening.plus(net).toFixed(2),
  };
}

export async function generalLedger(tx: Tx, ledgerAccountId: string, from: string, to: string) {
  const [acc] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, ledgerAccountId));
  const [{ opening }] = await tx
    .select({ opening: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.ledgerAccountId, ledgerAccountId), sql`${journalEntries.entryDate} < ${from}`));
  const lines = await tx
    .select({ line: journalLines, entry: journalEntries })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.ledgerAccountId, ledgerAccountId), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.number));
  let running = d(opening);
  const out = lines.map((l) => {
    running = running.plus(d(l.line.debit)).minus(d(l.line.credit));
    return { ...l, running: running.toFixed(2) };
  });
  return { account: acc, from, to, opening: toMoney(opening), closing: running.toFixed(2), lines: out };
}

const BUCKETS = [
  { key: "current", label: "Not yet due", min: -Infinity, max: 0 },
  { key: "1_30", label: "1–30 days", min: 1, max: 30 },
  { key: "31_60", label: "31–60 days", min: 31, max: 60 },
  { key: "61_90", label: "61–90 days", min: 61, max: 90 },
  { key: "90_plus", label: "90+ days", min: 91, max: Infinity },
];

function bucketOf(dueDate: string, asOf: string) {
  const days = daysBetween(dueDate, asOf);
  return BUCKETS.find((b) => days >= b.min && days <= b.max)!.key;
}

/** AR aging by customer, per currency (never mixed). Based on outstanding issued invoices. */
export async function receivablesAging(tx: Tx, asOf: string) {
  const rows = await tx
    .select({ id: invoices.id, number: invoices.number, dueDate: invoices.dueDate, currency: invoices.currency, accountId: invoices.accountId, accountName: accounts.name, outstanding: outstandingSql })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .where(and(eq(invoices.status, "issued"), lte(invoices.issueDate, asOf)));
  const open = rows.filter((r) => d(r.outstanding).greaterThan(0));
  return agingTable(open.map((r) => ({ id: r.id, ref: r.number!, partyId: r.accountId, party: r.accountName, currency: r.currency, dueDate: r.dueDate!, amount: toMoney(r.outstanding) })), asOf);
}

export async function payablesAging(tx: Tx, asOf: string) {
  const rows = await tx
    .select({ id: bills.id, number: bills.number, dueDate: bills.dueDate, currency: bills.currency, supplierId: bills.supplierId, supplierName: suppliers.name, outstanding: billOutstandingSql })
    .from(bills)
    .innerJoin(suppliers, eq(suppliers.id, bills.supplierId))
    .where(and(eq(bills.status, "approved"), lte(bills.billDate, asOf)));
  const open = rows.filter((r) => d(r.outstanding).greaterThan(0));
  return agingTable(open.map((r) => ({ id: r.id, ref: r.number, partyId: r.supplierId, party: r.supplierName, currency: r.currency, dueDate: r.dueDate, amount: toMoney(r.outstanding) })), asOf);
}

function agingTable(items: { id: string; ref: string; partyId: string; party: string; currency: string; dueDate: string; amount: string }[], asOf: string) {
  const byCurrency = new Map<string, Map<string, { party: string; partyId: string; buckets: Record<string, Decimal>; total: Decimal; items: typeof items }>>();
  for (const it of items) {
    const cur = byCurrency.get(it.currency) ?? new Map();
    const row = cur.get(it.partyId) ?? { party: it.party, partyId: it.partyId, buckets: Object.fromEntries(BUCKETS.map((b) => [b.key, new Decimal(0)])), total: new Decimal(0), items: [] };
    const b = bucketOf(it.dueDate, asOf);
    row.buckets[b] = row.buckets[b].plus(d(it.amount));
    row.total = row.total.plus(d(it.amount));
    row.items.push(it);
    cur.set(it.partyId, row);
    byCurrency.set(it.currency, cur);
  }
  return {
    asOf,
    buckets: BUCKETS.map((b) => ({ key: b.key, label: b.label })),
    currencies: Array.from(byCurrency.entries()).map(([currency, parties]) => {
      const rows = Array.from(parties.values()).sort((a, b) => b.total.comparedTo(a.total));
      const totals = Object.fromEntries(BUCKETS.map((b) => [b.key, rows.reduce((a, r) => a.plus(r.buckets[b.key]), new Decimal(0)).toFixed(2)]));
      return {
        currency,
        rows: rows.map((r) => ({ party: r.party, partyId: r.partyId, buckets: Object.fromEntries(Object.entries(r.buckets).map(([k, v]) => [k, v.toFixed(2)])), total: r.total.toFixed(2), items: r.items })),
        totals,
        total: rows.reduce((a, r) => a.plus(r.total), new Decimal(0)).toFixed(2),
      };
    }),
  };
}

/** Budget vs actual by ledger account for a fiscal year (base currency). */
export async function budgetVsActual(tx: Tx, fiscalYear: number) {
  const s = await getSettings(tx);
  const startMonth = s.fiscalYearStartMonth;
  const from = `${fiscalYear}-${String(startMonth).padStart(2, "0")}-01`;
  const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const to = new Date(Date.UTC(endYear, endMonth, 0)).toISOString().slice(0, 10);
  const budgets = await tx.select().from(budgetLines).where(eq(budgetLines.fiscalYear, fiscalYear));
  const accs = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.type, ["income", "expense"])).orderBy(asc(ledgerAccounts.code));
  const bal = await balancesBy(tx, from, to);
  const rows = accs
    .map((a) => {
      const budget = budgets.filter((b) => b.ledgerAccountId === a.id).reduce((acc, b) => acc.plus(d(b.amount)), new Decimal(0));
      const actual = natural(a.type, bal.get(a.id) ?? new Decimal(0));
      return { account: a, budget: budget.toFixed(2), actual: actual.toFixed(2), variance: actual.minus(budget).toFixed(2), variancePct: budget.isZero() ? null : actual.minus(budget).div(budget).times(100).toFixed(1) };
    })
    .filter((r) => r.budget !== "0.00" || r.actual !== "0.00");
  return { fiscalYear, from, to, currency: s.baseCurrency, rows, hasBudget: budgets.length > 0 };
}

/** Recognised revenue by service stream and by client from posted lines (base currency). */
export async function revenueByServiceAndClient(tx: Tx, from: string, to: string) {
  const s = await getSettings(tx);
  const rows = await tx
    .select({
      ledgerAccountId: journalLines.ledgerAccountId,
      accountId: journalLines.accountId,
      amount: sql<string>`sum(${journalLines.credit} - ${journalLines.debit})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.ledgerAccountId))
    .where(and(eq(ledgerAccounts.subtype, "revenue"), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .groupBy(journalLines.ledgerAccountId, journalLines.accountId);
  const accs = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.subtype, "revenue"));
  const clientIds = Array.from(new Set(rows.map((r) => r.accountId).filter(Boolean))) as string[];
  const clients = clientIds.length ? await tx.select({ id: accounts.id, name: accounts.name }).from(accounts).where(inArray(accounts.id, clientIds)) : [];
  const byService = accs.map((a) => ({ account: a, amount: rows.filter((r) => r.ledgerAccountId === a.id).reduce((x, r) => x.plus(d(r.amount)), new Decimal(0)).toFixed(2) }));
  const byClient = clients
    .map((c) => ({ id: c.id, name: c.name, amount: rows.filter((r) => r.accountId === c.id).reduce((x, r) => x.plus(d(r.amount)), new Decimal(0)).toFixed(2) }))
    .sort((a, b) => d(b.amount).comparedTo(d(a.amount)));
  const total = byService.reduce((x, r) => x.plus(d(r.amount)), new Decimal(0));
  return { from, to, currency: s.baseCurrency, byService, byClient, total: total.toFixed(2) };
}

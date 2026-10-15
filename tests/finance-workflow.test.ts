import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, makeActors, resetDb, type TestActors } from "./helpers/db";
import {
  accounts,
  bankTransactions,
  billingScheduleItems,
  engagements,
  invoices,
  journalEntries,
  journalLines,
  ledgerAccounts,
  milestones,
  organizationSettings,
  services,
  signals,
  timeEntries,
} from "@/db/schema";
import { createEngagement, createDeliverable, submitDeliverableVersion, recordDeliverableReview, createMilestone, acceptMilestone } from "@/server/delivery/engagements";
import { createInvoiceDraft, invoiceBalances, derivePaymentStatus, issueInvoice, voidInvoice, issueCreditNote } from "@/server/finance/invoices";
import { allocatePayment, paymentUnallocated, recordCustomerPayment, reverseAllocation, reverseCustomerPayment } from "@/server/finance/payments";
import { addExchangeRate, postJournal, reverseJournal, lockPeriod } from "@/server/finance/ledger";
import { createBankAccount, stageBankCsv, validateBankImport, commitBankImport, suggestMatches, matchBankTransaction, reconcileBankAccount, postTransactionToAccount, createExpenseFromTransaction } from "@/server/finance/bank";
import { approveBill, createBill, paySupplier, saveSupplier, submitExpense, approveExpense } from "@/server/finance/payables";
import { balanceSheet, profitAndLoss, receivablesAging, trialBalance, cashFlowStatement } from "@/server/finance/reports";
import { engagementProfitability } from "@/server/finance/profitability";
import { postRecognition } from "@/server/finance/revenue";
import { approveTimeEntries, logTime, setCostRate } from "@/server/delivery/time";
import { refreshSignals } from "@/server/ops/signals";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { SYSTEM_ACTOR } from "@/server/auth/actor";
import { expenseCategories } from "@/db/schema";

let A: TestActors;
let accountId: string;
let engId: string;
let bankId: string;
let invoiceId: string;

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function expectPg(p: Promise<unknown>, re: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { message: string; cause?: { message: string } });
  expect(err, "expected a database error").not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ""}`).toMatch(re);
}

async function sumJournals() {
  const r = await db.execute<{ d: string; c: string }>(sql`select coalesce(sum(debit),0) as d, coalesce(sum(credit),0) as c from journal_lines`);
  return r.rows[0];
}

beforeAll(async () => {
  await resetDb();
  A = await makeActors();
  const [svc] = await db.select().from(services).where(eq(services.key, "advisory"));
  const [acc] = await db.insert(accounts).values({ name: "Meridian Capital", normalizedName: "meridian capital", ownerId: A.account_manager.userId, lifecycleStatus: "active", billingEmail: "ap@meridian.example", billingAddress: "1 Bay St" }).returning();
  accountId = acc.id;
  const eng = await db.transaction((tx) =>
    createEngagement(tx, A.operations_manager, { name: "Finance model build", accountId, serviceId: svc.id, billingModel: "fixed", currency: "USD", contractValue: "20000", budgetHours: "100", budgetCost: "6000", startDate: "2026-09-01", ownerId: A.account_manager.userId }),
  );
  engId = eng.id;
  const bank = await db.transaction((tx) => createBankAccount(tx, A.finance, { name: "Operating", kind: "bank", currency: "USD", openingBalance: "50000", openingBalanceDate: "2026-01-01" }));
  bankId = bank.id;
});

describe("invoice → partial payment → allocation → balances → collection signals", () => {
  it("issues sequentially numbered invoices posting balanced journals to deferred revenue", async () => {
    const { invoice } = await db.transaction((tx) => createInvoiceDraft(tx, A.finance, { accountId, engagementId: engId, currency: "USD", paymentTermsDays: 14, lines: [{ description: "Model build — phase 1", quantity: "1", unitPrice: "10000" }] }));
    invoiceId = invoice.id;
    await expect(db.transaction((tx) => issueInvoice(tx, A.account_manager, invoice.id))).rejects.toThrow(ForbiddenError);
    const r = await db.transaction((tx) => issueInvoice(tx, A.finance, invoice.id, { issueDate: "2026-09-01" }));
    expect(r.number).toBe("INV-00001");
    await expect(db.transaction((tx) => issueInvoice(tx, A.finance, invoice.id))).rejects.toThrow(ConflictError);
    const lines = await db.select({ l: journalLines, la: ledgerAccounts }).from(journalLines).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.ledgerAccountId)).where(eq(journalLines.entryId, r.journalEntryId));
    expect(lines.find((x) => x.la.systemKey === "accounts_receivable")!.l.debit).toBe("10000.00");
    expect(lines.find((x) => x.la.systemKey === "deferred_revenue")!.l.credit).toBe("10000.00");
    expect(lines.some((x) => x.la.subtype === "revenue")).toBe(false); // invoicing ≠ earned revenue
    const { invoice: second } = await db.transaction((tx) => createInvoiceDraft(tx, A.finance, { accountId, currency: "USD", lines: [{ description: "Workshop", quantity: "2", unitPrice: "500", discountPercent: "10" }] }));
    const r2 = await db.transaction((tx) => issueInvoice(tx, A.finance, second.id, { issueDate: "2026-09-02" }));
    expect(r2.number).toBe("INV-00002");
    const [inv2] = await db.select().from(invoices).where(eq(invoices.id, second.id));
    expect(inv2.total).toBe("900.00");
    // issued invoices are immutable through the service
    const { updateInvoiceDraft } = await import("@/server/finance/invoices");
    await expect(db.transaction((tx) => updateInvoiceDraft(tx, A.finance, second.id, { accountId, currency: "USD", lines: [{ description: "x", quantity: "1", unitPrice: "1" }] }))).rejects.toThrow(/cannot be edited/);
  });

  it("derives status from allocations; handles partial payment, overpayment and reversal", async () => {
    const pay = await db.transaction((tx) => recordCustomerPayment(tx, A.finance, { accountId, paymentDate: "2026-09-20", amount: "4000", currency: "USD", method: "bank_transfer", bankAccountId: bankId, allocations: [{ invoiceId, amount: "4000" }] }));
    let [bal] = await db.transaction((tx) => invoiceBalances(tx, [invoiceId]));
    expect(bal.outstanding).toBe("6000.00");
    expect(derivePaymentStatus({ status: "issued", total: bal.total }, bal)).toBe("partially_paid");
    // Over-allocation is blocked
    await expect(db.transaction((tx) => allocatePayment(tx, A.finance, pay.id, invoiceId, "1"))).rejects.toThrow(/unallocated/);
    // Overpayment stays as unapplied customer credit
    const pay2 = await db.transaction((tx) => recordCustomerPayment(tx, A.finance, { accountId, paymentDate: "2026-10-01", amount: "7000", currency: "USD", method: "bank_transfer", bankAccountId: bankId }));
    await expect(db.transaction((tx) => allocatePayment(tx, A.finance, pay2.id, invoiceId, "6500"))).rejects.toThrow(/only has/);
    await db.transaction((tx) => allocatePayment(tx, A.finance, pay2.id, invoiceId, "6000"));
    [bal] = await db.transaction((tx) => invoiceBalances(tx, [invoiceId]));
    expect(bal.outstanding).toBe("0.00");
    expect(derivePaymentStatus({ status: "issued", total: bal.total }, bal)).toBe("paid");
    expect((await db.transaction((tx) => paymentUnallocated(tx, pay2.id))).unallocated).toBe("1000.00");
    // Reversing a payment restores the balance without corrupting history
    await db.transaction((tx) => reverseCustomerPayment(tx, A.finance, pay.id, "Bounced"));
    [bal] = await db.transaction((tx) => invoiceBalances(tx, [invoiceId]));
    expect(bal.outstanding).toBe("4000.00");
    // AR control account equals the subledger (sum of outstanding issued invoices)
    const tb = await db.transaction((tx) => trialBalance(tx, "2026-12-31"));
    const ar = tb.lines.find((l) => l.account.systemKey === "accounts_receivable")!;
    expect(ar.debit).toBe("4900.00"); // 4000 + 900
    const unapplied = tb.lines.find((l) => l.account.systemKey === "unapplied_cash")!;
    expect(unapplied.credit).toBe("1000.00");
    expect(tb.balanced).toBe(true);
  });

  it("raises an overdue collection signal and clears it when the balance is paid", async () => {
    await db.update(organizationSettings).set({ timeZone: "UTC" });
    let r = await db.transaction((tx) => refreshSignals(tx));
    const sig = () => db.select().from(signals).where(and(eq(signals.ruleKey, "invoice_overdue"), eq(signals.entityId, invoiceId)));
    let [s] = await sig();
    expect(s.status).toBe("active");
    expect(s.reason).toContain("partially paid");
    // Refreshing again does not duplicate
    r = await db.transaction((tx) => refreshSignals(tx));
    expect((await sig()).length).toBe(1);
    // Resolve the source: allocate the customer's remaining credit and a new payment
    const pay3 = await db.transaction((tx) => recordCustomerPayment(tx, A.finance, { accountId, paymentDate: "2026-10-05", amount: "3000", currency: "USD", method: "bank_transfer", bankAccountId: bankId }));
    const credit = (await db.execute<{ id: string }>(sql`select id from customer_payments where amount = 7000`)).rows[0].id;
    await db.transaction((tx) => allocatePayment(tx, A.finance, credit, invoiceId, "1000"));
    await db.transaction((tx) => allocatePayment(tx, A.finance, pay3.id, invoiceId, "3000"));
    r = await db.transaction((tx) => refreshSignals(tx));
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    [s] = await sig();
    expect(s.status).toBe("resolved");
    expect(s.resolution).toBe("source_resolved");
    expect(s.resolvedAt).not.toBeNull();
  });

  it("voids and credits only through linked reversals", async () => {
    const { invoice } = await db.transaction((tx) => createInvoiceDraft(tx, A.finance, { accountId, currency: "USD", lines: [{ description: "Extra", quantity: "1", unitPrice: "1000" }] }));
    await db.transaction((tx) => issueInvoice(tx, A.finance, invoice.id, { issueDate: "2026-10-02" }));
    await expect(db.transaction((tx) => issueCreditNote(tx, A.finance, invoice.id, { grossAmount: "1500", reason: "too much" }))).rejects.toThrow(/exceed/);
    const cn = await db.transaction((tx) => issueCreditNote(tx, A.finance, invoice.id, { grossAmount: "400", reason: "Goodwill" }));
    expect(cn.total).toBe("400.00");
    await expect(db.transaction((tx) => voidInvoice(tx, A.finance, invoice.id, "mistake"))).rejects.toThrow(/credit/);
    const [bal] = await db.transaction((tx) => invoiceBalances(tx, [invoice.id]));
    expect(bal.outstanding).toBe("600.00");
    const { invoice: inv4 } = await db.transaction((tx) => createInvoiceDraft(tx, A.finance, { accountId, currency: "USD", lines: [{ description: "Wrong", quantity: "1", unitPrice: "100" }] }));
    const issued = await db.transaction((tx) => issueInvoice(tx, A.finance, inv4.id, { issueDate: "2026-10-03" }));
    await db.transaction((tx) => voidInvoice(tx, A.finance, inv4.id, "Issued to wrong client"));
    const [orig] = await db.select().from(journalEntries).where(eq(journalEntries.id, issued.journalEntryId));
    expect(orig.reversedById).not.toBeNull();
  });
});

describe("ledger integrity", () => {
  it("every journal balances; posted entries cannot be edited or deleted", async () => {
    const t = await sumJournals();
    expect(t.d).toBe(t.c);
    const [line] = await db.select().from(journalLines).limit(1);
    await expectPg(db.execute(sql`update journal_lines set debit = debit + 1 where id = ${line.id}`), /immutable/);
    await expectPg(db.execute(sql`delete from journal_lines where id = ${line.id}`), /immutable/);
    const [entry] = await db.select().from(journalEntries).limit(1);
    await expectPg(db.execute(sql`update journal_entries set memo = 'x' where id = ${entry.id}`), /immutable/);
    await expectPg(db.execute(sql`delete from journal_entries where id = ${entry.id}`), /cannot be deleted/);
  });

  it("rejects unbalanced postings at the database level", async () => {
    await expectPg(
      db.transaction(async (tx) => {
        const [e] = await tx.insert(journalEntries).values({ number: "JE-X", entryDate: "2026-10-01", memo: "bad", sourceType: "manual", postingKey: "bad:1", baseCurrency: "USD" }).returning();
        const [la] = await tx.select().from(ledgerAccounts).limit(1);
        await tx.insert(journalLines).values([{ entryId: e.id, ledgerAccountId: la.id, debit: "10", credit: "0", txnCurrency: "USD", txnAmount: "10" }, { entryId: e.id, ledgerAccountId: la.id, debit: "0", credit: "9", txnCurrency: "USD", txnAmount: "-9" }]);
      }),
      /unbalanced/,
    );
  });

  it("is idempotent per posting key and respects period locks", async () => {
    const input = { entryDate: "2026-10-01", memo: "test", sourceType: "manual" as const, postingKey: "idem:1", currency: "USD", rate: "1", lines: [{ systemKey: "bank_fees", amount: "10" }, { systemKey: "opening_balance_equity", amount: "-10" }] };
    const a = await db.transaction((tx) => postJournal(tx, A.finance, input));
    const b = await db.transaction((tx) => postJournal(tx, A.finance, input));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    await db.transaction((tx) => lockPeriod(tx, A.finance, "2026-08-01", "2026-08-31", true));
    await expect(db.transaction((tx) => postJournal(tx, A.finance, { ...input, entryDate: "2026-08-15", postingKey: "idem:2" }))).rejects.toThrow(/locked/);
    const rev = await db.transaction((tx) => reverseJournal(tx, A.finance, a.entry.id, { entryDate: "2026-10-02", memo: "undo" }));
    expect(rev.reversalOfId).toBe(a.entry.id);
  });
});

describe("contractor bill → approve → pay → project profitability; historical cost", () => {
  it("reflects approved contractor costs and snapshotted labour cost in margin", async () => {
    const [contractorAcct] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.systemKey, "contractor_costs"));
    const sup = await db.transaction((tx) => saveSupplier(tx, A.finance, { name: "Lena Ortiz (modelling)", supplierType: "contractor", defaultCurrency: "USD", paymentTermsDays: 15 }));
    await expect(db.transaction((tx) => createBill(tx, A.operations_manager, { supplierId: sup.id, billDate: "2026-09-15", currency: "USD", lines: [] }))).rejects.toThrow(ForbiddenError);
    const bill = await db.transaction((tx) => createBill(tx, A.finance, { supplierId: sup.id, supplierReference: "LO-17", billDate: "2026-09-15", currency: "USD", lines: [{ description: "Model QA", amount: "3000", expenseLedgerAccountId: contractorAcct.id, engagementId: engId }] }));
    await expect(db.transaction((tx) => createBill(tx, A.finance, { supplierId: sup.id, supplierReference: "LO-17", billDate: "2026-09-15", currency: "USD", lines: [{ description: "dup", amount: "1", expenseLedgerAccountId: contractorAcct.id }] }))).rejects.toThrow(ConflictError);
    let prof = await db.transaction((tx) => engagementProfitability(tx, { engagementIds: [engId] }));
    expect(prof.rows[0].contractorCost).toBe("0.00"); // not approved yet
    await expect(db.transaction((tx) => approveBill(tx, A.finance, bill.id))).rejects.toThrow(/Separation of duties/);
    await db.transaction((tx) => approveBill(tx, A.owner, bill.id));
    prof = await db.transaction((tx) => engagementProfitability(tx, { engagementIds: [engId] }));
    expect(prof.rows[0].contractorCost).toBe("3000.00");
    const sp = await db.transaction((tx) => paySupplier(tx, A.finance, { supplierId: sup.id, paymentDate: "2026-09-30", bankAccountId: bankId, method: "bank_transfer", allocations: [{ billId: bill.id, amount: "3000" }] }));
    expect(sp.amount).toBe("3000.00");
    await expect(db.transaction((tx) => paySupplier(tx, A.finance, { supplierId: sup.id, paymentDate: "2026-09-30", bankAccountId: bankId, method: "bank_transfer", allocations: [{ billId: bill.id, amount: "1" }] }))).rejects.toThrow(/outstanding/);

    // Labour: cost rate 50 → approve 10h → cost 500. Changing the rate later doesn't change history.
    const personId = A.team_member.personId!;
    await db.transaction((tx) => setCostRate(tx, A.owner, personId, { effectiveFrom: "2026-01-01", hourlyCost: "50", currency: "USD" }));
    await expect(db.transaction((tx) => setCostRate(tx, A.sales, personId, { effectiveFrom: "2026-01-01", hourlyCost: "1", currency: "USD" }))).rejects.toThrow(ForbiddenError);
    await db.insert((await import("@/db/schema")).engagementMembers).values({ engagementId: engId, userId: A.team_member.userId }).onConflictDoNothing();
    const te = await db.transaction((tx) => logTime(tx, A.team_member, { workDate: "2026-09-10", hours: "10", engagementId: engId, description: "Build" }));
    await db.transaction((tx) => approveTimeEntries(tx, A.account_manager, [te.id]));
    prof = await db.transaction((tx) => engagementProfitability(tx, { engagementIds: [engId] }));
    expect(prof.rows[0].laborCost).toBe("500.00");
    await db.transaction((tx) => setCostRate(tx, A.owner, personId, { effectiveFrom: "2026-01-01", hourlyCost: "80", currency: "USD" }));
    await db.transaction((tx) => setCostRate(tx, A.owner, personId, { effectiveFrom: "2026-10-01", hourlyCost: "90", currency: "USD" }));
    prof = await db.transaction((tx) => engagementProfitability(tx, { engagementIds: [engId] }));
    expect(prof.rows[0].laborCost).toBe("500.00");
    const [snap] = await db.select().from(timeEntries).where(eq(timeEntries.id, te.id));
    expect(snap.costRate).toBe("50.00");
    // Recognise revenue (percent complete: 10/100 h → 10% of 20,000 = 2,000 by Sep month end)
    await db.transaction((tx) => postRecognition(tx, SYSTEM_ACTOR, engId, "2026-10-14"));
    await db.transaction((tx) => postRecognition(tx, SYSTEM_ACTOR, engId, "2026-10-14")); // idempotent
    prof = await db.transaction((tx) => engagementProfitability(tx, { engagementIds: [engId] }));
    expect(prof.rows[0].revenue).toBe("2000.00");
    expect(prof.rows[0].grossMargin).toBe("-1500.00"); // 2000 − 500 labour − 3000 contractor
    // Over budget? cost 3500 of 6000 (58%), hours 10 of 100 → not over
    expect(prof.rows[0].overBudget).toBe(false);
  });
});

describe("bank import → duplicates → match → reconcile", () => {
  it("imports, detects duplicates, matches without double counting and reconciles", async () => {
    const csv = ["Date,Description,Amount,Ref", "2026-10-05,MERIDIAN CAPITAL PAYMENT,3000.00,PAY", "2026-09-30,LENA ORTIZ,-3000.00,LO-17", "2026-10-06,Bank fee,-15.00,", "2026-10-07,Card - software,-120.00,"].join("\n");
    const batch = await db.transaction((tx) => stageBankCsv(tx, A.finance, { bankAccountId: bankId, fileName: "oct.csv", csv }));
    const v = await db.transaction((tx) => validateBankImport(tx, A.finance, batch.id, { date: "Date", description: "Description", amount: "Amount", reference: "Ref" }));
    expect(v.validRows).toBe(4);
    expect(await db.transaction((tx) => commitBankImport(tx, A.finance, batch.id))).toBe(4);
    // Re-importing the same statement detects all rows as duplicates
    const again = await db.transaction((tx) => stageBankCsv(tx, A.finance, { bankAccountId: bankId, fileName: "oct-again.csv", csv }));
    const v2 = await db.transaction((tx) => validateBankImport(tx, A.finance, again.id, { date: "Date", description: "Description", amount: "Amount", reference: "Ref" }));
    expect(v2.duplicateRows).toBe(4);
    expect(await db.transaction((tx) => commitBankImport(tx, A.finance, again.id))).toBe(0);

    const before = await sumJournals();
    const txns = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, bankId));
    const inflow = txns.find((t) => t.amount === "3000.00")!;
    const outflow = txns.find((t) => t.amount === "-3000.00")!;
    const s1 = await db.transaction((tx) => suggestMatches(tx, inflow.id));
    expect(s1[0].type).toBe("customer_payment");
    await db.transaction((tx) => matchBankTransaction(tx, A.finance, inflow.id, s1[0].type, s1[0].id));
    const s2 = await db.transaction((tx) => suggestMatches(tx, outflow.id));
    expect(s2[0].type).toBe("supplier_payment");
    await db.transaction((tx) => matchBankTransaction(tx, A.finance, outflow.id, s2[0].type, s2[0].id));
    // Matching posts nothing
    expect(await sumJournals()).toEqual(before);
    // A record cannot be matched twice
    const other = txns.find((t) => t.amount === "-15.00")!;
    await expect(db.transaction((tx) => matchBankTransaction(tx, A.finance, other.id, "supplier_payment", s2[0].id))).rejects.toThrow();
    const [fees] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.systemKey, "bank_fees"));
    await db.transaction((tx) => postTransactionToAccount(tx, A.finance, other.id, { ledgerAccountId: fees.id }));
    const [cat] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Software"));
    const sw = txns.find((t) => t.amount === "-120.00")!;
    await db.transaction((tx) => createExpenseFromTransaction(tx, A.finance, sw.id, { categoryId: cat.id }));
    // Statement balance = ledger? compute and reconcile.
    const rec = await db.transaction((tx) => reconcileBankAccount(tx, A.finance, { bankAccountId: bankId, statementDate: "2026-10-31", statementBalance: "0", complete: false }));
    const ledger = rec.ledgerBalance!;
    await expect(db.transaction((tx) => reconcileBankAccount(tx, A.finance, { bankAccountId: bankId, statementDate: "2026-10-31", statementBalance: "1", complete: true }))).rejects.toThrow(/differs/);
    const done = await db.transaction((tx) => reconcileBankAccount(tx, A.finance, { bankAccountId: bankId, statementDate: "2026-10-31", statementBalance: ledger, complete: true }));
    expect(done.difference).toBe("0.00");
    const reconciled = await db.select().from(bankTransactions).where(and(eq(bankTransactions.bankAccountId, bankId), eq(bankTransactions.status, "reconciled")));
    expect(reconciled).toHaveLength(4);
  });
});

describe("reports reconcile to posted entries", () => {
  it("balance sheet balances; P&L equals posted income − expense; aging equals AR control", async () => {
    const bs = await db.transaction((tx) => balanceSheet(tx, "2026-12-31"));
    expect(bs.balanced).toBe(true);
    const pl = await db.transaction((tx) => profitAndLoss(tx, "2026-01-01", "2026-12-31"));
    const r = await db.execute<{ net: string }>(sql`
      select coalesce(sum(case when la.type='income' then jl.credit - jl.debit else jl.credit - jl.debit end),0) as net
      from journal_lines jl join ledger_accounts la on la.id = jl.ledger_account_id join journal_entries je on je.id = jl.entry_id
      where la.type in ('income','expense') and je.entry_date between '2026-01-01' and '2026-12-31'`);
    expect(pl.netProfit).toBe(Number(r.rows[0].net).toFixed(2));
    expect(bs.currentEarnings).toBe(pl.netProfit);
    const aging = await db.transaction((tx) => receivablesAging(tx, "2026-12-31"));
    const tb = await db.transaction((tx) => trialBalance(tx, "2026-12-31"));
    const ar = tb.lines.find((l) => l.account.systemKey === "accounts_receivable")!;
    expect(aging.currencies.find((c) => c.currency === "USD")!.total).toBe(ar.debit);
    const cf = await db.transaction((tx) => cashFlowStatement(tx, "2026-01-01", "2026-12-31"));
    const bankBal = tb.lines.filter((l) => l.account.subtype === "bank").reduce((a, l) => a + Number(l.debit) - Number(l.credit), 0);
    expect(cf.closing).toBe(bankBal.toFixed(2));
  });
});

describe("multi-currency with historical rates", () => {
  it("requires explicit rates, stores the rate on the document and realises FX on settlement", async () => {
    const [eurBank] = [await db.transaction((tx) => createBankAccount(tx, A.finance, { name: "EUR account", kind: "bank", currency: "EUR" }))];
    const { invoice } = await db.transaction((tx) => createInvoiceDraft(tx, A.finance, { accountId, currency: "EUR", lines: [{ description: "EU workshop", quantity: "1", unitPrice: "1000" }] }));
    await expect(db.transaction((tx) => issueInvoice(tx, A.finance, invoice.id, { issueDate: "2026-10-01" }))).rejects.toThrow(/No EUR→USD exchange rate/);
    await db.transaction((tx) => addExchangeRate(tx, A.finance, { rateDate: "2026-09-30", fromCurrency: "EUR", toCurrency: "USD", rate: "1.10" }));
    await db.transaction((tx) => addExchangeRate(tx, A.finance, { rateDate: "2026-10-10", fromCurrency: "EUR", toCurrency: "USD", rate: "1.20" }));
    await expect(db.transaction((tx) => addExchangeRate(tx, A.finance, { rateDate: "2026-09-30", fromCurrency: "EUR", toCurrency: "USD", rate: "9" }))).rejects.toThrow(/not overwritten/);
    await db.transaction((tx) => issueInvoice(tx, A.finance, invoice.id, { issueDate: "2026-10-01" }));
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(Number(inv.exchangeRate)).toBe(1.1);
    await db.transaction((tx) => recordCustomerPayment(tx, A.finance, { accountId, paymentDate: "2026-10-12", amount: "1000", currency: "EUR", method: "bank_transfer", bankAccountId: eurBank.id, allocations: [{ invoiceId: invoice.id, amount: "1000" }] }));
    const [fx] = await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.systemKey, "fx_gain_loss"));
    const fxLines = await db.select().from(journalLines).where(eq(journalLines.ledgerAccountId, fx.id));
    const gain = fxLines.reduce((a, l) => a + Number(l.credit) - Number(l.debit), 0);
    expect(gain.toFixed(2)).toBe("100.00"); // 1000 × (1.20 − 1.10)
    const t = await sumJournals();
    expect(t.d).toBe(t.c);
  });
});

describe("expenses and thresholds", () => {
  it("flags spending over threshold and separates duties", async () => {
    await db.update(organizationSettings).set({ expenseApprovalThreshold: "500" });
    const [cat] = await db.select().from(expenseCategories).where(eq(expenseCategories.name, "Travel & meals"));
    const e = await db.transaction((tx) => submitExpense(tx, A.team_member, { expenseDate: "2026-10-03", description: "Client dinner", categoryId: cat.id, amount: "750", currency: "USD", paidFrom: "personal" }));
    expect(e.exceedsThreshold).toBe(true);
    await db.transaction((tx) => refreshSignals(tx));
    expect((await db.select().from(signals).where(and(eq(signals.ruleKey, "spend_over_threshold"), eq(signals.entityId, e.id)))).length).toBe(1);
    await expect(db.transaction((tx) => approveExpense(tx, A.team_member, e.id))).rejects.toThrow(ForbiddenError);
    await db.transaction((tx) => approveExpense(tx, A.finance, e.id));
    await db.transaction((tx) => refreshSignals(tx));
    const [s] = await db.select().from(signals).where(and(eq(signals.ruleKey, "spend_over_threshold"), eq(signals.entityId, e.id)));
    expect(s.status).toBe("resolved");
  });
});

describe("milestone billing and recognition", () => {
  it("bills and recognises a milestone only after deliverable approval and acceptance", async () => {
    const [svc] = await db.select().from(services).where(eq(services.key, "creative"));
    const eng = await db.transaction((tx) => createEngagement(tx, A.operations_manager, { name: "Campaign", accountId, serviceId: svc.id, billingModel: "milestone", currency: "USD", contractValue: "8000", startDate: "2026-09-01" }));
    const m = await db.transaction((tx) => createMilestone(tx, A.operations_manager, eng.id, { name: "Launch", billable: true, billingAmount: "8000", dueDate: "2026-10-01" }));
    await db.insert(billingScheduleItems).values({ engagementId: eng.id, label: "Launch", amount: "8000", currency: "USD", milestoneId: m.id, status: "draft", source: "manual" });
    const dl = await db.transaction((tx) => createDeliverable(tx, A.operations_manager, eng.id, { name: "Launch assets", milestoneId: m.id, includedRevisions: 1 }));
    await expect(db.transaction((tx) => acceptMilestone(tx, A.operations_manager, m.id, { acceptedAt: "2026-10-01", acceptanceEvidence: "email" }))).rejects.toThrow(/not yet approved/);
    await db.transaction((tx) => submitDeliverableVersion(tx, A.operations_manager, dl.id, { stage: "client", notes: "v1" }));
    await db.transaction((tx) => recordDeliverableReview(tx, A.operations_manager, dl.id, { decision: "approved", evidence: "Email from CMO 1 Oct" }));
    await db.transaction((tx) => acceptMilestone(tx, A.operations_manager, m.id, { acceptedAt: "2026-10-01", acceptanceEvidence: "Signed acceptance" }));
    const [item] = await db.select().from(billingScheduleItems).where(eq(billingScheduleItems.milestoneId, m.id));
    expect(item.status).toBe("planned");
    expect(await db.transaction((tx) => postRecognition(tx, SYSTEM_ACTOR, eng.id, "2026-10-14"))).toBe(1);
    const [ms] = await db.select().from(milestones).where(eq(milestones.id, m.id));
    expect(ms.status).toBe("accepted");
    const [e2] = await db.select().from(engagements).where(eq(engagements.id, eng.id));
    expect(e2.status).toBe("onboarding");
    await expect(Promise.reject(new ValidationError("x"))).rejects.toThrow();
  });
});

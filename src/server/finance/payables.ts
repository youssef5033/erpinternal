import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  bankAccounts,
  bankTransactions,
  billLines,
  bills,
  engagements,
  expenseCategories,
  expenses,
  ledgerAccounts,
  supplierPaymentAllocations,
  supplierPayments,
  suppliers,
  taxRates,
} from "@/db/schema";
import { addDaysISO } from "@/lib/dates";
import { d, sum, toMoney } from "@/lib/money";
import { assertCan, can, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { agencyToday, getSettings } from "../system/settings";
import { logActivity } from "../crm/activities";
import { getRate, ledgerAccountByKey, postJournal, reverseJournal } from "./ledger";

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export type SupplierInput = {
  name: string;
  supplierType: "contractor" | "vendor" | "freelancer" | "agency";
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  taxIdentifier?: string | null;
  paymentTermsDays?: number | null;
  defaultCurrency: string;
  defaultExpenseLedgerAccountId?: string | null;
  personId?: string | null;
  bankDetails?: string | null;
  notes?: string | null;
};

export async function saveSupplier(tx: Tx, actor: Actor, input: SupplierInput, id?: string) {
  assertCan(actor, "finance.write");
  if (!input.name.trim()) throw new ValidationError("Name is required.");
  const values = {
    name: input.name.trim(),
    supplierType: input.supplierType,
    contactName: input.contactName || null,
    email: input.email || null,
    phone: input.phone || null,
    website: input.website || null,
    taxIdentifier: input.taxIdentifier || null,
    paymentTermsDays: input.paymentTermsDays ?? 30,
    defaultCurrency: input.defaultCurrency.toUpperCase(),
    defaultExpenseLedgerAccountId: input.defaultExpenseLedgerAccountId || null,
    personId: input.personId || null,
    bankDetails: input.bankDetails || null,
    notes: input.notes || null,
  };
  const [row] = id ? await tx.update(suppliers).set(values).where(eq(suppliers.id, id)).returning() : await tx.insert(suppliers).values(values).returning();
  await audit(tx, actor, { action: id ? "supplier.updated" : "supplier.created", entityType: "supplier", entityId: row.id, summary: `${id ? "Updated" : "Created"} supplier ${row.name}` });
  return row;
}

/* ------------------------------------------------------------------ */
/* Bills                                                               */
/* ------------------------------------------------------------------ */

export type BillLineInput = { description: string; amount: string; taxRateId?: string | null; expenseLedgerAccountId: string; engagementId?: string | null; projectId?: string | null };
export type BillInput = {
  supplierId: string;
  supplierReference?: string | null;
  billDate: string;
  dueDate?: string | null;
  currency: string;
  description?: string | null;
  engagementId?: string | null;
  lines: BillLineInput[];
};

async function billLineRows(tx: Tx, billId: string, lines: BillLineInput[]) {
  if (!lines.length) throw new ValidationError("Add at least one line.");
  const rateIds = lines.map((l) => l.taxRateId).filter((x): x is string => !!x);
  const rates = rateIds.length ? await tx.select().from(taxRates).where(inArray(taxRates.id, rateIds)) : [];
  const accountIds = Array.from(new Set(lines.map((l) => l.expenseLedgerAccountId)));
  const accs = await tx.select().from(ledgerAccounts).where(inArray(ledgerAccounts.id, accountIds));
  return lines.map((l, i) => {
    if (!l.description.trim()) throw new ValidationError(`Line ${i + 1} needs a description.`);
    if (d(l.amount).lessThanOrEqualTo(0)) throw new ValidationError(`Line ${i + 1}: amount must be positive.`);
    const acc = accs.find((a) => a.id === l.expenseLedgerAccountId);
    if (!acc || !["expense", "asset"].includes(acc.type)) throw new ValidationError(`Line ${i + 1}: choose an expense or asset account.`);
    const rate = l.taxRateId ? rates.find((r) => r.id === l.taxRateId) : null;
    return {
      billId,
      description: l.description.trim(),
      amount: toMoney(l.amount),
      taxRateId: rate?.id ?? null,
      taxRatePercent: rate?.ratePercent ?? "0",
      taxAmount: toMoney(d(l.amount).times(d(rate?.ratePercent)).div(100)),
      expenseLedgerAccountId: acc.id,
      engagementId: l.engagementId || null,
      projectId: l.projectId || null,
      sortOrder: i,
    };
  });
}

export async function createBill(tx: Tx, actor: Actor, input: BillInput, submit = true) {
  assertCan(actor, "finance.write");
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
  if (!sup) throw new NotFoundError("Supplier");
  if (input.supplierReference) {
    const [dup] = await tx
      .select({ id: bills.id, number: bills.number })
      .from(bills)
      .where(and(eq(bills.supplierId, input.supplierId), eq(bills.supplierReference, input.supplierReference), sql`${bills.status} <> 'void'`));
    if (dup) throw new ConflictError(`${sup.name} invoice ${input.supplierReference} is already recorded as ${dup.number}.`);
  }
  const number = await nextNumber(tx, "bill");
  const [bill] = await tx
    .insert(bills)
    .values({
      number,
      supplierId: sup.id,
      supplierReference: input.supplierReference || null,
      billDate: input.billDate,
      dueDate: input.dueDate || addDaysISO(input.billDate, sup.paymentTermsDays),
      currency: input.currency.toUpperCase(),
      description: input.description || null,
      engagementId: input.engagementId || null,
      status: submit ? "awaiting_approval" : "draft",
      submittedBy: actor.userId || null,
    })
    .returning();
  const rows = await billLineRows(tx, bill.id, input.lines.map((l) => ({ ...l, engagementId: l.engagementId ?? input.engagementId ?? null })));
  await tx.insert(billLines).values(rows);
  const subtotal = sum(rows.map((r) => r.amount));
  const tax = sum(rows.map((r) => r.taxAmount));
  const [updated] = await tx.update(bills).set({ subtotal: toMoney(subtotal), taxTotal: toMoney(tax), total: toMoney(subtotal.plus(tax)) }).where(eq(bills.id, bill.id)).returning();
  await audit(tx, actor, { action: "bill.created", entityType: "bill", entityId: bill.id, summary: `${number} from ${sup.name}: ${updated.currency} ${updated.total}` });
  return updated;
}

/**
 * Approve a bill: posts Dr expense/direct-cost lines (+ input tax) / Cr AP.
 * Lines carry the engagement so contractor costs flow into project profitability.
 */
export async function approveBill(tx: Tx, actor: Actor, billId: string) {
  assertCan(actor, "finance.post");
  const [bill] = await tx.select().from(bills).where(eq(bills.id, billId)).for("update");
  if (!bill) throw new NotFoundError("Bill");
  if (bill.status === "approved") throw new ConflictError(`${bill.number} is already approved.`);
  if (bill.status !== "awaiting_approval" && bill.status !== "draft") throw new ValidationError(`A ${bill.status} bill cannot be approved.`);
  if (bill.submittedBy && bill.submittedBy === actor.userId && !can(actor, "users.manage")) {
    throw new ForbiddenError("Separation of duties: someone other than the submitter must approve this bill.");
  }
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, bill.supplierId));
  const lines = await tx.select().from(billLines).where(eq(billLines.billId, billId)).orderBy(asc(billLines.sortOrder));
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, bill.currency, settings.baseCurrency, bill.billDate);
  const tax = sum(lines.map((l) => l.taxAmount));
  const { entry } = await postJournal(tx, actor, {
    entryDate: bill.billDate,
    memo: `Bill ${bill.number} — ${sup.name}${bill.supplierReference ? ` (${bill.supplierReference})` : ""}`,
    sourceType: "bill",
    sourceId: bill.id,
    postingKey: `bill:${bill.id}:approve`,
    currency: bill.currency,
    rate,
    lines: [
      ...lines.map((l) => ({ ledgerAccountId: l.expenseLedgerAccountId, amount: l.amount, description: l.description, engagementId: l.engagementId, supplierId: sup.id })),
      ...(tax.isZero() ? [] : [{ systemKey: "input_tax", amount: tax.toString(), description: `Input tax ${bill.number}` }]),
      { systemKey: "accounts_payable", amount: d(bill.total).negated().toString(), supplierId: sup.id, description: `Payable ${bill.number}` },
    ],
  });
  await tx.update(bills).set({ status: "approved", approvedBy: actor.userId || null, approvedAt: new Date(), exchangeRate: rate, journalEntryId: entry.id }).where(eq(bills.id, billId));
  for (const engId of Array.from(new Set(lines.map((l) => l.engagementId).filter(Boolean)))) {
    const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engId!));
    if (eng) await logActivity(tx, actor, { type: "system", subject: `Supplier cost approved: ${bill.number} (${sup.name})`, engagementId: eng.id, accountId: eng.accountId, relatedType: "bill", relatedId: bill.id, source: "system" });
  }
  await audit(tx, actor, { action: "bill.approved", entityType: "bill", entityId: bill.id, summary: `Approved ${bill.number} (${bill.currency} ${bill.total})` });
}

export async function rejectBill(tx: Tx, actor: Actor, billId: string, reason: string) {
  assertCan(actor, "finance.post");
  const [bill] = await tx.select().from(bills).where(eq(bills.id, billId)).for("update");
  if (!bill) throw new NotFoundError("Bill");
  if (bill.status !== "awaiting_approval") throw new ValidationError("Only bills awaiting approval can be returned.");
  await tx.update(bills).set({ status: "draft" }).where(eq(bills.id, billId));
  await audit(tx, actor, { action: "bill.returned", entityType: "bill", entityId: billId, summary: `${bill.number} returned to draft: ${reason}` });
}

export async function voidBill(tx: Tx, actor: Actor, billId: string, reason: string) {
  assertCan(actor, "finance.post");
  const [bill] = await tx.select().from(bills).where(eq(bills.id, billId)).for("update");
  if (!bill) throw new NotFoundError("Bill");
  const paid = await billPaid(tx, billId);
  if (d(paid).greaterThan(0)) throw new ValidationError("Payments exist against this bill; reverse them first.");
  if (bill.journalEntryId) {
    await reverseJournal(tx, actor, bill.journalEntryId, { entryDate: await agencyToday(tx), memo: `Void bill ${bill.number}: ${reason}`, postingKey: `bill:${bill.id}:void` });
  }
  await tx.update(bills).set({ status: "void", voidReason: reason }).where(eq(bills.id, billId));
  await audit(tx, actor, { action: "bill.voided", entityType: "bill", entityId: billId, summary: `${bill.number} voided: ${reason}` });
}

export async function billPaid(tx: Tx, billId: string) {
  const [r] = await tx
    .select({ paid: sql<string>`coalesce(sum(${supplierPaymentAllocations.amount}),0)` })
    .from(supplierPaymentAllocations)
    .where(and(eq(supplierPaymentAllocations.billId, billId), isNull(supplierPaymentAllocations.reversedAt)));
  return toMoney(r?.paid ?? 0);
}

export const billOutstandingSql = sql<string>`(${bills.total} - coalesce((select sum(a.amount) from supplier_payment_allocations a where a.bill_id = ${bills.id} and a.reversed_at is null),0))`;

/**
 * Pay supplier bills. The payment must be fully allocated to approved bills
 * of the same supplier and currency. Posts Dr AP / Cr Bank.
 */
export async function paySupplier(tx: Tx, actor: Actor, input: { supplierId: string; paymentDate: string; bankAccountId: string; method: "bank_transfer" | "card" | "cash" | "cheque" | "other"; reference?: string | null; allocations: { billId: string; amount: string }[] }) {
  assertCan(actor, "finance.post");
  if (!input.allocations.length) throw new ValidationError("Choose at least one bill to pay.");
  const [sup] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
  if (!sup) throw new NotFoundError("Supplier");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId));
  if (!bank) throw new NotFoundError("Bank account");
  const billRows = await tx.select().from(bills).where(inArray(bills.id, input.allocations.map((a) => a.billId))).for("update");
  let currency: string | null = null;
  for (const a of input.allocations) {
    const b = billRows.find((x) => x.id === a.billId);
    if (!b) throw new NotFoundError("Bill");
    if (b.supplierId !== sup.id) throw new ValidationError(`${b.number} belongs to another supplier.`);
    if (b.status !== "approved") throw new ValidationError(`${b.number} is not approved.`);
    currency = currency ?? b.currency;
    if (b.currency !== currency) throw new ValidationError("Pay bills of one currency at a time.");
    const outstanding = d(b.total).minus(d(await billPaid(tx, b.id)));
    if (d(a.amount).lessThanOrEqualTo(0) || d(a.amount).greaterThan(outstanding)) throw new ValidationError(`${b.number}: amount must be between 0 and the outstanding ${b.currency} ${outstanding.toFixed(2)}.`);
  }
  if (bank.currency !== currency) throw new ValidationError(`${bank.name} holds ${bank.currency}; these bills are in ${currency}.`);
  const total = sum(input.allocations.map((a) => a.amount));
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, currency!, settings.baseCurrency, input.paymentDate);
  const number = await nextNumber(tx, "supplier_payment");
  const [pay] = await tx
    .insert(supplierPayments)
    .values({ number, supplierId: sup.id, paymentDate: input.paymentDate, amount: toMoney(total), currency: currency!, exchangeRate: rate, method: input.method, reference: input.reference || null, bankAccountId: bank.id, createdBy: actor.userId || null })
    .returning();
  await tx.insert(supplierPaymentAllocations).values(input.allocations.map((a) => ({ supplierPaymentId: pay.id, billId: a.billId, amount: toMoney(a.amount) })));
  // AP is relieved at each bill's booking rate; the difference is realised FX.
  const { entry } = await postJournal(tx, actor, {
    entryDate: input.paymentDate,
    memo: `Supplier payment ${number} — ${sup.name}`,
    sourceType: "supplier_payment",
    sourceId: pay.id,
    postingKey: `supplier_payment:${pay.id}`,
    currency: currency!,
    rate,
    lines: [
      ...input.allocations.map((a) => {
        const b = billRows.find((x) => x.id === a.billId)!;
        return { systemKey: "accounts_payable", amount: toMoney(a.amount), rate: b.exchangeRate, supplierId: sup.id, description: `Pays ${b.number}` };
      }),
      { ledgerAccountId: bank.ledgerAccountId, amount: total.negated().toString(), rate, supplierId: sup.id, description: `Paid ${number}` },
    ],
  });
  await tx.update(supplierPayments).set({ journalEntryId: entry.id }).where(eq(supplierPayments.id, pay.id));
  await audit(tx, actor, { action: "supplier_payment.recorded", entityType: "supplier_payment", entityId: pay.id, summary: `${number}: ${currency} ${pay.amount} to ${sup.name}` });
  return pay;
}

export async function reverseSupplierPayment(tx: Tx, actor: Actor, paymentId: string, reason: string) {
  assertCan(actor, "finance.post");
  const [pay] = await tx.select().from(supplierPayments).where(eq(supplierPayments.id, paymentId)).for("update");
  if (!pay) throw new NotFoundError("Supplier payment");
  if (pay.status === "reversed") throw new ConflictError("Already reversed.");
  await reverseJournal(tx, actor, pay.journalEntryId!, { entryDate: await agencyToday(tx), memo: `Reverse ${pay.number}: ${reason}`, postingKey: `supplier_payment:${pay.id}:reverse` });
  await tx.update(supplierPaymentAllocations).set({ reversedAt: new Date() }).where(eq(supplierPaymentAllocations.supplierPaymentId, paymentId));
  await tx.update(supplierPayments).set({ status: "reversed", reversedAt: new Date(), reversalReason: reason }).where(eq(supplierPayments.id, paymentId));
  await tx.update(bankTransactions).set({ status: "unreconciled", matchType: null, matchId: null }).where(and(eq(bankTransactions.matchType, "supplier_payment"), eq(bankTransactions.matchId, paymentId)));
  await audit(tx, actor, { action: "supplier_payment.reversed", entityType: "supplier_payment", entityId: paymentId, summary: `${pay.number} reversed: ${reason}` });
}

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export type ExpenseInput = {
  expenseDate: string;
  description: string;
  categoryId: string;
  amount: string;
  taxAmount?: string | null;
  currency: string;
  paidFrom: "company" | "personal";
  bankAccountId?: string | null;
  engagementId?: string | null;
  isDirectCost?: boolean;
  billableToClient?: boolean;
  supplierId?: string | null;
  personId?: string | null;
};

export async function submitExpense(tx: Tx, actor: Actor, input: ExpenseInput) {
  if (!can(actor, "expenses.submit") && !can(actor, "finance.write")) throw new ForbiddenError();
  if (!input.description.trim()) throw new ValidationError("Description is required.");
  if (d(input.amount).lessThanOrEqualTo(0)) throw new ValidationError("Amount must be positive.");
  if (input.paidFrom === "company" && !input.bankAccountId) throw new ValidationError("Choose the company account that paid.");
  const [cat] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, input.categoryId));
  if (!cat) throw new ValidationError("Choose a category.");
  const [acc] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, cat.ledgerAccountId));
  const settings = await getSettings(tx);
  const threshold = cat.approvalThreshold ?? settings.expenseApprovalThreshold;
  let exceeds = false;
  if (threshold) {
    const { rate } = await getRate(tx, input.currency.toUpperCase(), settings.baseCurrency, input.expenseDate);
    exceeds = d(input.amount).times(d(rate)).greaterThan(d(threshold));
  }
  const number = await nextNumber(tx, "expense");
  const [row] = await tx
    .insert(expenses)
    .values({
      number,
      submittedBy: actor.userId || null,
      personId: input.personId || actor.personId,
      supplierId: input.supplierId || null,
      expenseDate: input.expenseDate,
      description: input.description.trim(),
      categoryId: cat.id,
      amount: toMoney(input.amount),
      taxAmount: toMoney(input.taxAmount || "0"),
      currency: input.currency.toUpperCase(),
      paidFrom: input.paidFrom,
      bankAccountId: input.bankAccountId || null,
      engagementId: input.engagementId || null,
      isDirectCost: input.isDirectCost ?? (acc?.isDirectCost || !!input.engagementId),
      billableToClient: !!input.billableToClient,
      status: "submitted",
      exceedsThreshold: exceeds,
    })
    .returning();
  await audit(tx, actor, { action: "expense.submitted", entityType: "expense", entityId: row.id, summary: `${number}: ${row.currency} ${row.amount} — ${row.description}${exceeds ? " (over threshold)" : ""}` });
  return row;
}

/**
 * Approve an expense and post it:
 *  company-paid:  Dr expense (+ input tax) / Cr bank
 *  personal:      Dr expense (+ input tax) / Cr reimbursements payable
 */
export async function approveExpense(tx: Tx, actor: Actor, expenseId: string, opts: { bankOriginated?: boolean } = {}) {
  assertCan(actor, "finance.post");
  const [e] = await tx.select().from(expenses).where(eq(expenses.id, expenseId)).for("update");
  if (!e) throw new NotFoundError("Expense");
  if (e.status === "approved" || e.status === "reimbursed") throw new ConflictError("Already approved.");
  if (e.status !== "submitted") throw new ValidationError(`A ${e.status} expense cannot be approved.`);
  if (!opts.bankOriginated && e.submittedBy === actor.userId && !can(actor, "users.manage")) throw new ForbiddenError("You cannot approve your own expense.");
  const [cat] = await tx.select().from(expenseCategories).where(eq(expenseCategories.id, e.categoryId));
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, e.currency, settings.baseCurrency, e.expenseDate);
  let creditLine: { ledgerAccountId?: string; systemKey?: string };
  if (e.paidFrom === "company") {
    const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, e.bankAccountId!));
    if (bank.currency !== e.currency) throw new ValidationError(`${bank.name} holds ${bank.currency}.`);
    creditLine = { ledgerAccountId: bank.ledgerAccountId };
  } else {
    creditLine = { systemKey: "reimbursements_payable" };
  }
  const gross = d(e.amount).plus(d(e.taxAmount));
  const { entry } = await postJournal(tx, actor, {
    entryDate: e.expenseDate,
    memo: `Expense ${e.number}: ${e.description}`,
    sourceType: "expense",
    sourceId: e.id,
    postingKey: `expense:${e.id}:approve`,
    currency: e.currency,
    rate,
    lines: [
      { ledgerAccountId: cat.ledgerAccountId, amount: e.amount, engagementId: e.engagementId, description: e.description },
      ...(d(e.taxAmount).isZero() ? [] : [{ systemKey: "input_tax", amount: e.taxAmount, description: `Input tax ${e.number}` }]),
      { ...creditLine, amount: gross.negated().toString(), description: e.paidFrom === "company" ? "Paid by company" : "Owed to employee" },
    ],
  });
  await tx.update(expenses).set({ status: "approved", approverId: actor.userId || null, approvedAt: new Date(), exchangeRate: rate, journalEntryId: entry.id }).where(eq(expenses.id, e.id));
  await audit(tx, actor, { action: "expense.approved", entityType: "expense", entityId: e.id, summary: `Approved ${e.number}` });
}

export async function rejectExpense(tx: Tx, actor: Actor, expenseId: string, reason: string) {
  assertCan(actor, "finance.post");
  if (!reason.trim()) throw new ValidationError("A reason is required.");
  const [e] = await tx.select().from(expenses).where(eq(expenses.id, expenseId)).for("update");
  if (!e || e.status !== "submitted") throw new ValidationError("Only submitted expenses can be rejected.");
  await tx.update(expenses).set({ status: "rejected", rejectionReason: reason }).where(eq(expenses.id, expenseId));
  await audit(tx, actor, { action: "expense.rejected", entityType: "expense", entityId: expenseId, summary: `${e.number} rejected: ${reason}` });
}

/** Reimburse an approved personal expense: Dr reimbursements payable / Cr bank. */
export async function reimburseExpense(tx: Tx, actor: Actor, expenseId: string, input: { bankAccountId: string; date: string }) {
  assertCan(actor, "finance.post");
  const [e] = await tx.select().from(expenses).where(eq(expenses.id, expenseId)).for("update");
  if (!e) throw new NotFoundError("Expense");
  if (e.paidFrom !== "personal") throw new ValidationError("Only personally paid expenses are reimbursed.");
  if (e.status === "reimbursed") throw new ConflictError("Already reimbursed.");
  if (e.status !== "approved") throw new ValidationError("Approve the expense first.");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId));
  if (bank.currency !== e.currency) throw new ValidationError(`${bank.name} holds ${bank.currency}.`);
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, e.currency, settings.baseCurrency, input.date);
  const gross = d(e.amount).plus(d(e.taxAmount));
  const { entry } = await postJournal(tx, actor, {
    entryDate: input.date,
    memo: `Reimburse ${e.number}`,
    sourceType: "expense_reimbursement",
    sourceId: e.id,
    postingKey: `expense:${e.id}:reimburse`,
    currency: e.currency,
    rate,
    lines: [
      { systemKey: "reimbursements_payable", amount: gross.toString(), rate: e.exchangeRate, description: `Reimbursed ${e.number}` },
      { ledgerAccountId: bank.ledgerAccountId, amount: gross.negated().toString(), description: `Reimbursement ${e.number}` },
    ],
  });
  await tx.update(expenses).set({ status: "reimbursed", reimbursementJournalEntryId: entry.id, bankAccountId: bank.id }).where(eq(expenses.id, e.id));
  await audit(tx, actor, { action: "expense.reimbursed", entityType: "expense", entityId: e.id, summary: `Reimbursed ${e.number}` });
}

export async function ensureDefaultLedgerAccount(tx: Tx, key: string) {
  return ledgerAccountByKey(tx, key);
}

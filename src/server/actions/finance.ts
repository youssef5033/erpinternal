"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { f } from "@/lib/formdata";
import { budgetLines, forecastAdjustments, forecastScenarios, ledgerAccounts, taxRates } from "@/db/schema";
import { d, Decimal } from "@/lib/money";
import { runAction, type ActionState } from "./run";
import { audit } from "../audit";
import { assertCan } from "../auth/actor";
import { ValidationError } from "../errors";
import { approveBillingItem, createInvoiceDraft, deleteInvoiceDraft, invoiceFromBillingItem, issueCreditNote, issueInvoice, updateInvoiceDraft, voidInvoice } from "../finance/invoices";
import { allocatePayment, recordCustomerPayment, reverseAllocation, reverseCustomerPayment } from "../finance/payments";
import { approveBill, approveExpense, createBill, paySupplier, reimburseExpense, rejectBill, rejectExpense, reverseSupplierPayment, saveSupplier, submitExpense, voidBill } from "../finance/payables";
import {
  addBankTransaction,
  commitBankImport,
  createBankAccount,
  createExpenseFromTransaction,
  createPaymentFromTransaction,
  createTransfer,
  excludeBankTransaction,
  matchBankTransaction,
  postTransactionToAccount,
  reconcileBankAccount,
  stageBankCsv,
  unmatchBankTransaction,
  validateBankImport,
} from "../finance/bank";
import { addExchangeRate, lockPeriod, postManualJournal, reverseManualJournal } from "../finance/ledger";
import { runRecurringSchedules, saveRecurringSchedule, setRecurringStatus } from "../finance/recurring";
import { agencyToday, getSettings } from "../system/settings";

/* ---------------- Invoices ---------------- */

const lineSchema = z.object({ description: f.optStr(1000), quantity: f.optDecimal(), unitPrice: f.optMoney(), discountPercent: f.optDecimal(), taxRateId: f.optId(), serviceId: f.optId() });
const invoiceSchema = z.object({
  accountId: f.id(),
  engagementId: f.optId(),
  billingContactId: f.optId(),
  currency: f.currency(),
  paymentTermsDays: f.optInt(),
  reference: f.optStr(200),
  notes: f.text(),
  terms: f.text(),
  isDeposit: f.bool().optional(),
  revenueTreatment: f.enumOf(["deferred", "on_issue"] as const).optional(),
  lines: z.array(lineSchema).optional(),
});

function invoiceLines(lines: z.infer<typeof lineSchema>[] | undefined) {
  const out = (lines ?? []).filter((l) => l.description || l.unitPrice).map((l, i) => {
    if (!l.description) throw new ValidationError(`Line ${i + 1} needs a description.`);
    if (!l.unitPrice) throw new ValidationError(`Line ${i + 1} needs a unit price.`);
    return { description: l.description, quantity: l.quantity ?? "1", unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRateId: l.taxRateId, serviceId: l.serviceId };
  });
  if (!out.length) throw new ValidationError("Add at least one line.");
  return out;
}

export async function createInvoiceAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "invoice.create", schema: invoiceSchema, run: async ({ actor, tx, data }) => {
    const { invoice } = await createInvoiceDraft(tx, actor, { ...data, lines: invoiceLines(data.lines) });
    return { ref: invoice.id, redirectTo: `/finance/invoices/${invoice.id}` };
  } });
}

export async function updateInvoiceAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "invoice.update", schema: invoiceSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    const { id, ...input } = data;
    await updateInvoiceDraft(tx, actor, id, { ...input, lines: invoiceLines(input.lines) });
    return { ref: id, redirectTo: `/finance/invoices/${id}` };
  } });
}

export async function invoiceWorkflowAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: ["finance.write", "finance.post"],
    action: "invoice.workflow",
    schema: z.object({ id: f.id(), op: f.enumOf(["issue", "void", "delete"] as const), issueDate: f.optDate(), reason: f.optStr(1000) }),
    run: async ({ actor, tx, data }) => {
      if (data.op === "issue") {
        assertCan(actor, "finance.post");
        const inv = await issueInvoice(tx, actor, data.id, { issueDate: data.issueDate });
        return `Invoice ${inv.number} issued and posted to the ledger. It has not been emailed — download the PDF and send it yourself.`;
      }
      if (data.op === "void") {
        if (!data.reason) throw new ValidationError("Give a reason for voiding.", { reason: "Required" });
        await voidInvoice(tx, actor, data.id, data.reason);
        return "Invoice voided; its postings were reversed.";
      }
      await deleteInvoiceDraft(tx, actor, data.id);
      return { message: "Draft deleted.", redirectTo: "/finance/invoices" };
    },
  });
}

export async function creditNoteAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.post", action: "credit_note.issue", schema: z.object({ invoiceId: f.id(), grossAmount: f.money(), reason: f.str(1000), issueDate: f.optDate() }), run: async ({ actor, tx, data }) => {
    const cn = await issueCreditNote(tx, actor, data.invoiceId, data);
    return `Credit note ${cn.number} issued.`;
  } });
}

export async function billingItemAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "billing_item", schema: z.object({ id: f.id(), op: f.enumOf(["confirm", "invoice"] as const), plannedDate: f.optDate(), amount: f.optMoney() }), run: async ({ actor, tx, data }) => {
    if (data.op === "confirm") {
      await approveBillingItem(tx, actor, data.id, data);
      return "Billing item confirmed. A draft invoice is created on its planned date.";
    }
    const { invoice, created } = await invoiceFromBillingItem(tx, actor, data.id);
    return { message: created ? "Draft invoice created — review and issue it." : "This item already has an invoice.", redirectTo: `/finance/invoices/${invoice.id}` };
  } });
}

/* ---------------- Customer payments ---------------- */

export async function recordPaymentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "payment.record",
    schema: z.object({ accountId: f.id(), paymentDate: f.date(), amount: f.money(), currency: f.currency(), method: f.enumOf(["bank_transfer", "card", "cash", "cheque", "processor", "other"] as const), reference: f.optStr(200), bankAccountId: f.id(), evidenceNote: f.optStr(1000), allocations: z.array(z.object({ invoiceId: f.optId(), amount: f.optMoney() })).optional() }),
    run: async ({ actor, tx, data }) => {
      const allocations = (data.allocations ?? []).filter((a): a is { invoiceId: string; amount: string } => !!a.invoiceId && !!a.amount && Number(a.amount) > 0);
      const p = await recordCustomerPayment(tx, actor, { ...data, allocations });
      return { message: `Payment ${p.number} recorded.`, redirectTo: `/finance/collections?tab=payments` };
    },
  });
}

export async function allocatePaymentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "payment.allocate", schema: z.object({ paymentId: f.id(), invoiceId: f.id(), amount: f.money(), allocationDate: f.optDate() }), run: async ({ actor, tx, data }) => {
    await allocatePayment(tx, actor, data.paymentId, data.invoiceId, data.amount, data.allocationDate ?? undefined);
    return "Payment applied to the invoice.";
  } });
}

export async function reversePaymentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.post", action: "payment.reverse", schema: z.object({ id: f.id(), kind: f.enumOf(["payment", "allocation"] as const), reason: f.str(1000) }), run: async ({ actor, tx, data }) => {
    if (data.kind === "allocation") await reverseAllocation(tx, actor, data.id, data.reason);
    else await reverseCustomerPayment(tx, actor, data.id, data.reason);
    return "Reversed with an audit trail. The original entries are kept.";
  } });
}

/* ---------------- Suppliers, bills, expenses ---------------- */

export async function saveSupplierAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "supplier.save",
    schema: z.object({ id: f.optId(), name: f.str(300), supplierType: f.enumOf(["contractor", "vendor", "freelancer", "agency"] as const), contactName: f.optStr(200), email: f.optStr(300), phone: f.optStr(100), website: f.optStr(300), taxIdentifier: f.optStr(100), paymentTermsDays: f.optInt(), defaultCurrency: f.currency(), defaultExpenseLedgerAccountId: f.optId(), personId: f.optId(), bankDetails: f.optStr(2000), notes: f.text() }),
    run: async ({ actor, tx, data }) => {
      const { id, ...input } = data;
      const s = await saveSupplier(tx, actor, input, id ?? undefined);
      return { ref: s.id, redirectTo: `/finance/suppliers/${s.id}` };
    },
  });
}

export async function createBillAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "bill.create",
    schema: z.object({ supplierId: f.id(), supplierReference: f.optStr(200), billDate: f.date(), dueDate: f.optDate(), currency: f.currency(), description: f.text(), engagementId: f.optId(), submit: f.bool().optional(), lines: z.array(z.object({ description: f.optStr(1000), amount: f.optMoney(), taxRateId: f.optId(), expenseLedgerAccountId: f.optId(), engagementId: f.optId() })).optional() }),
    run: async ({ actor, tx, data }) => {
      const lines = (data.lines ?? []).filter((l) => l.description || l.amount).map((l, i) => {
        if (!l.description || !l.amount || !l.expenseLedgerAccountId) throw new ValidationError(`Line ${i + 1} needs a description, amount and expense account.`);
        return { description: l.description, amount: l.amount, taxRateId: l.taxRateId, expenseLedgerAccountId: l.expenseLedgerAccountId, engagementId: l.engagementId ?? data.engagementId };
      });
      const bill = await createBill(tx, actor, { ...data, lines }, data.submit ?? true);
      return { ref: bill.id, redirectTo: `/finance/bills/${bill.id}` };
    },
  });
}

export async function billWorkflowAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["finance.write", "finance.post"], action: "bill.workflow", schema: z.object({ id: f.id(), op: f.enumOf(["approve", "reject", "void"] as const), reason: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    if (data.op === "approve") {
      await approveBill(tx, actor, data.id);
      return "Bill approved and posted to accounts payable.";
    }
    if (!data.reason) throw new ValidationError("Give a reason.", { reason: "Required" });
    if (data.op === "reject") await rejectBill(tx, actor, data.id, data.reason);
    else await voidBill(tx, actor, data.id, data.reason);
    return `Bill ${data.op === "reject" ? "rejected" : "voided"}.`;
  } });
}

export async function paySupplierAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.post",
    action: "supplier.pay",
    schema: z.object({ supplierId: f.id(), paymentDate: f.date(), bankAccountId: f.id(), method: f.enumOf(["bank_transfer", "card", "cash", "cheque", "other"] as const), reference: f.optStr(200), allocations: z.array(z.object({ billId: f.optId(), amount: f.optMoney() })).optional() }),
    run: async ({ actor, tx, data }) => {
      const allocations = (data.allocations ?? []).filter((a): a is { billId: string; amount: string } => !!a.billId && !!a.amount && Number(a.amount) > 0);
      if (!allocations.length) throw new ValidationError("Enter an amount against at least one bill.");
      await paySupplier(tx, actor, { ...data, allocations });
      return "Supplier payment recorded (no money was moved — this records a payment you made).";
    },
  });
}

export async function reverseSupplierPaymentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.post", action: "supplier_payment.reverse", schema: z.object({ id: f.id(), reason: f.str(1000) }), run: async ({ actor, tx, data }) => {
    await reverseSupplierPayment(tx, actor, data.id, data.reason);
    return "Supplier payment reversed.";
  } });
}

export async function submitExpenseAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "expenses.submit",
    action: "expense.submit",
    schema: z.object({ expenseDate: f.date(), description: f.str(500), categoryId: f.id(), amount: f.money(), taxAmount: f.optMoney(), currency: f.currency(), paidFrom: f.enumOf(["company", "personal"] as const), bankAccountId: f.optId(), engagementId: f.optId(), isDirectCost: f.bool().optional(), billableToClient: f.bool().optional(), supplierId: f.optId() }),
    run: async ({ actor, tx, data }) => {
      const e = await submitExpense(tx, actor, data);
      return { ref: e.id, redirectTo: `/finance/bills/expenses/${e.id}` };
    },
  });
}

export async function expenseWorkflowAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["finance.post", "finance.write"], action: "expense.workflow", schema: z.object({ id: f.id(), op: f.enumOf(["approve", "reject", "reimburse"] as const), reason: f.optStr(1000), bankAccountId: f.optId(), date: f.optDate() }), run: async ({ actor, tx, data }) => {
    if (data.op === "approve") {
      await approveExpense(tx, actor, data.id);
      return "Expense approved and posted.";
    }
    if (data.op === "reject") {
      if (!data.reason) throw new ValidationError("Give a reason.", { reason: "Required" });
      await rejectExpense(tx, actor, data.id, data.reason);
      return "Expense returned to the submitter.";
    }
    if (!data.bankAccountId || !data.date) throw new ValidationError("Choose the bank account and reimbursement date.");
    await reimburseExpense(tx, actor, data.id, { bankAccountId: data.bankAccountId, date: data.date });
    return "Reimbursement recorded (no money was moved by this system).";
  } });
}

/* ---------------- Bank ---------------- */

export async function createBankAccountAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.admin", action: "bank_account.create", schema: z.object({ name: f.str(200), kind: f.enumOf(["bank", "cash", "card", "payment_processor"] as const), institution: f.optStr(200), accountNumberLast4: f.optStr(4), currency: f.currency(), openingBalance: f.optMoney(), openingBalanceDate: f.optDate() }), run: async ({ actor, tx, data }) => {
    const b = await createBankAccount(tx, actor, data);
    return { ref: b.id, redirectTo: `/finance/bank?account=${b.id}` };
  } });
}

export async function addBankTransactionAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "bank_txn.add", schema: z.object({ bankAccountId: f.id(), txnDate: f.date(), description: f.str(500), amount: f.money(), reference: f.optStr(200), counterparty: f.optStr(200) }), run: async ({ actor, tx, data }) => {
    await addBankTransaction(tx, actor, data);
    return "Statement line added.";
  } });
}

export async function stageBankImportAction(_p: ActionState, fd: FormData) {
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return { ok: false, message: "Choose a CSV file." };
  if (file.size > 5 * 1024 * 1024) return { ok: false, message: "The file is larger than 5 MB." };
  const csv = await file.text();
  return runAction(fd, { permission: "finance.write", action: "bank_import.stage", schema: z.object({ bankAccountId: f.id() }), run: async ({ actor, tx, data }) => {
    const batch = await stageBankCsv(tx, actor, { bankAccountId: data.bankAccountId, fileName: file.name, csv });
    return { ref: batch.id, redirectTo: `/finance/bank/import/${batch.id}` };
  } });
}

export async function validateBankImportAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "bank_import.validate",
    schema: z.object({ batchId: f.id(), date: f.str(200), description: f.str(200), amount: f.optStr(200), debit: f.optStr(200), credit: f.optStr(200), reference: f.optStr(200), counterparty: f.optStr(200), dateFormat: f.enumOf(["yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy"] as const) }),
    run: async ({ actor, tx, data }) => {
      const { batchId, ...m } = data;
      if (!m.amount && !(m.debit && m.credit)) throw new ValidationError("Map either a signed Amount column, or both Debit and Credit columns.");
      await validateBankImport(tx, actor, batchId, { ...m, amount: m.amount ?? undefined, debit: m.debit ?? undefined, credit: m.credit ?? undefined, reference: m.reference ?? undefined, counterparty: m.counterparty ?? undefined });
      return "Rows validated. Review the results, then import.";
    },
  });
}

export async function commitBankImportAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "bank_import.commit", schema: z.object({ batchId: f.id(), bankAccountId: f.id() }), run: async ({ actor, tx, data }) => {
    const r = await commitBankImport(tx, actor, data.batchId);
    return { message: `${r} statement line(s) imported. Duplicates were skipped.`, redirectTo: `/finance/bank?account=${data.bankAccountId}&status=unmatched` };
  } });
}

export async function bankMatchAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "bank_txn.match",
    schema: z.object({
      txnId: f.id(),
      op: f.enumOf(["match", "unmatch", "payment", "expense", "post", "exclude"] as const),
      matchType: f.enumOf(["customer_payment", "supplier_payment", "expense", "bank_transfer", "journal", "expense_reimbursement"] as const).optional(),
      matchId: f.optId(),
      accountId: f.optId(),
      invoiceId: f.optId(),
      allocationAmount: f.optMoney(),
      categoryId: f.optId(),
      engagementId: f.optId(),
      description: f.optStr(500),
      ledgerAccountId: f.optId(),
      memo: f.optStr(500),
      reason: f.optStr(500),
    }),
    run: async ({ actor, tx, data }) => {
      switch (data.op) {
        case "match":
          if (!data.matchType || !data.matchId) throw new ValidationError("Choose a record to match.");
          await matchBankTransaction(tx, actor, data.txnId, data.matchType, data.matchId);
          return "Matched to the existing record (no new posting).";
        case "unmatch":
          await unmatchBankTransaction(tx, actor, data.txnId);
          return "Match removed.";
        case "payment":
          if (!data.accountId) throw new ValidationError("Choose the client account.");
          await createPaymentFromTransaction(tx, actor, data.txnId, { accountId: data.accountId, allocations: data.invoiceId && data.allocationAmount ? [{ invoiceId: data.invoiceId, amount: data.allocationAmount }] : [] });
          return "Customer payment recorded from this bank line.";
        case "expense":
          if (!data.categoryId) throw new ValidationError("Choose an expense category.");
          await createExpenseFromTransaction(tx, actor, data.txnId, { categoryId: data.categoryId, description: data.description, engagementId: data.engagementId });
          return "Expense recorded from this bank line.";
        case "post":
          if (!data.ledgerAccountId) throw new ValidationError("Choose a ledger account.");
          await postTransactionToAccount(tx, actor, data.txnId, { ledgerAccountId: data.ledgerAccountId, memo: data.memo });
          return "Posted to the ledger.";
        case "exclude":
          if (!data.reason) throw new ValidationError("Give a reason.", { reason: "Required" });
          await excludeBankTransaction(tx, actor, data.txnId, data.reason);
          return "Excluded from reconciliation.";
      }
    },
  });
}

export async function transferAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.post", action: "bank.transfer", schema: z.object({ fromBankAccountId: f.id(), toBankAccountId: f.id(), transferDate: f.date(), amount: f.money(), memo: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    await createTransfer(tx, actor, data);
    return "Transfer between accounts recorded.";
  } });
}

export async function reconcileAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.post", action: "bank.reconcile", schema: z.object({ bankAccountId: f.id(), statementDate: f.date(), statementBalance: f.money(), complete: f.bool().optional() }), run: async ({ actor, tx, data }) => {
    const r = await reconcileBankAccount(tx, actor, { ...data, complete: data.complete ?? false });
    return `Reconciliation saved. Difference: ${r.difference}; ${r.unmatched} unmatched line(s)${data.complete ? " — marked complete." : "."}`;
  } });
}

/* ---------------- Accounting ---------------- */

export async function exchangeRateAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "fx.add", schema: z.object({ rateDate: f.date(), fromCurrency: f.currency(), toCurrency: f.currency(), rate: z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string().regex(/^\d+(\.\d{1,10})?$/, "Enter a rate like 1.2745")) }), run: async ({ actor, tx, data }) => {
    await addExchangeRate(tx, actor, data);
    return `Rate recorded: 1 ${data.fromCurrency} = ${data.rate} ${data.toCurrency} on ${data.rateDate}.`;
  } });
}

export async function manualJournalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: ["finance.post", "finance.admin"],
    action: "journal.manual",
    schema: z.object({ entryDate: f.date(), memo: f.str(1000), currency: f.currency(), kind: f.enumOf(["manual", "opening_balance"] as const).optional(), lines: z.array(z.object({ ledgerAccountId: f.optId(), debit: f.optMoney(), credit: f.optMoney(), description: f.optStr(500) })).optional() }),
    run: async ({ actor, tx, data }) => {
      const lines = (data.lines ?? []).filter((l) => l.ledgerAccountId && (l.debit || l.credit)).map((l) => ({ ledgerAccountId: l.ledgerAccountId!, debit: l.debit ?? undefined, credit: l.credit ?? undefined, description: l.description ?? undefined }));
      if (lines.length < 2) throw new ValidationError("A journal needs at least two lines.");
      const entry = await postManualJournal(tx, actor, { ...data, lines, submissionKey: String(fd.get("_submissionKey") ?? "") || null });
      return { message: `Journal ${entry.number} posted.`, redirectTo: `/finance/accounting/journals/${entry.id}` };
    },
  });
}

export async function reverseJournalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.post", action: "journal.reverse", schema: z.object({ id: f.id(), entryDate: f.date(), reason: f.str(1000) }), run: async ({ actor, tx, data }) => {
    await reverseManualJournal(tx, actor, data.id, data.entryDate, data.reason);
    return "Reversing entry posted.";
  } });
}

export async function lockPeriodAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.admin", action: "period.lock", schema: z.object({ periodStart: f.date(), periodEnd: f.date(), lock: f.bool(), note: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    await lockPeriod(tx, actor, data.periodStart, data.periodEnd, data.lock, data.note);
    return data.lock ? "Period locked. Postings dated in it are now blocked." : "Period reopened (logged).";
  } });
}

export async function ledgerAccountAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.admin", action: "ledger_account.save", schema: z.object({ id: f.optId(), code: f.str(20), name: f.str(200), type: f.enumOf(["asset", "liability", "equity", "income", "expense"] as const), subtype: f.str(60), isDirectCost: f.bool().optional(), active: f.bool().optional(), description: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    const { id, ...v } = data;
    if (id) {
      const [before] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, id));
      if (!before) throw new ValidationError("Account not found.");
      if (before.systemKey && (before.type !== v.type)) throw new ValidationError("System accounts cannot change type.");
      await tx.update(ledgerAccounts).set({ name: v.name, code: v.code, subtype: v.subtype, isDirectCost: v.isDirectCost ?? false, active: before.systemKey ? true : v.active ?? true, description: v.description }).where(eq(ledgerAccounts.id, id));
    } else {
      await tx.insert(ledgerAccounts).values({ ...v, isDirectCost: v.isDirectCost ?? false, active: true });
    }
    await audit(tx, actor, { action: id ? "ledger_account.updated" : "ledger_account.created", entityType: "ledger_account", entityId: id ?? null, summary: `${v.code} ${v.name}` });
    return "Account saved.";
  } });
}

export async function taxRateAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.admin", action: "tax_rate.save", schema: z.object({ id: f.optId(), name: f.str(200), ratePercent: f.decimal(), treatment: f.enumOf(["standard", "reduced", "zero_rated", "exempt", "reverse_charge", "out_of_scope"] as const), appliesTo: f.enumOf(["sales", "purchases", "both"] as const), description: f.optStr(500), active: f.bool().optional() }), run: async ({ actor, tx, data }) => {
    const { id, ...v } = data;
    const [row] = id ? await tx.update(taxRates).set({ ...v, active: v.active ?? true }).where(eq(taxRates.id, id)).returning() : await tx.insert(taxRates).values({ ...v, active: true }).returning();
    await audit(tx, actor, { action: "tax_rate.saved", entityType: "tax_rate", entityId: row.id, summary: `${row.name} ${row.ratePercent}%` });
    return "Tax rate saved. Existing documents keep the rate they were issued with.";
  } });
}

/* ---------------- Recurring invoices ---------------- */

export async function saveRecurringAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "recurring.save",
    schema: z.object({ id: f.optId(), name: f.str(200), accountId: f.id(), engagementId: f.optId(), frequency: f.enumOf(["monthly", "quarterly", "yearly"] as const), nextRunDate: f.date(), endDate: f.optDate(), currency: f.currency(), paymentTermsDays: f.optInt(), autoIssue: f.bool().optional(), lines: z.array(lineSchema).optional() }),
    run: async ({ actor, tx, data }) => {
      const lines = invoiceLines(data.lines).map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId, serviceId: l.serviceId }));
      const row = await saveRecurringSchedule(tx, actor, { ...data, id: data.id ?? undefined, lines, paymentTermsDays: data.paymentTermsDays ?? undefined });
      return { ref: row.id, redirectTo: `/finance/invoices?tab=recurring` };
    },
  });
}

export async function recurringStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "recurring.status", schema: z.object({ id: f.id(), status: f.enumOf(["active", "paused", "ended"] as const) }), run: async ({ actor, tx, data }) => {
    await setRecurringStatus(tx, actor, data.id, data.status);
    return `Schedule ${data.status}.`;
  } });
}

export async function runRecurringNowAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "finance.write", action: "recurring.run", schema: z.object({}), run: async ({ actor, tx }) => {
    const r = await runRecurringSchedules(tx, actor, await agencyToday(tx));
    return `${r} draft invoice(s) generated from recurring schedules.`;
  } });
}

/* ---------------- Cash forecast ---------------- */

export async function forecastAdjustmentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "forecast.adjustment",
    schema: z.object({ id: f.optId(), op: f.enumOf(["add", "delete"] as const), scenarioKey: f.enumOf(["base", "conservative", "upside", "all"] as const).optional(), weekStart: f.optDate(), description: f.optStr(500), amount: f.optMoney(), currency: f.optStr(3), direction: f.enumOf(["inflow", "outflow"] as const).optional(), recurring: f.enumOf(["none", "weekly", "monthly"] as const).optional() }),
    run: async ({ actor, tx, data }) => {
      if (data.op === "delete") {
        if (!data.id) throw new ValidationError("Missing adjustment.");
        await tx.delete(forecastAdjustments).where(eq(forecastAdjustments.id, data.id));
        await audit(tx, actor, { action: "forecast.adjustment_deleted", entityType: "forecast_adjustment", entityId: data.id, summary: "Forecast adjustment removed" });
        return "Adjustment removed.";
      }
      if (!data.weekStart || !data.description || !data.amount || !data.currency || !data.direction) throw new ValidationError("Week, description, amount, currency and direction are required.");
      const [row] = await tx.insert(forecastAdjustments).values({ scenarioKey: data.scenarioKey ?? "all", weekStart: data.weekStart, description: data.description, amount: data.amount, currency: data.currency.toUpperCase(), direction: data.direction, recurring: data.recurring ?? "none", createdBy: actor.userId || null }).returning();
      await audit(tx, actor, { action: "forecast.adjustment_added", entityType: "forecast_adjustment", entityId: row.id, summary: `${data.direction} ${data.currency} ${data.amount}: ${data.description}` });
      return "Adjustment added to the forecast (it is an assumption, not a transaction).";
    },
  });
}

export async function forecastScenarioAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.write",
    action: "forecast.scenario",
    schema: z.object({ key: f.enumOf(["base", "conservative", "upside"] as const), collectionDelayDays: f.int(), collectionRatePercent: f.int(), pipelineInclusionPercent: f.int(), expenseMultiplierPercent: f.int(), notes: f.text() }),
    run: async ({ actor, tx, data }) => {
      for (const [k, v] of [["collectionRatePercent", data.collectionRatePercent], ["pipelineInclusionPercent", data.pipelineInclusionPercent]] as const) if (v < 0 || v > 100) throw new ValidationError(`${k} must be 0–100.`);
      const names = { base: "Base", conservative: "Conservative", upside: "Upside" };
      await tx.insert(forecastScenarios).values({ ...data, name: names[data.key] }).onConflictDoUpdate({ target: forecastScenarios.key, set: { collectionDelayDays: data.collectionDelayDays, collectionRatePercent: data.collectionRatePercent, pipelineInclusionPercent: data.pipelineInclusionPercent, expenseMultiplierPercent: data.expenseMultiplierPercent, notes: data.notes } });
      await audit(tx, actor, { action: "forecast.scenario_updated", entityType: "forecast_scenario", entityId: null, summary: `${data.key}: delay ${data.collectionDelayDays}d, collect ${data.collectionRatePercent}%, pipeline ${data.pipelineInclusionPercent}%, costs ${data.expenseMultiplierPercent}%` });
      return "Scenario assumptions saved.";
    },
  });
}

/* ---------------- Budgets ---------------- */

export async function budgetAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "finance.admin",
    action: "budget.set",
    schema: z.object({ fiscalYear: f.int(), ledgerAccountId: f.id(), annualAmount: f.money(), note: f.optStr(500) }),
    run: async ({ actor, tx, data }) => {
      const s = await getSettings(tx);
      const total = d(data.annualAmount);
      const monthly = total.div(12).toDecimalPlaces(2, Decimal.ROUND_DOWN);
      for (let m = 1; m <= 12; m++) {
        const amount = m === 12 ? total.minus(monthly.times(11)).toFixed(2) : monthly.toFixed(2);
        await tx.insert(budgetLines).values({ fiscalYear: data.fiscalYear, month: m, ledgerAccountId: data.ledgerAccountId, amount, currency: s.baseCurrency, note: data.note }).onConflictDoUpdate({ target: [budgetLines.fiscalYear, budgetLines.month, budgetLines.ledgerAccountId], set: { amount, note: data.note } });
      }
      await audit(tx, actor, { action: "budget.set", entityType: "budget", entityId: null, summary: `FY${data.fiscalYear} budget ${data.annualAmount} for account ${data.ledgerAccountId}` });
      return "Budget saved (spread evenly across 12 months).";
    },
  });
}

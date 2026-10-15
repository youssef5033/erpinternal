import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accounts, bankAccounts, bankTransactions, customerPayments, invoices, paymentAllocations } from "@/db/schema";
import { d, toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { agencyToday, getSettings } from "../system/settings";
import { logActivity } from "../crm/activities";
import { getRate, postJournal, reverseJournal } from "./ledger";
import { invoiceBalances } from "./invoices";

export type PaymentInput = {
  accountId: string;
  paymentDate: string;
  amount: string;
  currency: string;
  method: "bank_transfer" | "card" | "cash" | "cheque" | "processor" | "other";
  reference?: string | null;
  bankAccountId: string;
  evidenceNote?: string | null;
  allocations?: { invoiceId: string; amount: string }[];
};

/** Unallocated = amount − Σ active allocations (customer credit / overpayment). */
export async function paymentUnallocated(tx: Tx, paymentId: string) {
  const res = await tx.execute<{ amount: string; allocated: string }>(sql`
    select p.amount, coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = p.id and a.reversed_at is null), 0) as allocated
    from customer_payments p where p.id = ${paymentId}`);
  const r = res.rows[0];
  if (!r) throw new NotFoundError("Payment");
  return { amount: toMoney(r.amount), allocated: toMoney(r.allocated), unallocated: toMoney(d(r.amount).minus(d(r.allocated))) };
}

/**
 * Record money received. Posts Dr Bank / Cr Unapplied customer payments, then
 * applies any allocations. Overpayments stay as unapplied credit on the
 * account and can be allocated to future invoices.
 */
export async function recordCustomerPayment(tx: Tx, actor: Actor, input: PaymentInput) {
  assertCan(actor, "finance.write");
  const amount = d(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new ValidationError("Amount must be positive.", { amount: "Must be positive" });
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!acc) throw new NotFoundError("Account");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId));
  if (!bank) throw new NotFoundError("Bank account");
  const currency = input.currency.toUpperCase();
  if (bank.currency !== currency) throw new ValidationError(`${bank.name} holds ${bank.currency}; record a ${currency} payment against a ${currency} account.`);
  const allocTotal = (input.allocations ?? []).reduce((a, x) => a.plus(d(x.amount)), d(0));
  if (allocTotal.greaterThan(amount)) throw new ValidationError("Allocations exceed the payment amount.");
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, currency, settings.baseCurrency, input.paymentDate);
  const number = await nextNumber(tx, "payment");
  const [pay] = await tx
    .insert(customerPayments)
    .values({
      number,
      accountId: input.accountId,
      paymentDate: input.paymentDate,
      amount: toMoney(amount),
      currency,
      exchangeRate: rate,
      method: input.method,
      reference: input.reference || null,
      bankAccountId: input.bankAccountId,
      evidenceNote: input.evidenceNote || null,
      createdBy: actor.userId || null,
    })
    .returning();
  const { entry } = await postJournal(tx, actor, {
    entryDate: input.paymentDate,
    memo: `Payment ${number} from ${acc.name}${input.reference ? ` (${input.reference})` : ""}`,
    sourceType: "customer_payment",
    sourceId: pay.id,
    postingKey: `payment:${pay.id}`,
    currency,
    rate,
    lines: [
      { ledgerAccountId: bank.ledgerAccountId, amount: amount.toString(), accountId: acc.id, description: `Received ${number}` },
      { systemKey: "unapplied_cash", amount: amount.negated().toString(), accountId: acc.id, description: `Unapplied ${number}` },
    ],
  });
  await tx.update(customerPayments).set({ journalEntryId: entry.id }).where(eq(customerPayments.id, pay.id));
  for (const a of input.allocations ?? []) {
    if (d(a.amount).greaterThan(0)) await allocatePayment(tx, actor, pay.id, a.invoiceId, a.amount, input.paymentDate);
  }
  await logActivity(tx, actor, { type: "payment", direction: "inbound", subject: `Payment ${number} received: ${currency} ${pay.amount}`, accountId: acc.id, relatedType: "customer_payment", relatedId: pay.id, source: "system" });
  await audit(tx, actor, { action: "payment.recorded", entityType: "customer_payment", entityId: pay.id, summary: `${number}: ${currency} ${pay.amount} from ${acc.name}`, changes: { allocations: input.allocations ?? [] } });
  return pay;
}

/**
 * Apply part of a payment to an invoice. Row locks on both records prevent
 * concurrent over-allocation. Posts Dr Unapplied (payment rate) / Cr AR
 * (invoice rate); any difference is realised FX.
 */
export async function allocatePayment(tx: Tx, actor: Actor, paymentId: string, invoiceId: string, amountIn: string, allocationDate?: string) {
  assertCan(actor, "finance.write");
  const amount = d(amountIn);
  if (amount.lessThanOrEqualTo(0)) throw new ValidationError("Allocation must be positive.");
  const [pay] = await tx.select().from(customerPayments).where(eq(customerPayments.id, paymentId)).for("update");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!pay) throw new NotFoundError("Payment");
  if (!inv) throw new NotFoundError("Invoice");
  if (pay.status !== "recorded") throw new ValidationError("This payment has been reversed.");
  if (inv.status !== "issued") throw new ValidationError("Payments can only be allocated to issued invoices.");
  if (inv.accountId !== pay.accountId) throw new ValidationError("The invoice belongs to a different account.");
  if (inv.currency !== pay.currency) throw new ValidationError(`Currency mismatch: invoice ${inv.currency}, payment ${pay.currency}.`);
  const { unallocated } = await paymentUnallocated(tx, paymentId);
  if (amount.greaterThan(d(unallocated))) throw new ValidationError(`Only ${pay.currency} ${unallocated} of this payment is unallocated.`);
  const [bal] = await invoiceBalances(tx, [invoiceId]);
  if (amount.greaterThan(d(bal.outstanding))) throw new ValidationError(`Invoice ${inv.number} only has ${inv.currency} ${bal.outstanding} outstanding.`);
  const date = allocationDate ?? (pay.paymentDate > (inv.issueDate ?? "") ? pay.paymentDate : inv.issueDate!);
  const [alloc] = await tx
    .insert(paymentAllocations)
    .values({ paymentId, invoiceId, amount: toMoney(amount), allocationDate: date, createdBy: actor.userId || null })
    .returning();
  const { entry } = await postJournal(tx, actor, {
    entryDate: date,
    memo: `Apply ${pay.number} to ${inv.number}`,
    sourceType: "payment_allocation",
    sourceId: alloc.id,
    postingKey: `allocation:${alloc.id}`,
    currency: pay.currency,
    rate: pay.exchangeRate,
    lines: [
      { systemKey: "unapplied_cash", amount: amount.toString(), rate: pay.exchangeRate, accountId: pay.accountId, description: `Applied ${pay.number}` },
      { systemKey: "accounts_receivable", amount: amount.negated().toString(), rate: inv.exchangeRate, accountId: inv.accountId, engagementId: inv.engagementId, description: `Settles ${inv.number}` },
    ],
  });
  await tx.update(paymentAllocations).set({ journalEntryId: entry.id }).where(eq(paymentAllocations.id, alloc.id));
  await audit(tx, actor, { action: "payment.allocated", entityType: "invoice", entityId: invoiceId, summary: `${pay.number} → ${inv.number}: ${pay.currency} ${alloc.amount}` });
  return alloc;
}

export async function reverseAllocation(tx: Tx, actor: Actor, allocationId: string, reason: string) {
  assertCan(actor, "finance.post");
  const [a] = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.id, allocationId)).for("update");
  if (!a) throw new NotFoundError("Allocation");
  if (a.reversedAt) throw new ConflictError("Allocation already reversed.");
  const today = await agencyToday(tx);
  const rev = await reverseJournal(tx, actor, a.journalEntryId!, { entryDate: today, memo: `Reverse allocation: ${reason}`, postingKey: `allocation:${a.id}:reverse` });
  await tx.update(paymentAllocations).set({ reversedAt: new Date(), reversalJournalEntryId: rev.id }).where(eq(paymentAllocations.id, a.id));
  await audit(tx, actor, { action: "payment.allocation_reversed", entityType: "invoice", entityId: a.invoiceId, summary: `Allocation of ${a.amount} reversed: ${reason}` });
}

/** Reverse a payment entirely (e.g. bounced): reverses allocations then the receipt. */
export async function reverseCustomerPayment(tx: Tx, actor: Actor, paymentId: string, reason: string) {
  assertCan(actor, "finance.post");
  if (!reason.trim()) throw new ValidationError("A reason is required.");
  const [pay] = await tx.select().from(customerPayments).where(eq(customerPayments.id, paymentId)).for("update");
  if (!pay) throw new NotFoundError("Payment");
  if (pay.status === "reversed") throw new ConflictError("Payment already reversed.");
  const allocs = await tx.select().from(paymentAllocations).where(and(eq(paymentAllocations.paymentId, paymentId), isNull(paymentAllocations.reversedAt)));
  for (const a of allocs) await reverseAllocation(tx, actor, a.id, `Payment ${pay.number} reversed`);
  const today = await agencyToday(tx);
  await reverseJournal(tx, actor, pay.journalEntryId!, { entryDate: today, memo: `Reverse payment ${pay.number}: ${reason}`, postingKey: `payment:${pay.id}:reverse` });
  await tx.update(customerPayments).set({ status: "reversed", reversedAt: new Date(), reversalReason: reason }).where(eq(customerPayments.id, paymentId));
  await tx
    .update(bankTransactions)
    .set({ status: "unreconciled", matchType: null, matchId: null, matchedAt: null, matchedBy: null })
    .where(and(eq(bankTransactions.matchType, "customer_payment"), eq(bankTransactions.matchId, paymentId)));
  await logActivity(tx, actor, { type: "payment", subject: `Payment ${pay.number} reversed`, body: reason, accountId: pay.accountId, relatedType: "customer_payment", relatedId: pay.id, source: "system" });
  await audit(tx, actor, { action: "payment.reversed", entityType: "customer_payment", entityId: pay.id, summary: `${pay.number} reversed: ${reason}` });
}

/** Account-level customer credit (unallocated payments). */
export async function accountCredit(tx: Tx, accountId: string) {
  const res = await tx.execute<{ currency: string; credit: string }>(sql`
    select p.currency, sum(p.amount - coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = p.id and a.reversed_at is null),0)) as credit
    from customer_payments p where p.account_id = ${accountId} and p.status = 'recorded' group by p.currency`);
  return res.rows.filter((r) => d(r.credit).greaterThan(0)).map((r) => ({ currency: r.currency, credit: toMoney(r.credit) }));
}

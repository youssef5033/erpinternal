import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  billingScheduleItems,
  creditNotes,
  engagements,
  invoiceLines,
  invoices,
  paymentAllocations,
  taxRates,
} from "@/db/schema";
import { addDaysISO, daysBetween } from "@/lib/dates";
import { allocateProportionally, d, Decimal, sum, toFixed4, toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { agencyToday, getSettings } from "../system/settings";
import { logActivity } from "../crm/activities";
import { getRate, postJournal, revenueAccountForService, reverseJournal } from "./ledger";

export type InvoiceLineInput = {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string | null;
  taxRateId?: string | null;
  serviceId?: string | null;
  offerId?: string | null;
};

export type InvoiceInput = {
  accountId: string;
  engagementId?: string | null;
  billingContactId?: string | null;
  currency: string;
  paymentTermsDays?: number | null;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  isDeposit?: boolean;
  milestoneId?: string | null;
  servicePeriodId?: string | null;
  revenueTreatment?: "deferred" | "on_issue";
  lines: InvoiceLineInput[];
};

/** Line math: subtotal = qty × price; discount on subtotal; tax on net. All rounded to cents per line. */
export function computeInvoiceLine(l: { quantity: string; unitPrice: string; discountPercent?: string | null }, taxPercent: string) {
  const subtotal = d(toMoney(d(l.quantity).times(d(l.unitPrice))));
  const discount = d(toMoney(subtotal.times(d(l.discountPercent)).div(100)));
  const net = subtotal.minus(discount);
  const tax = d(toMoney(net.times(d(taxPercent)).div(100)));
  return { lineSubtotal: subtotal.toFixed(2), lineDiscount: discount.toFixed(2), lineTax: tax.toFixed(2), lineTotal: net.plus(tax).toFixed(2), net: net.toFixed(2) };
}

async function buildLines(tx: Tx, invoiceId: string, engagementServiceId: string | null, lines: InvoiceLineInput[]) {
  if (!lines.length) throw new ValidationError("Add at least one line.");
  const rateIds = lines.map((l) => l.taxRateId).filter((x): x is string => !!x);
  const rates = rateIds.length ? await tx.select().from(taxRates).where(inArray(taxRates.id, rateIds)) : [];
  const rows: (typeof invoiceLines.$inferInsert)[] = [];
  for (const [i, l] of lines.entries()) {
    if (!l.description?.trim()) throw new ValidationError(`Line ${i + 1} needs a description.`);
    if (d(l.quantity).lessThanOrEqualTo(0)) throw new ValidationError(`Line ${i + 1}: quantity must be positive.`);
    if (d(l.unitPrice).isNegative()) throw new ValidationError(`Line ${i + 1}: use a credit note instead of negative prices.`);
    const disc = d(l.discountPercent);
    if (disc.isNegative() || disc.greaterThan(100)) throw new ValidationError(`Line ${i + 1}: discount must be 0–100%.`);
    const rate = l.taxRateId ? rates.find((r) => r.id === l.taxRateId) : null;
    if (l.taxRateId && !rate) throw new ValidationError(`Line ${i + 1}: unknown tax rate.`);
    const c = computeInvoiceLine(l, rate?.ratePercent ?? "0");
    const serviceId = l.serviceId || engagementServiceId || null;
    const revenue = await revenueAccountForService(tx, serviceId);
    rows.push({
      invoiceId,
      description: l.description.trim(),
      quantity: toFixed4(l.quantity),
      unitPrice: toMoney(l.unitPrice),
      discountPercent: toFixed4(l.discountPercent || "0"),
      taxRateId: rate?.id ?? null,
      taxRatePercent: toFixed4(rate?.ratePercent ?? "0"),
      lineSubtotal: c.lineSubtotal,
      lineDiscount: c.lineDiscount,
      lineTax: c.lineTax,
      lineTotal: c.lineTotal,
      serviceId,
      offerId: l.offerId || null,
      revenueLedgerAccountId: revenue.id,
      sortOrder: i,
    });
  }
  return rows;
}

function totals(rows: (typeof invoiceLines.$inferInsert)[]) {
  const subtotal = sum(rows.map((r) => r.lineSubtotal));
  const discount = sum(rows.map((r) => r.lineDiscount));
  const tax = sum(rows.map((r) => r.lineTax));
  return { subtotal: toMoney(subtotal), discountTotal: toMoney(discount), taxTotal: toMoney(tax), total: toMoney(subtotal.minus(discount).plus(tax)) };
}

export async function createInvoiceDraft(tx: Tx, actor: Actor, input: InvoiceInput, opts: { generationKey?: string | null; recurringScheduleId?: string | null } = {}) {
  assertCan(actor, "finance.write");
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!acc) throw new NotFoundError("Account");
  let serviceId: string | null = null;
  if (input.engagementId) {
    const [eng] = await tx.select().from(engagements).where(eq(engagements.id, input.engagementId));
    if (!eng) throw new NotFoundError("Engagement");
    if (eng.accountId !== input.accountId) throw new ValidationError("The engagement belongs to a different account.");
    if (eng.currency !== input.currency.toUpperCase()) throw new ValidationError(`The engagement is billed in ${eng.currency}.`);
    serviceId = eng.serviceId;
  }
  if (opts.generationKey) {
    const [existing] = await tx.select().from(invoices).where(eq(invoices.generationKey, opts.generationKey));
    if (existing) return { invoice: existing, created: false };
  }
  const settings = await getSettings(tx);
  const inserted = await tx
    .insert(invoices)
    .values({
      accountId: input.accountId,
      engagementId: input.engagementId || null,
      billingContactId: input.billingContactId || null,
      currency: input.currency.toUpperCase(),
      paymentTermsDays: input.paymentTermsDays ?? acc.paymentTermsDays ?? settings.defaultPaymentTermsDays,
      reference: input.reference || null,
      notes: input.notes || null,
      terms: input.terms || settings.invoiceFooter || null,
      isDeposit: !!input.isDeposit,
      milestoneId: input.milestoneId || null,
      servicePeriodId: input.servicePeriodId || null,
      revenueTreatment: input.revenueTreatment ?? (input.engagementId ? "deferred" : "on_issue"),
      generationKey: opts.generationKey ?? null,
      recurringScheduleId: opts.recurringScheduleId ?? null,
      createdBy: actor.userId || null,
    })
    .onConflictDoNothing({ target: invoices.generationKey })
    .returning();
  if (!inserted.length) {
    const [existing] = await tx.select().from(invoices).where(eq(invoices.generationKey, opts.generationKey!));
    return { invoice: existing, created: false };
  }
  const inv = inserted[0];
  const rows = await buildLines(tx, inv.id, serviceId, input.lines);
  await tx.insert(invoiceLines).values(rows);
  const [updated] = await tx.update(invoices).set(totals(rows)).where(eq(invoices.id, inv.id)).returning();
  await audit(tx, actor, { action: "invoice.draft_created", entityType: "invoice", entityId: inv.id, summary: `Draft invoice for ${acc.name}: ${updated.currency} ${updated.total}` });
  return { invoice: updated, created: true };
}

export async function updateInvoiceDraft(tx: Tx, actor: Actor, id: string, input: InvoiceInput) {
  assertCan(actor, "finance.write");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice");
  if (inv.status !== "draft") throw new ValidationError("Issued invoices cannot be edited. Void it or issue a credit note.");
  const [eng] = inv.engagementId ? await tx.select().from(engagements).where(eq(engagements.id, inv.engagementId)) : [];
  await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  const rows = await buildLines(tx, id, eng?.serviceId ?? null, input.lines);
  await tx.insert(invoiceLines).values(rows);
  await tx
    .update(invoices)
    .set({ ...totals(rows), paymentTermsDays: input.paymentTermsDays ?? inv.paymentTermsDays, reference: input.reference || null, notes: input.notes || null, terms: input.terms || inv.terms, billingContactId: input.billingContactId || null, revenueTreatment: input.revenueTreatment ?? inv.revenueTreatment, isDeposit: !!input.isDeposit })
    .where(eq(invoices.id, id));
  await audit(tx, actor, { action: "invoice.draft_updated", entityType: "invoice", entityId: id, summary: `Draft invoice updated` });
}

export async function deleteInvoiceDraft(tx: Tx, actor: Actor, id: string) {
  assertCan(actor, "finance.write");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice");
  if (inv.status !== "draft") throw new ValidationError("Only drafts can be deleted. Issued invoices are kept and voided or credited.");
  await tx.update(billingScheduleItems).set({ status: "planned", invoiceId: null }).where(eq(billingScheduleItems.invoiceId, id));
  await tx.delete(invoices).where(eq(invoices.id, id));
  await audit(tx, actor, { action: "invoice.draft_deleted", entityType: "invoice", entityId: id, summary: `Draft invoice deleted` });
}

/**
 * Issue: assigns the next sequential number, fixes dates and FX rate, snapshots
 * the content and posts:
 *   Dr Accounts receivable (total)
 *   Cr Output tax (tax)
 *   Cr Deferred revenue — or Revenue when revenueTreatment = on_issue (net, per service)
 * Issuing does NOT mean revenue is earned; see revenue recognition.
 */
export async function issueInvoice(tx: Tx, actor: Actor, id: string, input: { issueDate?: string | null } = {}) {
  assertCan(actor, "finance.post");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice");
  if (inv.status === "issued") throw new ConflictError(`Invoice ${inv.number} is already issued.`);
  if (inv.status !== "draft") throw new ValidationError("Only drafts can be issued.");
  if (d(inv.total).lessThanOrEqualTo(0)) throw new ValidationError("Invoice total must be positive.");
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, inv.accountId));
  if (!acc.billingAddress && !acc.billingEmail) throw new ValidationError(`${acc.name} has no billing address or billing email. Complete the billing details first.`);
  const settings = await getSettings(tx);
  const issueDate = input.issueDate || (await agencyToday(tx));
  const dueDate = addDaysISO(issueDate, inv.paymentTermsDays);
  const { rate } = await getRate(tx, inv.currency, settings.baseCurrency, issueDate);
  const number = await nextNumber(tx, "invoice", settings.invoicePrefix);
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.sortOrder));
  const treatmentKey = inv.revenueTreatment === "deferred" ? "deferred_revenue" : null;
  const postingLines = [
    { systemKey: "accounts_receivable", amount: inv.total, accountId: inv.accountId, engagementId: inv.engagementId, description: `Invoice ${number}` },
    ...(d(inv.taxTotal).isZero() ? [] : [{ systemKey: "output_tax", amount: d(inv.taxTotal).negated().toString(), description: `Tax on ${number}` }]),
    ...lines.map((l) => ({
      ...(treatmentKey ? { systemKey: treatmentKey } : { ledgerAccountId: l.revenueLedgerAccountId! }),
      amount: d(l.lineSubtotal).minus(d(l.lineDiscount)).negated().toString(),
      description: l.description,
      accountId: inv.accountId,
      engagementId: inv.engagementId,
      serviceId: l.serviceId,
    })),
  ];
  const { entry } = await postJournal(tx, actor, { entryDate: issueDate, memo: `Invoice ${number} — ${acc.name}`, sourceType: "invoice", sourceId: id, postingKey: `invoice:${id}:issue`, currency: inv.currency, rate, lines: postingLines });
  const snapshot = { number, issueDate, dueDate, lines, totals: { subtotal: inv.subtotal, discountTotal: inv.discountTotal, taxTotal: inv.taxTotal, total: inv.total }, account: { name: acc.name, billingAddress: acc.billingAddress, billingEmail: acc.billingEmail, taxIdentifier: acc.taxIdentifier } };
  await tx
    .update(invoices)
    .set({ status: "issued", number, issueDate, dueDate, exchangeRate: rate, issuedAt: new Date(), issuedBy: actor.userId || null, journalEntryId: entry.id, issuedSnapshot: snapshot })
    .where(eq(invoices.id, id));
  await tx.update(billingScheduleItems).set({ status: "invoiced" }).where(eq(billingScheduleItems.invoiceId, id));
  await logActivity(tx, actor, { type: "invoice", subject: `Invoice ${number} issued: ${inv.currency} ${inv.total}, due ${dueDate}`, accountId: inv.accountId, engagementId: inv.engagementId, relatedType: "invoice", relatedId: id, source: "system" });
  await audit(tx, actor, { action: "invoice.issued", entityType: "invoice", entityId: id, summary: `Issued ${number} (${inv.currency} ${inv.total})`, changes: { number, issueDate, dueDate, rate } });
  return { number, journalEntryId: entry.id };
}

/** Void: only when nothing has been allocated or credited. Posts a full reversal. */
export async function voidInvoice(tx: Tx, actor: Actor, id: string, reason: string) {
  assertCan(actor, "finance.post");
  if (!reason.trim()) throw new ValidationError("A void reason is required.");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice");
  if (inv.status !== "issued") throw new ValidationError("Only issued invoices can be voided (delete drafts instead).");
  const bal = (await invoiceBalances(tx, [id]))[0];
  if (!d(bal.allocated).isZero()) throw new ValidationError("Payments are allocated to this invoice. Reverse the allocations first.");
  if (!d(bal.credited).isZero()) throw new ValidationError("Credit notes exist for this invoice; issue a further credit note instead of voiding.");
  const today = await agencyToday(tx);
  await reverseJournal(tx, actor, inv.journalEntryId!, { entryDate: today, memo: `Void invoice ${inv.number}: ${reason}`, postingKey: `invoice:${id}:void` });
  await tx.update(invoices).set({ status: "void", voidedAt: new Date(), voidedBy: actor.userId || null, voidReason: reason }).where(eq(invoices.id, id));
  await tx.update(billingScheduleItems).set({ status: "planned", invoiceId: null }).where(eq(billingScheduleItems.invoiceId, id));
  await logActivity(tx, actor, { type: "invoice", subject: `Invoice ${inv.number} voided`, body: reason, accountId: inv.accountId, engagementId: inv.engagementId, relatedType: "invoice", relatedId: id, source: "system" });
  await audit(tx, actor, { action: "invoice.voided", entityType: "invoice", entityId: id, summary: `Voided ${inv.number}: ${reason}` });
}

/* ------------------------------------------------------------------ */
/* Balances & derived status                                            */
/* ------------------------------------------------------------------ */

export type InvoicePaymentStatus = "draft" | "void" | "unpaid" | "partially_paid" | "paid" | "credited";

export type InvoiceBalance = { invoiceId: string; total: string; allocated: string; credited: string; outstanding: string };

/** Outstanding = total − Σ active allocations − Σ issued credit notes. */
export async function invoiceBalances(tx: Tx, ids: string[]): Promise<InvoiceBalance[]> {
  if (!ids.length) return [];
  const res = await tx.execute<{ id: string; total: string; allocated: string; credited: string }>(sql`
    select i.id, i.total,
      coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id and pa.reversed_at is null), 0) as allocated,
      coalesce((select sum(cn.total) from credit_notes cn where cn.invoice_id = i.id and cn.status = 'issued'), 0) as credited
    from invoices i where i.id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`);
  return res.rows.map((r) => ({ invoiceId: r.id, total: r.total, allocated: toMoney(r.allocated), credited: toMoney(r.credited), outstanding: toMoney(d(r.total).minus(d(r.allocated)).minus(d(r.credited))) }));
}

export function derivePaymentStatus(inv: { status: string; total: string }, bal: { allocated: string; credited: string; outstanding: string }): InvoicePaymentStatus {
  if (inv.status === "draft") return "draft";
  if (inv.status === "void") return "void";
  if (d(bal.outstanding).lessThanOrEqualTo(0)) return d(bal.allocated).isZero() && !d(bal.credited).isZero() ? "credited" : "paid";
  if (d(bal.allocated).greaterThan(0) || d(bal.credited).greaterThan(0)) return "partially_paid";
  return "unpaid";
}

export function isOverdue(inv: { status: string; dueDate: string | null }, outstanding: string, today: string) {
  return inv.status === "issued" && !!inv.dueDate && inv.dueDate < today && d(outstanding).greaterThan(0);
}

export function daysOverdue(dueDate: string | null, today: string) {
  return dueDate ? Math.max(0, daysBetween(dueDate, today)) : 0;
}

/** SQL expression for outstanding amount, usable in list queries. */
export const outstandingSql = sql<string>`(${invoices.total}
  - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = ${invoices.id} and pa.reversed_at is null), 0)
  - coalesce((select sum(cn.total) from credit_notes cn where cn.invoice_id = ${invoices.id} and cn.status = 'issued'), 0))`;

export async function listInvoicesWithBalances(tx: Tx, where?: SQL) {
  const rows = await tx
    .select({ invoice: invoices, accountName: accounts.name, outstanding: outstandingSql, engagementNumber: engagements.number })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .leftJoin(engagements, eq(engagements.id, invoices.engagementId))
    .where(where)
    .orderBy(sql`${invoices.issueDate} desc nulls first`, sql`${invoices.createdAt} desc`);
  return rows.map((r) => ({ ...r, outstanding: toMoney(r.outstanding) }));
}

/* ------------------------------------------------------------------ */
/* Credit notes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Credit part or all of an invoice's outstanding balance. Tax is credited in
 * the invoice's tax ratio and net is reversed against the same accounts the
 * invoice credited (deferred revenue or revenue), proportionally per line.
 */
export async function issueCreditNote(tx: Tx, actor: Actor, invoiceId: string, input: { grossAmount: string; reason: string; issueDate?: string | null }) {
  assertCan(actor, "finance.post");
  if (!input.reason.trim()) throw new ValidationError("A reason is required.");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for("update");
  if (!inv || inv.status !== "issued") throw new ValidationError("Credit notes can only be raised against issued invoices.");
  const gross = d(input.grossAmount);
  if (gross.lessThanOrEqualTo(0)) throw new ValidationError("Amount must be positive.");
  const bal = (await invoiceBalances(tx, [invoiceId]))[0];
  if (gross.greaterThan(d(bal.outstanding))) throw new ValidationError(`Credit cannot exceed the outstanding balance (${inv.currency} ${bal.outstanding}). Reverse payment allocations first if you need to refund.`);
  const settings = await getSettings(tx);
  const issueDate = input.issueDate || (await agencyToday(tx));
  const ratio = d(inv.total).isZero() ? new Decimal(0) : d(inv.taxTotal).div(d(inv.total));
  const tax = d(toMoney(gross.times(ratio)));
  const net = gross.minus(tax);
  const lines = await tx.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(asc(invoiceLines.sortOrder));
  const netShares = allocateProportionally(net, lines.map((l) => d(l.lineSubtotal).minus(d(l.lineDiscount))));
  const number = await nextNumber(tx, "credit_note", settings.creditNotePrefix);
  const [cn] = await tx
    .insert(creditNotes)
    .values({ number, invoiceId, accountId: inv.accountId, issueDate, status: "issued", currency: inv.currency, exchangeRate: inv.exchangeRate, subtotal: net.toFixed(2), taxTotal: tax.toFixed(2), total: gross.toFixed(2), reason: input.reason, issuedBy: actor.userId || null, issuedAt: new Date(), createdBy: actor.userId || null })
    .returning();
  const { entry } = await postJournal(tx, actor, {
    entryDate: issueDate,
    memo: `Credit note ${number} against ${inv.number}`,
    sourceType: "credit_note",
    sourceId: cn.id,
    postingKey: `credit_note:${cn.id}`,
    currency: inv.currency,
    rate: inv.exchangeRate, // same rate as the invoice so AR clears exactly
    lines: [
      { systemKey: "accounts_receivable", amount: gross.negated().toString(), accountId: inv.accountId, engagementId: inv.engagementId, description: `Credit ${number}` },
      ...(tax.isZero() ? [] : [{ systemKey: "output_tax", amount: tax.toString(), description: `Tax credit ${number}` }]),
      ...lines.map((l, i) => ({
        ...(inv.revenueTreatment === "deferred" ? { systemKey: "deferred_revenue" } : { ledgerAccountId: l.revenueLedgerAccountId! }),
        amount: netShares[i],
        description: `Credit: ${l.description}`,
        accountId: inv.accountId,
        engagementId: inv.engagementId,
        serviceId: l.serviceId,
      })),
    ],
  });
  await tx.update(creditNotes).set({ journalEntryId: entry.id }).where(eq(creditNotes.id, cn.id));
  await logActivity(tx, actor, { type: "invoice", subject: `Credit note ${number} issued against ${inv.number}: ${inv.currency} ${cn.total}`, body: input.reason, accountId: inv.accountId, engagementId: inv.engagementId, relatedType: "credit_note", relatedId: cn.id, source: "system" });
  await audit(tx, actor, { action: "credit_note.issued", entityType: "credit_note", entityId: cn.id, summary: `${number} for ${inv.number}: ${inv.currency} ${cn.total} — ${input.reason}` });
  return cn;
}

/* ------------------------------------------------------------------ */
/* Billing schedule → invoices                                          */
/* ------------------------------------------------------------------ */

/** Create a draft invoice from a billing schedule item (idempotent per item). */
export async function invoiceFromBillingItem(tx: Tx, actor: Actor, itemId: string) {
  assertCan(actor, "finance.write");
  const [item] = await tx.select().from(billingScheduleItems).where(eq(billingScheduleItems.id, itemId)).for("update");
  if (!item) throw new NotFoundError("Billing item");
  if (item.status === "cancelled") throw new ValidationError("This billing item is cancelled.");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, item.engagementId));
  const { invoice, created } = await createInvoiceDraft(
    tx,
    actor,
    {
      accountId: eng.accountId,
      engagementId: eng.id,
      currency: item.currency,
      isDeposit: item.isDeposit,
      milestoneId: item.milestoneId,
      servicePeriodId: item.servicePeriodId,
      reference: eng.number,
      lines: [{ description: `${eng.name} — ${item.label}`, quantity: "1", unitPrice: item.amount, serviceId: eng.serviceId }],
    },
    { generationKey: `bsi:${item.id}` },
  );
  if (created || !item.invoiceId) await tx.update(billingScheduleItems).set({ status: "invoiced", invoiceId: invoice.id }).where(eq(billingScheduleItems.id, item.id));
  return { invoice, created };
}

export async function approveBillingItem(tx: Tx, actor: Actor, itemId: string, input: { plannedDate?: string | null; amount?: string | null }) {
  assertCan(actor, "finance.write");
  const [item] = await tx.select().from(billingScheduleItems).where(eq(billingScheduleItems.id, itemId)).for("update");
  if (!item) throw new NotFoundError("Billing item");
  if (item.status === "invoiced") throw new ValidationError("Already invoiced.");
  await tx
    .update(billingScheduleItems)
    .set({ status: "planned", plannedDate: input.plannedDate ?? item.plannedDate, amount: input.amount ? toMoney(input.amount) : item.amount })
    .where(eq(billingScheduleItems.id, itemId));
  await audit(tx, actor, { action: "billing_item.planned", entityType: "billing_schedule_item", entityId: itemId, summary: `Billing item confirmed: ${item.label}` });
}

/**
 * Job: draft invoices for planned billing items whose date has arrived.
 * Milestone items wait until the milestone is accepted (status set to planned
 * by acceptMilestone). Idempotent via invoice.generationKey.
 */
export async function generateDueBillingInvoices(tx: Tx, actor: Actor, asOf: string) {
  const due = await tx
    .select()
    .from(billingScheduleItems)
    .where(and(eq(billingScheduleItems.status, "planned"), isNull(billingScheduleItems.invoiceId), sql`(${billingScheduleItems.plannedDate} is null and ${billingScheduleItems.milestoneId} is not null or ${billingScheduleItems.plannedDate} <= ${asOf})`));
  let created = 0;
  for (const item of due) {
    const r = await invoiceFromBillingItem(tx, actor, item.id);
    if (r.created) created++;
  }
  return created;
}

export async function invoiceAllocations(tx: Tx, invoiceId: string) {
  return tx.select().from(paymentAllocations).where(eq(paymentAllocations.invoiceId, invoiceId));
}

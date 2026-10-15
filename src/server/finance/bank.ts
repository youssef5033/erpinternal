import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import Papa from "papaparse";
import type { Tx } from "@/db/client";
import {
  bankAccounts,
  bankTransactions,
  bankTransfers,
  customerPayments,
  expenses,
  importBatches,
  importRows,
  journalEntries,
  journalLines,
  ledgerAccounts,
  reconciliations,
  supplierPayments,
  type BankMatchType,
} from "@/db/schema";
import { addDaysISO, isISODate } from "@/lib/dates";
import { d, toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getSettings } from "../system/settings";
import { getRate, postJournal } from "./ledger";
import { recordCustomerPayment } from "./payments";
import { approveExpense, submitExpense } from "./payables";

/* ------------------------------------------------------------------ */
/* Bank accounts                                                       */
/* ------------------------------------------------------------------ */

export async function createBankAccount(
  tx: Tx,
  actor: Actor,
  input: { name: string; kind: "bank" | "cash" | "card" | "payment_processor"; institution?: string | null; accountNumberLast4?: string | null; currency: string; openingBalance?: string | null; openingBalanceDate?: string | null },
) {
  assertCan(actor, "finance.admin");
  if (!input.name.trim()) throw new ValidationError("Name is required.");
  if (input.accountNumberLast4 && !/^\d{4}$/.test(input.accountNumberLast4)) throw new ValidationError("Store only the last 4 digits of the account number.");
  const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(ledgerAccounts).where(eq(ledgerAccounts.subtype, "bank"));
  const [parent] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.code, "1000"));
  const [ledger] = await tx
    .insert(ledgerAccounts)
    .values({ code: String(1010 + Number(n) * 10), name: `${input.name} (${input.currency.toUpperCase()})`, type: "asset", subtype: "bank", parentId: parent?.id ?? null })
    .returning();
  const [bank] = await tx
    .insert(bankAccounts)
    .values({ name: input.name.trim(), kind: input.kind, institution: input.institution || null, accountNumberLast4: input.accountNumberLast4 || null, currency: input.currency.toUpperCase(), ledgerAccountId: ledger.id })
    .returning();
  await audit(tx, actor, { action: "bank_account.created", entityType: "bank_account", entityId: bank.id, summary: `Bank account ${bank.name} (${bank.currency})` });
  if (input.openingBalance && input.openingBalanceDate) await setOpeningBalance(tx, actor, bank.id, input.openingBalance, input.openingBalanceDate);
  return bank;
}

/** Opening balance: Dr bank / Cr opening balance equity (posted once per bank account). */
export async function setOpeningBalance(tx: Tx, actor: Actor, bankAccountId: string, amount: string, date: string) {
  assertCan(actor, "finance.admin");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId)).for("update");
  if (!bank) throw new NotFoundError("Bank account");
  if (bank.openingJournalEntryId) throw new ConflictError("An opening balance is already posted. Use a manual adjustment journal to correct it.");
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, bank.currency, settings.baseCurrency, date);
  const { entry } = await postJournal(tx, actor, {
    entryDate: date,
    memo: `Opening balance — ${bank.name}`,
    sourceType: "opening_balance",
    sourceId: bank.id,
    postingKey: `opening:bank:${bank.id}`,
    currency: bank.currency,
    rate,
    lines: [
      { ledgerAccountId: bank.ledgerAccountId, amount, description: "Opening balance" },
      { systemKey: "opening_balance_equity", amount: d(amount).negated().toString(), description: "Opening balance" },
    ],
  });
  await tx.update(bankAccounts).set({ openingBalance: toMoney(amount), openingBalanceDate: date, openingJournalEntryId: entry.id }).where(eq(bankAccounts.id, bank.id));
  await audit(tx, actor, { action: "bank_account.opening_balance", entityType: "bank_account", entityId: bank.id, summary: `Opening balance ${bank.currency} ${toMoney(amount)} at ${date}` });
}

/** Ledger balance of a bank account in its own currency (Σ txn amounts) up to a date. */
export async function bankLedgerBalance(tx: Tx, bankAccountId: string, asOf?: string) {
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId));
  if (!bank) throw new NotFoundError("Bank account");
  const [r] = await tx
    .select({ native: sql<string>`coalesce(sum(${journalLines.txnAmount}),0)`, base: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}),0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(eq(journalLines.ledgerAccountId, bank.ledgerAccountId), asOf ? lte(journalEntries.entryDate, asOf) : undefined));
  return { bank, native: toMoney(r.native), base: toMoney(r.base) };
}

/* ------------------------------------------------------------------ */
/* Transactions: manual + CSV import with duplicate detection           */
/* ------------------------------------------------------------------ */

export function bankFingerprint(bankAccountId: string, t: { txnDate: string; amount: string; description: string; reference?: string | null }, occurrence = 0) {
  const norm = t.description.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256")
    .update([bankAccountId, t.txnDate, toMoney(t.amount), norm, (t.reference ?? "").trim().toLowerCase(), occurrence].join("|"))
    .digest("hex");
}

export async function addBankTransaction(tx: Tx, actor: Actor, input: { bankAccountId: string; txnDate: string; description: string; amount: string; reference?: string | null; counterparty?: string | null }) {
  assertCan(actor, "finance.write");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId));
  if (!bank) throw new NotFoundError("Bank account");
  if (d(input.amount).isZero()) throw new ValidationError("Amount cannot be zero.");
  const fingerprint = bankFingerprint(bank.id, input);
  const [row] = await tx
    .insert(bankTransactions)
    .values({ bankAccountId: bank.id, txnDate: input.txnDate, description: input.description.trim(), amount: toMoney(input.amount), currency: bank.currency, reference: input.reference || null, counterparty: input.counterparty || null, fingerprint, source: "manual" })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ConflictError("An identical transaction (same date, amount, description and reference) already exists for this account.");
  await audit(tx, actor, { action: "bank_txn.added", entityType: "bank_transaction", entityId: row.id, summary: `${bank.name}: ${row.txnDate} ${row.amount} ${row.description}` });
  return row;
}

export type BankCsvMapping = { date: string; description: string; amount?: string; debit?: string; credit?: string; reference?: string; counterparty?: string; dateFormat?: "yyyy-MM-dd" | "dd/MM/yyyy" | "MM/dd/yyyy" };

function parseDate(v: string, fmt: BankCsvMapping["dateFormat"]): string | null {
  const s = v.trim();
  if (!s) return null;
  if ((fmt ?? "yyyy-MM-dd") === "yyyy-MM-dd") return isISODate(s.slice(0, 10)) ? s.slice(0, 10) : null;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const [a, b, y] = [m[1], m[2], m[3]];
  const [dd, mm] = fmt === "dd/MM/yyyy" ? [a, b] : [b, a];
  const iso = `${y}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  return isISODate(iso) ? iso : null;
}

function parseAmount(v: string | undefined): string | null {
  if (v === undefined) return null;
  let s = v.trim().replace(/[^\d.,()-]/g, "");
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()-]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return toMoney(neg ? `-${s}` : s);
}

/** Step 1: parse the CSV into an import batch for mapping and preview. */
export async function stageBankCsv(tx: Tx, actor: Actor, input: { bankAccountId: string; fileName: string; csv: string }) {
  assertCan(actor, "finance.write");
  const parsed = Papa.parse<Record<string, string>>(input.csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: true });
  if (!parsed.meta.fields?.length) throw new ValidationError("The file has no header row.");
  if (parsed.data.length > 5000) throw new ValidationError("Import at most 5,000 rows at a time.");
  const [batch] = await tx
    .insert(importBatches)
    .values({ kind: "bank_transactions", fileName: input.fileName, status: "uploaded", headers: parsed.meta.fields, context: { bankAccountId: input.bankAccountId }, totalRows: parsed.data.length, createdBy: actor.userId || null })
    .returning();
  if (parsed.data.length) await tx.insert(importRows).values(parsed.data.map((raw, i) => ({ batchId: batch.id, rowNumber: i + 1, raw })));
  return batch;
}

/** Step 2: apply mapping, validate rows, flag duplicates (in DB and within file). */
export async function validateBankImport(tx: Tx, actor: Actor, batchId: string, mapping: BankCsvMapping) {
  assertCan(actor, "finance.write");
  const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId)).for("update");
  if (!batch || batch.kind !== "bank_transactions") throw new NotFoundError("Import");
  if (batch.status === "committed") throw new ValidationError("This import was already committed.");
  const bankAccountId = (batch.context as { bankAccountId: string }).bankAccountId;
  const rows = await tx.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber));
  const seen = new Map<string, number>();
  let valid = 0, errors = 0, dups = 0;
  for (const r of rows) {
    const errs: string[] = [];
    const txnDate = parseDate(r.raw[mapping.date] ?? "", mapping.dateFormat);
    if (!txnDate) errs.push(`Invalid date "${r.raw[mapping.date] ?? ""}"`);
    let amount: string | null = null;
    if (mapping.amount) amount = parseAmount(r.raw[mapping.amount]);
    else {
      const debit = parseAmount(r.raw[mapping.debit ?? ""]);
      const credit = parseAmount(r.raw[mapping.credit ?? ""]);
      amount = credit && !d(credit).isZero() ? toMoney(d(credit).abs()) : debit ? toMoney(d(debit).abs().negated()) : null;
    }
    if (!amount || d(amount).isZero()) errs.push("Missing or zero amount");
    const description = (r.raw[mapping.description] ?? "").trim();
    if (!description) errs.push("Missing description");
    const reference = mapping.reference ? (r.raw[mapping.reference] ?? "").trim() || null : null;
    const counterparty = mapping.counterparty ? (r.raw[mapping.counterparty] ?? "").trim() || null : null;
    let duplicates: { type: string; id: string; label: string; reason: string }[] = [];
    let fingerprint: string | null = null;
    if (!errs.length) {
      const base = bankFingerprint(bankAccountId, { txnDate: txnDate!, amount: amount!, description, reference });
      const occ = seen.get(base) ?? 0;
      seen.set(base, occ + 1);
      fingerprint = bankFingerprint(bankAccountId, { txnDate: txnDate!, amount: amount!, description, reference }, occ);
      const [existing] = await tx.select().from(bankTransactions).where(and(eq(bankTransactions.bankAccountId, bankAccountId), eq(bankTransactions.fingerprint, fingerprint)));
      if (existing) duplicates = [{ type: "bank_transaction", id: existing.id, label: `${existing.txnDate} ${existing.amount} ${existing.description}`, reason: "Already imported" }];
      else if (occ > 0) duplicates = [{ type: "file", id: "", label: `Row repeats an earlier row in this file`, reason: "Repeated in file (imported as a separate transaction unless skipped)" }];
    }
    const isDup = duplicates.some((x) => x.type === "bank_transaction");
    if (errs.length) errors++;
    else if (isDup) dups++;
    else valid++;
    await tx
      .update(importRows)
      .set({ normalized: errs.length ? null : { txnDate, amount, description, reference, counterparty, fingerprint }, errors: errs, duplicates, decision: errs.length || isDup ? "skip" : "import" })
      .where(eq(importRows.id, r.id));
  }
  const [updated] = await tx
    .update(importBatches)
    .set({ mapping: mapping as unknown as Record<string, string>, status: "validated", validRows: valid, errorRows: errors, duplicateRows: dups })
    .where(eq(importBatches.id, batchId))
    .returning();
  return updated;
}

/** Step 3: commit rows marked "import". Duplicate fingerprints are skipped by the unique index. */
export async function commitBankImport(tx: Tx, actor: Actor, batchId: string) {
  assertCan(actor, "finance.write");
  const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId)).for("update");
  if (!batch) throw new NotFoundError("Import");
  if (batch.status === "committed") throw new ConflictError("This import was already committed.");
  if (batch.status !== "validated") throw new ValidationError("Map and validate the file first.");
  const bankAccountId = (batch.context as { bankAccountId: string }).bankAccountId;
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, bankAccountId));
  const rows = await tx.select().from(importRows).where(and(eq(importRows.batchId, batchId), eq(importRows.decision, "import")));
  let imported = 0;
  for (const r of rows) {
    const n = r.normalized as { txnDate: string; amount: string; description: string; reference: string | null; counterparty: string | null; fingerprint: string };
    if (!n) continue;
    const [row] = await tx
      .insert(bankTransactions)
      .values({ bankAccountId, txnDate: n.txnDate, amount: n.amount, description: n.description, reference: n.reference, counterparty: n.counterparty, currency: bank.currency, fingerprint: n.fingerprint, source: "csv", importBatchId: batchId })
      .onConflictDoNothing()
      .returning({ id: bankTransactions.id });
    if (row) {
      imported++;
      await tx.update(importRows).set({ resultEntityId: row.id }).where(eq(importRows.id, r.id));
    }
  }
  await tx.update(importBatches).set({ status: "committed", importedRows: imported, committedAt: new Date() }).where(eq(importBatches.id, batchId));
  await audit(tx, actor, { action: "bank_import.committed", entityType: "import_batch", entityId: batchId, summary: `Imported ${imported} transactions into ${bank.name}` });
  return imported;
}

/* ------------------------------------------------------------------ */
/* Matching (never posts — prevents double counting)                    */
/* ------------------------------------------------------------------ */

export type MatchCandidate = { type: BankMatchType; id: string; label: string; date: string; amount: string; score: number };

export async function suggestMatches(tx: Tx, txnId: string): Promise<MatchCandidate[]> {
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId));
  if (!t) throw new NotFoundError("Transaction");
  const from = addDaysISO(t.txnDate, -10);
  const to = addDaysISO(t.txnDate, 10);
  const amt = d(t.amount);
  const out: MatchCandidate[] = [];
  const matchedIds = async (type: BankMatchType) =>
    new Set((await tx.select({ id: bankTransactions.matchId }).from(bankTransactions).where(eq(bankTransactions.matchType, type))).map((r) => r.id));
  const score = (date: string, ref?: string | null) => 100 - Math.abs(Date.parse(date) - Date.parse(t.txnDate)) / 86400000 + (ref && t.description.toLowerCase().includes(ref.toLowerCase()) ? 20 : 0);
  if (amt.isPositive()) {
    const used = await matchedIds("customer_payment");
    const ps = await tx
      .select()
      .from(customerPayments)
      .where(and(eq(customerPayments.bankAccountId, t.bankAccountId), eq(customerPayments.status, "recorded"), eq(customerPayments.amount, toMoney(amt)), gte(customerPayments.paymentDate, from), lte(customerPayments.paymentDate, to)));
    for (const p of ps) if (!used.has(p.id)) out.push({ type: "customer_payment", id: p.id, label: `${p.number}${p.reference ? ` · ${p.reference}` : ""}`, date: p.paymentDate, amount: p.amount, score: score(p.paymentDate, p.reference) });
  } else {
    const abs = toMoney(amt.abs());
    const usedS = await matchedIds("supplier_payment");
    const sps = await tx
      .select()
      .from(supplierPayments)
      .where(and(eq(supplierPayments.bankAccountId, t.bankAccountId), eq(supplierPayments.status, "recorded"), eq(supplierPayments.amount, abs), gte(supplierPayments.paymentDate, from), lte(supplierPayments.paymentDate, to)));
    for (const p of sps) if (!usedS.has(p.id)) out.push({ type: "supplier_payment", id: p.id, label: `${p.number}${p.reference ? ` · ${p.reference}` : ""}`, date: p.paymentDate, amount: p.amount, score: score(p.paymentDate, p.reference) });
    const usedE = await matchedIds("expense");
    const es = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.bankAccountId, t.bankAccountId), eq(expenses.paidFrom, "company"), inArray(expenses.status, ["approved"]), sql`${expenses.amount} + ${expenses.taxAmount} = ${abs}`, gte(expenses.expenseDate, from), lte(expenses.expenseDate, to)));
    for (const e of es) if (!usedE.has(e.id)) out.push({ type: "expense", id: e.id, label: `${e.number} · ${e.description}`, date: e.expenseDate, amount: toMoney(d(e.amount).plus(d(e.taxAmount))), score: score(e.expenseDate) });
    const usedR = await matchedIds("expense_reimbursement");
    const rs = await tx.select().from(expenses).where(and(eq(expenses.bankAccountId, t.bankAccountId), eq(expenses.status, "reimbursed"), sql`${expenses.amount} + ${expenses.taxAmount} = ${abs}`));
    for (const e of rs) if (!usedR.has(e.id)) out.push({ type: "expense_reimbursement", id: e.id, label: `Reimbursement ${e.number}`, date: e.expenseDate, amount: abs, score: score(e.expenseDate) - 5 });
  }
  const usedT = await matchedIds("bank_transfer");
  const trs = await tx.select().from(bankTransfers).where(and(eq(bankTransfers.amount, toMoney(amt.abs())), gte(bankTransfers.transferDate, from), lte(bankTransfers.transferDate, to)));
  for (const tr of trs) {
    const relevant = amt.isPositive() ? tr.toBankAccountId === t.bankAccountId : tr.fromBankAccountId === t.bankAccountId;
    if (relevant && !usedT.has(tr.id)) out.push({ type: "bank_transfer", id: tr.id, label: `Transfer ${tr.memo ?? ""}`.trim(), date: tr.transferDate, amount: tr.amount, score: score(tr.transferDate) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Link a statement line to an existing record that already posted to the
 * same bank ledger account. No journal is created, so nothing is counted twice.
 */
export async function matchBankTransaction(tx: Tx, actor: Actor, txnId: string, type: BankMatchType, matchId: string) {
  assertCan(actor, "finance.write");
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).for("update");
  if (!t) throw new NotFoundError("Transaction");
  if (t.status !== "unreconciled") throw new ValidationError(`This transaction is already ${t.status}.`);
  const candidates = await suggestMatches(tx, txnId);
  const ok = candidates.find((c) => c.type === type && c.id === matchId);
  if (!ok && type !== "journal") throw new ValidationError("That record does not match this transaction's account, amount and date window, or is already matched.");
  try {
    await tx.update(bankTransactions).set({ status: "matched", matchType: type, matchId, matchedBy: actor.userId || null, matchedAt: new Date() }).where(eq(bankTransactions.id, txnId));
  } catch (err) {
    throw new ConflictError("That record is already matched to another bank transaction.");
  }
  await audit(tx, actor, { action: "bank_txn.matched", entityType: "bank_transaction", entityId: txnId, summary: `Matched to ${type} ${ok?.label ?? matchId}` });
}

export async function unmatchBankTransaction(tx: Tx, actor: Actor, txnId: string) {
  assertCan(actor, "finance.write");
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).for("update");
  if (!t) throw new NotFoundError("Transaction");
  if (t.status === "reconciled") throw new ValidationError("Reconciled transactions cannot be unmatched; reopen the reconciliation first.");
  if (t.matchType === "journal") throw new ValidationError("This line created its own journal entry; reverse that journal instead.");
  await tx.update(bankTransactions).set({ status: "unreconciled", matchType: null, matchId: null, matchedAt: null, matchedBy: null }).where(eq(bankTransactions.id, txnId));
  await audit(tx, actor, { action: "bank_txn.unmatched", entityType: "bank_transaction", entityId: txnId, summary: `Unmatched` });
}

/** Create a customer payment from an inflow, then match it. */
export async function createPaymentFromTransaction(tx: Tx, actor: Actor, txnId: string, input: { accountId: string; allocations?: { invoiceId: string; amount: string }[] }) {
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).for("update");
  if (!t || t.status !== "unreconciled") throw new ValidationError("Transaction is not open for matching.");
  if (!d(t.amount).isPositive()) throw new ValidationError("Only money in can become a customer payment.");
  const pay = await recordCustomerPayment(tx, actor, { accountId: input.accountId, paymentDate: t.txnDate, amount: t.amount, currency: t.currency, method: "bank_transfer", reference: t.reference ?? t.description, bankAccountId: t.bankAccountId, evidenceNote: `Bank statement line ${t.txnDate}: ${t.description}`, allocations: input.allocations });
  await tx.update(bankTransactions).set({ status: "matched", matchType: "customer_payment", matchId: pay.id, matchedBy: actor.userId || null, matchedAt: new Date() }).where(eq(bankTransactions.id, txnId));
  return pay;
}

/** Create and approve a company-paid expense from an outflow, then match it. */
export async function createExpenseFromTransaction(tx: Tx, actor: Actor, txnId: string, input: { categoryId: string; description?: string | null; engagementId?: string | null }) {
  assertCan(actor, "finance.post");
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).for("update");
  if (!t || t.status !== "unreconciled") throw new ValidationError("Transaction is not open for matching.");
  if (!d(t.amount).isNegative()) throw new ValidationError("Only money out can become an expense.");
  const exp = await submitExpense(tx, actor, { expenseDate: t.txnDate, description: input.description || t.description, categoryId: input.categoryId, amount: toMoney(d(t.amount).abs()), currency: t.currency, paidFrom: "company", bankAccountId: t.bankAccountId, engagementId: input.engagementId });
  // Bank-originated: the money has already left the account; the finance user
  // categorising the statement line records the approval.
  await approveExpense(tx, actor, exp.id, { bankOriginated: true });
  await tx.update(bankTransactions).set({ status: "matched", matchType: "expense", matchId: exp.id, matchedBy: actor.userId || null, matchedAt: new Date() }).where(eq(bankTransactions.id, txnId));
  return exp;
}

/** Post a line directly against a ledger account (bank fees, interest, owner funding). */
export async function postTransactionToAccount(tx: Tx, actor: Actor, txnId: string, input: { ledgerAccountId: string; memo?: string | null }) {
  assertCan(actor, "finance.post");
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId)).for("update");
  if (!t || t.status !== "unreconciled") throw new ValidationError("Transaction is not open for matching.");
  const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, t.bankAccountId));
  const [acc] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.id, input.ledgerAccountId));
  if (!acc) throw new NotFoundError("Ledger account");
  if (acc.subtype === "bank" || ["receivable", "payable", "customer_credit"].includes(acc.subtype)) {
    throw new ValidationError("Use payments, bills or transfers for this account type so subledgers stay correct.");
  }
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, t.currency, settings.baseCurrency, t.txnDate);
  const { entry } = await postJournal(tx, actor, {
    entryDate: t.txnDate,
    memo: input.memo || t.description,
    sourceType: "bank_transaction",
    sourceId: t.id,
    postingKey: `bank_txn:${t.id}`,
    currency: t.currency,
    rate,
    lines: [
      { ledgerAccountId: bank.ledgerAccountId, amount: t.amount, description: t.description },
      { ledgerAccountId: acc.id, amount: d(t.amount).negated().toString(), description: t.description },
    ],
  });
  await tx.update(bankTransactions).set({ status: "matched", matchType: "journal", matchId: entry.id, matchedBy: actor.userId || null, matchedAt: new Date() }).where(eq(bankTransactions.id, txnId));
  await audit(tx, actor, { action: "bank_txn.posted", entityType: "bank_transaction", entityId: txnId, summary: `Posted to ${acc.code} ${acc.name}` });
}

export async function excludeBankTransaction(tx: Tx, actor: Actor, txnId: string, reason: string) {
  assertCan(actor, "finance.write");
  if (!reason.trim()) throw new ValidationError("Give a reason (e.g. duplicate line on statement).");
  const [t] = await tx.select().from(bankTransactions).where(eq(bankTransactions.id, txnId));
  if (!t || t.status !== "unreconciled") throw new ValidationError("Only unreconciled lines can be excluded.");
  await tx.update(bankTransactions).set({ status: "excluded", excludedReason: reason }).where(eq(bankTransactions.id, txnId));
  await audit(tx, actor, { action: "bank_txn.excluded", entityType: "bank_transaction", entityId: txnId, summary: `Excluded: ${reason}` });
}

/* ------------------------------------------------------------------ */
/* Transfers & reconciliation                                           */
/* ------------------------------------------------------------------ */

export async function createTransfer(tx: Tx, actor: Actor, input: { fromBankAccountId: string; toBankAccountId: string; transferDate: string; amount: string; memo?: string | null }) {
  assertCan(actor, "finance.post");
  if (input.fromBankAccountId === input.toBankAccountId) throw new ValidationError("Choose two different accounts.");
  const [from] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.fromBankAccountId));
  const [to] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, input.toBankAccountId));
  if (!from || !to) throw new NotFoundError("Bank account");
  if (from.currency !== to.currency) throw new ValidationError("Cross-currency transfers are not supported yet; record them as two manual journals with the bank's rate.");
  if (d(input.amount).lessThanOrEqualTo(0)) throw new ValidationError("Amount must be positive.");
  const settings = await getSettings(tx);
  const { rate } = await getRate(tx, from.currency, settings.baseCurrency, input.transferDate);
  const [tr] = await tx.insert(bankTransfers).values({ fromBankAccountId: from.id, toBankAccountId: to.id, transferDate: input.transferDate, amount: toMoney(input.amount), currency: from.currency, memo: input.memo || null, createdBy: actor.userId || null }).returning();
  const { entry } = await postJournal(tx, actor, {
    entryDate: input.transferDate,
    memo: `Transfer ${from.name} → ${to.name}`,
    sourceType: "bank_transfer",
    sourceId: tr.id,
    postingKey: `transfer:${tr.id}`,
    currency: from.currency,
    rate,
    lines: [
      { ledgerAccountId: to.ledgerAccountId, amount: input.amount },
      { ledgerAccountId: from.ledgerAccountId, amount: d(input.amount).negated().toString() },
    ],
  });
  await tx.update(bankTransfers).set({ journalEntryId: entry.id }).where(eq(bankTransfers.id, tr.id));
  await audit(tx, actor, { action: "bank_transfer.created", entityType: "bank_transfer", entityId: tr.id, summary: `Transfer ${from.currency} ${tr.amount} ${from.name} → ${to.name}` });
  return tr;
}

/**
 * Reconcile: compares the statement balance with the ledger balance at the
 * statement date. Completing marks matched lines up to that date reconciled.
 * A non-zero difference blocks completion.
 */
export async function reconcileBankAccount(tx: Tx, actor: Actor, input: { bankAccountId: string; statementDate: string; statementBalance: string; complete: boolean }) {
  assertCan(actor, "finance.post");
  const { native } = await bankLedgerBalance(tx, input.bankAccountId, input.statementDate);
  const difference = toMoney(d(input.statementBalance).minus(d(native)));
  const unmatched = await tx
    .select({ n: sql<number>`count(*)` })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.bankAccountId, input.bankAccountId), eq(bankTransactions.status, "unreconciled"), lte(bankTransactions.txnDate, input.statementDate)));
  const [rec] = await tx
    .insert(reconciliations)
    .values({ bankAccountId: input.bankAccountId, statementDate: input.statementDate, statementBalance: toMoney(input.statementBalance), ledgerBalance: native, difference, status: "in_progress" })
    .returning();
  if (input.complete) {
    if (!d(difference).isZero()) throw new ValidationError(`Statement balance differs from the ledger by ${difference}. Match or post the missing transactions first.`);
    if (Number(unmatched[0].n) > 0) throw new ValidationError(`${unmatched[0].n} statement lines up to ${input.statementDate} are still unmatched.`);
    await tx
      .update(bankTransactions)
      .set({ status: "reconciled", reconciliationId: rec.id })
      .where(and(eq(bankTransactions.bankAccountId, input.bankAccountId), eq(bankTransactions.status, "matched"), lte(bankTransactions.txnDate, input.statementDate)));
    await tx.update(reconciliations).set({ status: "completed", completedBy: actor.userId || null, completedAt: new Date() }).where(eq(reconciliations.id, rec.id));
    await audit(tx, actor, { action: "bank.reconciled", entityType: "bank_account", entityId: input.bankAccountId, summary: `Reconciled to ${input.statementDate} at ${input.statementBalance}` });
  }
  return { ...rec, difference, unmatched: Number(unmatched[0].n) };
}

export async function listBankTransactions(tx: Tx, bankAccountId: string | null, status?: string) {
  return tx
    .select()
    .from(bankTransactions)
    .where(and(bankAccountId ? eq(bankTransactions.bankAccountId, bankAccountId) : undefined, status ? eq(bankTransactions.status, status as "unreconciled") : undefined))
    .orderBy(desc(bankTransactions.txnDate))
    .limit(500);
}

export async function unreconciledCount(tx: Tx) {
  const [r] = await tx.select({ n: sql<number>`count(*)` }).from(bankTransactions).where(and(eq(bankTransactions.status, "unreconciled"), isNull(bankTransactions.matchId)));
  return Number(r.n);
}

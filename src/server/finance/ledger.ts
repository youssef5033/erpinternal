import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accountingPeriods, exchangeRates, journalEntries, journalLines, ledgerAccounts, services, type JournalSource } from "@/db/schema";
import { d, Decimal, toMoney, type MoneyInput } from "@/lib/money";
import { assertCan, isSystem, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { getSettings } from "../system/settings";

/* ------------------------------------------------------------------ */
/* Exchange rates                                                      */
/* ------------------------------------------------------------------ */

/**
 * Rate to convert 1 unit of `from` into `to` on `date`, using the latest
 * recorded rate on or before that date (or the inverse pair). Throws when no
 * rate exists: we never total currencies without an explicit conversion.
 */
export async function getRate(tx: Tx, from: string, to: string, date: string): Promise<{ rate: string; rateDate: string | null }> {
  if (from === to) return { rate: "1", rateDate: null };
  const [direct] = await tx
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.fromCurrency, from), eq(exchangeRates.toCurrency, to), lte(exchangeRates.rateDate, date)))
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  const [inverse] = await tx
    .select()
    .from(exchangeRates)
    .where(and(eq(exchangeRates.fromCurrency, to), eq(exchangeRates.toCurrency, from), lte(exchangeRates.rateDate, date)))
    .orderBy(desc(exchangeRates.rateDate))
    .limit(1);
  const pick = direct && (!inverse || direct.rateDate >= inverse.rateDate) ? { rate: d(direct.rate), date: direct.rateDate } : inverse ? { rate: new Decimal(1).div(d(inverse.rate)), date: inverse.rateDate } : null;
  if (!pick) throw new ValidationError(`No ${from}→${to} exchange rate on or before ${date}. Add one in Finance › Exchange rates.`);
  return { rate: pick.rate.toDecimalPlaces(10).toString(), rateDate: pick.date };
}

export async function toBase(tx: Tx, amount: MoneyInput, currency: string, date: string) {
  const s = await getSettings(tx);
  const { rate, rateDate } = await getRate(tx, currency, s.baseCurrency, date);
  return { amount: toMoney(d(amount).times(d(rate))), rate, rateDate, baseCurrency: s.baseCurrency };
}

export async function addExchangeRate(tx: Tx, actor: Actor, input: { rateDate: string; fromCurrency: string; toCurrency: string; rate: string }) {
  assertCan(actor, "finance.write");
  if (d(input.rate).lessThanOrEqualTo(0)) throw new ValidationError("Rate must be positive.");
  if (input.fromCurrency === input.toCurrency) throw new ValidationError("Choose two different currencies.");
  const [row] = await tx
    .insert(exchangeRates)
    .values({ rateDate: input.rateDate, fromCurrency: input.fromCurrency.toUpperCase(), toCurrency: input.toCurrency.toUpperCase(), rate: d(input.rate).toString(), createdBy: actor.userId || null })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ConflictError("A rate for this pair and date already exists. Historical rates are not overwritten.");
  await audit(tx, actor, { action: "fx.rate_added", entityType: "exchange_rate", entityId: row.id, summary: `${row.fromCurrency}→${row.toCurrency} ${row.rate} on ${row.rateDate}` });
  return row;
}

/* ------------------------------------------------------------------ */
/* Ledger accounts                                                     */
/* ------------------------------------------------------------------ */

export async function ledgerAccountByKey(tx: Tx, systemKey: string) {
  const [row] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.systemKey, systemKey));
  if (!row) throw new ValidationError(`Ledger account "${systemKey}" is missing from the chart of accounts.`);
  return row;
}

/** Revenue ledger account for a service stream (falls back to Other income). */
export async function revenueAccountForService(tx: Tx, serviceId: string | null | undefined) {
  if (serviceId) {
    const [byService] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.serviceId, serviceId), eq(ledgerAccounts.type, "income"), eq(ledgerAccounts.active, true))).limit(1);
    if (byService) return byService;
    const [svc] = await tx.select().from(services).where(eq(services.id, serviceId));
    if (svc) {
      const [byKey] = await tx.select().from(ledgerAccounts).where(eq(ledgerAccounts.systemKey, `revenue_${svc.templateKind}`));
      if (byKey) return byKey;
    }
  }
  return ledgerAccountByKey(tx, "revenue_other");
}

/* ------------------------------------------------------------------ */
/* Posting                                                             */
/* ------------------------------------------------------------------ */

export type PostingLine = {
  ledgerAccountId?: string;
  systemKey?: string;
  /** Amount in the transaction currency; positive = debit, negative = credit. */
  amount: MoneyInput;
  description?: string | null;
  accountId?: string | null;
  supplierId?: string | null;
  engagementId?: string | null;
  serviceId?: string | null;
  /** Override rate for this line (e.g. settlement at a different rate). */
  rate?: string;
  currency?: string;
};

export type PostingInput = {
  entryDate: string;
  memo: string;
  sourceType: JournalSource;
  sourceId?: string | null;
  /** Unique key for this economic event — the same key can never post twice. */
  postingKey: string;
  currency: string;
  rate: string;
  lines: PostingLine[];
  reversalOfId?: string | null;
};

async function assertPeriodOpen(tx: Tx, date: string) {
  const [locked] = await tx
    .select()
    .from(accountingPeriods)
    .where(and(eq(accountingPeriods.status, "locked"), lte(accountingPeriods.periodStart, date), gte(accountingPeriods.periodEnd, date)))
    .limit(1);
  if (locked) throw new ValidationError(`The accounting period ${locked.periodStart} – ${locked.periodEnd} is locked. Post in an open period or ask Finance to reopen it.`);
}

/**
 * Post a balanced journal entry in base currency. Lines are converted at the
 * given rate and rounded to cents; any rounding residue (≤ a few cents) is
 * posted to the FX gain/loss account so the entry always balances exactly.
 * Idempotent per postingKey: a repeated call returns the existing entry.
 */
export async function postJournal(tx: Tx, actor: Actor, input: PostingInput): Promise<{ entry: typeof journalEntries.$inferSelect; created: boolean }> {
  const [existing] = await tx.select().from(journalEntries).where(eq(journalEntries.postingKey, input.postingKey));
  if (existing) return { entry: existing, created: false };
  await assertPeriodOpen(tx, input.entryDate);
  const settings = await getSettings(tx);
  const lines = input.lines.filter((l) => !d(l.amount).isZero());
  if (lines.length < 2) throw new ValidationError("A journal entry needs at least two non-zero lines.");
  const txnSum = lines.reduce((a, l) => (l.currency && l.currency !== input.currency ? a : a.plus(d(l.amount))), new Decimal(0));
  if (!lines.some((l) => l.rate || l.currency) && !txnSum.isZero()) {
    throw new ValidationError(`Journal lines do not balance in ${input.currency} (difference ${txnSum.toFixed(2)}).`);
  }
  const resolved: (typeof journalLines.$inferInsert)[] = [];
  const keyCache = new Map<string, string>();
  for (const [i, l] of lines.entries()) {
    let ledgerAccountId = l.ledgerAccountId;
    if (!ledgerAccountId && l.systemKey) {
      ledgerAccountId = keyCache.get(l.systemKey) ?? (await ledgerAccountByKey(tx, l.systemKey)).id;
      keyCache.set(l.systemKey, ledgerAccountId);
    }
    if (!ledgerAccountId) throw new ValidationError("Every journal line needs a ledger account.");
    const rate = l.rate ?? input.rate;
    const base = d(toMoney(d(l.amount).times(d(rate))));
    resolved.push({
      entryId: "",
      ledgerAccountId,
      debit: base.isPositive() ? base.toFixed(2) : "0",
      credit: base.isNegative() ? base.abs().toFixed(2) : "0",
      txnCurrency: l.currency ?? input.currency,
      txnAmount: toMoney(l.amount),
      exchangeRate: rate,
      description: l.description ?? null,
      accountId: l.accountId ?? null,
      supplierId: l.supplierId ?? null,
      engagementId: l.engagementId ?? null,
      serviceId: l.serviceId ?? null,
      lineOrder: i,
    });
  }
  const debits = resolved.reduce((a, r) => a.plus(d(r.debit)), new Decimal(0));
  const credits = resolved.reduce((a, r) => a.plus(d(r.credit)), new Decimal(0));
  const residue = debits.minus(credits);
  if (!residue.isZero()) {
    const fx = await ledgerAccountByKey(tx, "fx_gain_loss");
    resolved.push({
      entryId: "",
      ledgerAccountId: fx.id,
      debit: residue.isNegative() ? residue.abs().toFixed(2) : "0",
      credit: residue.isPositive() ? residue.toFixed(2) : "0",
      txnCurrency: settings.baseCurrency,
      txnAmount: toMoney(residue.negated()),
      exchangeRate: "1",
      description: "Currency conversion difference",
      lineOrder: resolved.length,
    });
  }
  const number = await nextNumber(tx, "journal");
  const inserted = await tx
    .insert(journalEntries)
    .values({
      number,
      entryDate: input.entryDate,
      memo: input.memo,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      postingKey: input.postingKey,
      reversalOfId: input.reversalOfId ?? null,
      baseCurrency: settings.baseCurrency,
      createdBy: isSystem(actor) || !actor.userId ? null : actor.userId,
    })
    .onConflictDoNothing({ target: journalEntries.postingKey })
    .returning();
  if (!inserted.length) {
    const [again] = await tx.select().from(journalEntries).where(eq(journalEntries.postingKey, input.postingKey));
    return { entry: again, created: false };
  }
  const entry = inserted[0];
  await tx.insert(journalLines).values(resolved.map((r) => ({ ...r, entryId: entry.id })));
  return { entry, created: true };
}

/** Post an exact mirror of an entry and link both. Never edits the original lines. */
export async function reverseJournal(tx: Tx, actor: Actor, entryId: string, input: { entryDate: string; memo: string; postingKey?: string }) {
  const [orig] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entryId)).for("update");
  if (!orig) throw new NotFoundError("Journal entry");
  if (orig.reversedById) {
    const [rev] = await tx.select().from(journalEntries).where(eq(journalEntries.id, orig.reversedById));
    return rev;
  }
  await assertPeriodOpen(tx, input.entryDate);
  const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId));
  const number = await nextNumber(tx, "journal");
  const [rev] = await tx
    .insert(journalEntries)
    .values({
      number,
      entryDate: input.entryDate,
      memo: input.memo,
      sourceType: "reversal",
      sourceId: orig.sourceId,
      postingKey: input.postingKey ?? `reversal:${orig.id}`,
      reversalOfId: orig.id,
      baseCurrency: orig.baseCurrency,
      createdBy: isSystem(actor) || !actor.userId ? null : actor.userId,
    })
    .returning();
  await tx.insert(journalLines).values(
    lines.map((l) => ({
      entryId: rev.id,
      ledgerAccountId: l.ledgerAccountId,
      debit: l.credit,
      credit: l.debit,
      txnCurrency: l.txnCurrency,
      txnAmount: toMoney(d(l.txnAmount).negated()),
      exchangeRate: l.exchangeRate,
      description: `Reversal: ${l.description ?? ""}`.trim(),
      accountId: l.accountId,
      supplierId: l.supplierId,
      engagementId: l.engagementId,
      serviceId: l.serviceId,
      lineOrder: l.lineOrder,
    })),
  );
  await tx.update(journalEntries).set({ reversedById: rev.id }).where(eq(journalEntries.id, orig.id));
  return rev;
}

/** Manual journal (adjustments, opening balances) — requires finance.post. */
export async function postManualJournal(
  tx: Tx,
  actor: Actor,
  input: { entryDate: string; memo: string; currency: string; lines: { ledgerAccountId: string; debit?: string; credit?: string; description?: string; engagementId?: string | null }[]; kind?: "manual" | "opening_balance"; submissionKey?: string | null },
) {
  assertCan(actor, input.kind === "opening_balance" ? "finance.admin" : "finance.post");
  if (!input.memo.trim()) throw new ValidationError("A memo explaining the entry is required.");
  const { rate } = await getRate(tx, input.currency, (await getSettings(tx)).baseCurrency, input.entryDate);
  const lines = input.lines.map((l) => {
    const dr = d(l.debit);
    const cr = d(l.credit);
    if (dr.isNegative() || cr.isNegative()) throw new ValidationError("Use positive debit or credit amounts.");
    if (!dr.isZero() && !cr.isZero()) throw new ValidationError("A line cannot have both a debit and a credit.");
    return { ledgerAccountId: l.ledgerAccountId, amount: dr.minus(cr).toString(), description: l.description, engagementId: l.engagementId ?? null };
  });
  const { entry } = await postJournal(tx, actor, {
    entryDate: input.entryDate,
    memo: input.memo,
    sourceType: input.kind ?? "manual",
    postingKey: `${input.kind ?? "manual"}:${input.submissionKey ?? crypto.randomUUID()}`,
    currency: input.currency,
    rate,
    lines,
  });
  await audit(tx, actor, { action: "journal.posted", entityType: "journal_entry", entityId: entry.id, summary: `${entry.number}: ${input.memo}` });
  return entry;
}

export async function reverseManualJournal(tx: Tx, actor: Actor, entryId: string, entryDate: string, reason: string) {
  assertCan(actor, "finance.post");
  const [orig] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entryId));
  if (!orig) throw new NotFoundError("Journal entry");
  if (!["manual", "opening_balance"].includes(orig.sourceType)) {
    throw new ValidationError("This entry was posted by a source document. Correct it from the document (void, credit note, reversal) so the records stay linked.");
  }
  if (!reason.trim()) throw new ValidationError("Give a reason for the reversal.");
  const rev = await reverseJournal(tx, actor, entryId, { entryDate, memo: `Reversal of ${orig.number}: ${reason}` });
  await audit(tx, actor, { action: "journal.reversed", entityType: "journal_entry", entityId: entryId, summary: `${orig.number} reversed by ${rev.number}: ${reason}` });
  return rev;
}

export async function lockPeriod(tx: Tx, actor: Actor, periodStart: string, periodEnd: string, lock: boolean, note?: string | null) {
  assertCan(actor, "finance.admin");
  const [row] = await tx
    .insert(accountingPeriods)
    .values({ periodStart, periodEnd, status: lock ? "locked" : "open", lockedBy: lock ? actor.userId || null : null, lockedAt: lock ? new Date() : null, note: note || null })
    .onConflictDoUpdate({ target: accountingPeriods.periodStart, set: { status: lock ? "locked" : "open", periodEnd, lockedBy: lock ? actor.userId || null : null, lockedAt: lock ? new Date() : null, note: note || null } })
    .returning();
  await audit(tx, actor, { action: lock ? "period.locked" : "period.reopened", entityType: "accounting_period", entityId: row.id, summary: `${lock ? "Locked" : "Reopened"} ${periodStart} – ${periodEnd}` });
  return row;
}

/** Ledger balances (base currency) per account up to a date, optionally from a date. */
export async function accountBalances(tx: Tx, opts: { to: string; from?: string; accountIds?: string[] }) {
  const conds = [lte(journalEntries.entryDate, opts.to)];
  if (opts.from) conds.push(gte(journalEntries.entryDate, opts.from));
  if (opts.accountIds?.length) conds.push(inArray(journalLines.ledgerAccountId, opts.accountIds));
  return tx
    .select({
      ledgerAccountId: journalLines.ledgerAccountId,
      debit: sql<string>`coalesce(sum(${journalLines.debit}),0)`,
      credit: sql<string>`coalesce(sum(${journalLines.credit}),0)`,
      txnAmount: sql<string>`coalesce(sum(${journalLines.txnAmount}),0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conds))
    .groupBy(journalLines.ledgerAccountId);
}

export async function entriesForSource(tx: Tx, sourceType: JournalSource | JournalSource[], sourceId: string) {
  const types = Array.isArray(sourceType) ? sourceType : [sourceType];
  return tx
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.sourceId, sourceId), or(inArray(journalEntries.sourceType, types), eq(journalEntries.sourceType, "reversal"))))
    .orderBy(journalEntries.postedAt);
}

import Link from "next/link";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, bankAccounts, bankTransactions, reconciliations } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { bankLedgerBalance, suggestMatches } from "@/server/finance/bank";
import { agencyToday } from "@/server/system/settings";
import { addBankTransactionAction, bankMatchAction, createBankAccountAction, reconcileAction, stageBankImportAction, transferAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { financeLookups } from "@/components/finance/lookups";
import { cn, qs } from "@/lib/utils";

export const metadata = { title: "Bank & spending" };

const MATCH_LABEL: Record<string, string> = { customer_payment: "Customer payment", supplier_payment: "Supplier payment", expense: "Expense", bank_transfer: "Transfer", journal: "Journal", expense_reimbursement: "Reimbursement" };

export default async function BankPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const today = await agencyToday(db);
  const banks = await db.select().from(bankAccounts).orderBy(asc(bankAccounts.name));
  const canWrite = can(actor, "finance.write");
  const canPost = can(actor, "finance.post");
  const canAdmin = can(actor, "finance.admin");
  if (!banks.length) {
    return (
      <>
        <PageHeader crumbs={[{ label: "Finance" }, { label: "Bank & spending" }]} title="Bank & spending" />
        <Notice className="mb-4">No bank accounts yet. Live bank connections are not set up — statements are added manually or by CSV import.</Notice>
        {canAdmin ? <NewBankAccount /> : null}
      </>
    );
  }
  const counts = (await db.execute<{ bank_account_id: string; open: number }>(sql`select bank_account_id, count(*)::int as open from bank_transactions where status = 'unreconciled' and match_id is null group by bank_account_id`)).rows;
  const busiest = [...counts].sort((a, b) => b.open - a.open)[0]?.bank_account_id;
  const selected = banks.find((b) => b.id === sp.account) ?? banks.find((b) => b.id === busiest) ?? banks[0];
  const balances = await Promise.all(banks.map(async (b) => ({ id: b.id, ...(await bankLedgerBalance(db, b.id)) })));
  const lastRec = (await db.execute<{ bank_account_id: string; statement_date: string; difference: string | null; status: string }>(sql`select distinct on (bank_account_id) bank_account_id, statement_date::text, difference::text, status from reconciliations order by bank_account_id, statement_date desc, created_at desc`)).rows;
  const status = sp.status ?? "open";
  const txns = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.bankAccountId, selected.id), status === "open" ? and(eq(bankTransactions.status, "unreconciled"), isNull(bankTransactions.matchId)) : status === "all" ? undefined : eq(bankTransactions.status, status as "matched")))
    .orderBy(desc(bankTransactions.txnDate))
    .limit(200);
  const L = canWrite ? await financeLookups() : null;
  const accts = canWrite ? await db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(isNull(accounts.archivedAt)).orderBy(accounts.name) : [];
  const suggestions = new Map<string, Awaited<ReturnType<typeof suggestMatches>>>();
  if (canWrite) for (const t of txns.filter((x) => x.status === "unreconciled" && !x.matchId).slice(0, 25)) suggestions.set(t.id, await suggestMatches(db, t.id));
  const recs = await db.select().from(reconciliations).where(eq(reconciliations.bankAccountId, selected.id)).orderBy(desc(reconciliations.statementDate)).limit(6);
  const selBal = balances.find((b) => b.id === selected.id)!;
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Bank & spending" }]} title="Bank & spending" description="Statement lines are matched to payments, bills and expenses that already posted (matching never posts twice), or turned into new records. No live bank connection is configured; statements arrive by CSV or manual entry." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {banks.map((b) => {
          const bal = balances.find((x) => x.id === b.id)!;
          const open = counts.find((c) => c.bank_account_id === b.id)?.open ?? 0;
          const rec = lastRec.find((r) => r.bank_account_id === b.id);
          return (
            <Link key={b.id} href={`/finance/bank${qs({ account: b.id })}`} className={cn("rounded-[var(--radius-card)] border bg-surface p-3.5 hover:border-line-strong", b.id === selected.id ? "border-accent ring-1 ring-accent" : "border-line")}>
              <p className="text-[12.5px] font-medium text-muted">{b.name} · {b.kind.replace("_", " ")}{b.accountNumberLast4 ? ` ••${b.accountNumberLast4}` : ""}</p>
              <p className="num mt-1 text-[20px] font-semibold"><Money value={bal.native} currency={b.currency} /></p>
              <p className="text-[12px] text-muted">Ledger balance · {open ? <span className="text-warning">{open} unmatched</span> : "all matched"}</p>
              <p className="text-[12px] text-muted">{rec ? <>Reconciled to <DateText value={rec.statement_date} />{rec.status !== "completed" ? " (in progress)" : ""}</> : "Never reconciled"}</p>
            </Link>
          );
        })}
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <div>
          <FilterBar keep={["account"]} fields={[{ type: "select", name: "status", label: "Show", allLabel: "Needs attention", options: [{ value: "matched", label: "Matched" }, { value: "reconciled", label: "Reconciled" }, { value: "excluded", label: "Excluded" }, { value: "all", label: "All" }] }]} />
          <Card>
            <CardHeader title={`${selected.name} — statement lines`} />
            {txns.length ? (
              <ul className="divide-y divide-line">
                {txns.map((t) => {
                  const sug = suggestions.get(t.id) ?? [];
                  const inflow = Number(t.amount) > 0;
                  return (
                    <li key={t.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium">{t.description}</p>
                          <p className="text-[12px] text-muted"><DateText value={t.txnDate} />{t.counterparty ? ` · ${t.counterparty}` : ""}{t.reference ? ` · ref ${t.reference}` : ""} · {t.source}</p>
                        </div>
                        <div className="text-right">
                          <Money value={t.amount} currency={t.currency} className={inflow ? "text-success" : ""} />
                          <div className="mt-0.5"><StatusBadge status={t.matchId ? "matched" : t.status} />{t.matchType ? <span className="ml-1 text-[12px] text-muted">{MATCH_LABEL[t.matchType]}</span> : null}{t.excludedReason ? <div className="text-[12px] text-muted">{t.excludedReason}</div> : null}</div>
                        </div>
                      </div>
                      {canWrite && t.status === "unreconciled" && !t.matchId ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[13px] font-medium text-accent">Resolve{sug.length ? ` · ${sug.length} suggested match${sug.length > 1 ? "es" : ""}` : ""}</summary>
                          <div className="mt-2 space-y-3 rounded-md border border-line bg-[#fbfbf9] p-3">
                            {sug.length ? (
                              <div>
                                <p className="mb-1 text-[12.5px] font-medium">Match to an existing record (no new posting)</p>
                                <ul className="space-y-1">
                                  {sug.map((s) => (
                                    <li key={`${s.type}-${s.id}`}>
                                      <ActionForm action={bankMatchAction} className="flex items-center justify-between gap-2 text-[13px]" hideSuccess>
                                        <input type="hidden" name="txnId" value={t.id} /><input type="hidden" name="op" value="match" /><input type="hidden" name="matchType" value={s.type} /><input type="hidden" name="matchId" value={s.id} />
                                        <span>{MATCH_LABEL[s.type]} · {s.label} · <DateText value={s.date} /> · <Money value={s.amount} currency={t.currency} /> <Badge tone={s.score >= 80 ? "success" : "neutral"}>{s.score}% fit</Badge></span>
                                        <SubmitButton size="sm" variant="secondary">Match</SubmitButton>
                                      </ActionForm>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : <p className="text-[12.5px] text-muted">No existing record matches this amount and date closely.</p>}
                            {inflow ? (
                              <ActionForm action={bankMatchAction} className="grid gap-2 sm:grid-cols-[1fr_auto]">
                                <input type="hidden" name="txnId" value={t.id} /><input type="hidden" name="op" value="payment" />
                                <Field label="Record as a customer payment from"><Select name="accountId" options={accts} placeholder="Choose client" required /></Field>
                                <div className="self-end"><SubmitButton size="sm" variant="secondary">Create payment</SubmitButton></div>
                              </ActionForm>
                            ) : (
                              <ActionForm action={bankMatchAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                                <input type="hidden" name="txnId" value={t.id} /><input type="hidden" name="op" value="expense" />
                                <Field label="Record as an expense in"><Select name="categoryId" options={L!.categories} placeholder="Category" required /></Field>
                                <Field label="Engagement"><Select name="engagementId" options={L!.engagements} placeholder="Overhead" /></Field>
                                <div className="self-end"><SubmitButton size="sm" variant="secondary">Create expense</SubmitButton></div>
                              </ActionForm>
                            )}
                            {canPost ? (
                              <ActionForm action={bankMatchAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                                <input type="hidden" name="txnId" value={t.id} /><input type="hidden" name="op" value="post" />
                                <Field label="Post directly to account"><Select name="ledgerAccountId" options={L!.ledgers.filter((l) => l.value !== selected.ledgerAccountId)} placeholder="Ledger account" required /></Field>
                                <Field label="Memo"><Input name="memo" placeholder="e.g. Bank fee" /></Field>
                                <div className="self-end"><SubmitButton size="sm" variant="secondary">Post</SubmitButton></div>
                              </ActionForm>
                            ) : null}
                            <ActionForm action={bankMatchAction} className="grid gap-2 sm:grid-cols-[1fr_auto]">
                              <input type="hidden" name="txnId" value={t.id} /><input type="hidden" name="op" value="exclude" />
                              <Field label="Exclude (e.g. duplicate line on statement)"><Input name="reason" placeholder="Reason" /></Field>
                              <div className="self-end"><SubmitButton size="sm" variant="ghost">Exclude</SubmitButton></div>
                            </ActionForm>
                          </div>
                        </details>
                      ) : null}
                      {canWrite && t.matchId && t.status !== "reconciled" ? (
                        <ActionForm action={bankMatchAction} className="mt-1" hideSuccess><input type="hidden" name="txnId" value={t.id} /><input type="hidden" name="op" value="unmatch" /><SubmitButton size="sm" variant="ghost">Undo match</SubmitButton></ActionForm>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : <EmptyState title={status === "open" ? "Nothing needs attention" : "No lines"} description="Add statement lines manually or import a CSV export from your bank." />}
          </Card>
        </div>
        <div className="space-y-4">
          {canPost ? (
            <Card>
              <CardHeader title="Reconcile" description={`Ledger balance today: ${selBal.native} ${selected.currency}. Enter the closing balance from the bank statement.`} />
              <CardBody>
                <ActionForm action={reconcileAction} className="space-y-2">
                  <input type="hidden" name="bankAccountId" value={selected.id} />
                  <FormGrid cols={2}>
                    <Field label="Statement date"><Input type="date" name="statementDate" defaultValue={today} required /></Field>
                    <Field label={`Statement balance (${selected.currency})`}><Input name="statementBalance" inputMode="decimal" required /></Field>
                  </FormGrid>
                  <Checkbox name="complete" label="Mark complete (only when the difference is zero)" />
                  <SubmitButton size="sm">Save reconciliation</SubmitButton>
                </ActionForm>
                {recs.length ? <ul className="mt-3 space-y-1 border-t border-line pt-2 text-[12.5px]">{recs.map((r) => <li key={r.id} className="flex justify-between"><span><DateText value={r.statementDate} /> · <StatusBadge status={r.status} /></span><span>Statement <Money value={r.statementBalance} currency={selected.currency} /> · diff <Money value={r.difference} currency={selected.currency} className={Number(r.difference) ? "text-danger" : ""} /></span></li>)}</ul> : null}
              </CardBody>
            </Card>
          ) : null}
          {canWrite ? (
            <>
              <Card>
                <CardHeader title="Import statement (CSV)" description="Export a CSV from online banking. You map the columns next; duplicates are detected before anything is saved." />
                <CardBody>
                  <ActionForm action={stageBankImportAction} className="space-y-2">
                    <input type="hidden" name="bankAccountId" value={selected.id} />
                    <Input type="file" name="file" accept=".csv,text/csv" aria-label="CSV file" required />
                    <SubmitButton size="sm">Upload and map columns</SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Add a statement line" />
                <CardBody>
                  <ActionForm action={addBankTransactionAction} resetOnSuccess className="space-y-2">
                    <input type="hidden" name="bankAccountId" value={selected.id} />
                    <FormGrid cols={2}>
                      <Field label="Date"><Input type="date" name="txnDate" defaultValue={today} required /></Field>
                      <Field label="Amount (− for money out)"><Input name="amount" inputMode="decimal" required /></Field>
                    </FormGrid>
                    <Field label="Description"><Input name="description" required /></Field>
                    <FormGrid cols={2}>
                      <Field label="Counterparty"><Input name="counterparty" /></Field>
                      <Field label="Reference"><Input name="reference" /></Field>
                    </FormGrid>
                    <SubmitButton size="sm">Add line</SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            </>
          ) : null}
          {canPost && banks.length > 1 ? (
            <Card>
              <CardHeader title="Transfer between accounts" description="Records a transfer you made; it does not move money." />
              <CardBody>
                <ActionForm action={transferAction} className="space-y-2">
                  <FormGrid cols={2}>
                    <Field label="From"><Select name="fromBankAccountId" options={banks.map((b) => ({ value: b.id, label: `${b.name} (${b.currency})` }))} defaultValue={selected.id} /></Field>
                    <Field label="To"><Select name="toBankAccountId" options={banks.map((b) => ({ value: b.id, label: `${b.name} (${b.currency})` }))} /></Field>
                    <Field label="Date"><Input type="date" name="transferDate" defaultValue={today} /></Field>
                    <Field label="Amount"><Input name="amount" inputMode="decimal" required /></Field>
                  </FormGrid>
                  <Field label="Memo"><Input name="memo" /></Field>
                  <SubmitButton size="sm">Record transfer</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          {canAdmin ? <NewBankAccount /> : null}
          <p className="text-[12px] text-muted">Last refreshed <DateTimeText value={new Date()} />.</p>
        </div>
      </div>
    </>
  );
}

function NewBankAccount() {
  return (
    <Card>
      <CardHeader title="Add a bank account" description="Store only the last 4 digits. No live connection is made." />
      <CardBody>
        <ActionForm action={createBankAccountAction} className="space-y-2">
          <FormGrid cols={2}>
            <Field label="Name"><Input name="name" required placeholder="e.g. Operating account" /></Field>
            <Field label="Type"><Select name="kind" options={[{ value: "bank", label: "Bank" }, { value: "card", label: "Card" }, { value: "cash", label: "Cash" }, { value: "payment_processor", label: "Payment processor" }]} /></Field>
            <Field label="Institution"><Input name="institution" /></Field>
            <Field label="Last 4 digits"><Input name="accountNumberLast4" maxLength={4} inputMode="numeric" /></Field>
            <Field label="Currency"><Select name="currency" options={CURRENCIES} /></Field>
            <Field label="Opening balance"><Input name="openingBalance" inputMode="decimal" /></Field>
            <Field label="Opening balance date"><Input type="date" name="openingBalanceDate" /></Field>
          </FormGrid>
          <SubmitButton size="sm">Add account</SubmitButton>
        </ActionForm>
      </CardBody>
    </Card>
  );
}

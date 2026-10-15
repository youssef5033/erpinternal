import Link from "next/link";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { accountingPeriods, exchangeRates, journalEntries, ledgerAccounts, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountBalances } from "@/server/finance/ledger";
import { agencyToday, getSettings } from "@/server/system/settings";
import { addMonthsISO, monthEndISO, monthStartISO } from "@/lib/dates";
import { d } from "@/lib/money";
import { exchangeRateAction, ledgerAccountAction, lockPeriodAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money, Pagination, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { JournalForm } from "@/components/finance/journal-form";
import { qs } from "@/lib/utils";

export const metadata = { title: "Accounting" };

const TABS = [
  { key: "coa", label: "Chart of accounts" },
  { key: "journals", label: "Journals" },
  { key: "new", label: "Manual journal" },
  { key: "periods", label: "Periods" },
  { key: "fx", label: "Exchange rates" },
  { key: "opening", label: "Opening balances" },
];

export default async function AccountingPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "coa";
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const ledgers = await db.select().from(ledgerAccounts).orderBy(asc(ledgerAccounts.code));
  const ledgerOpts = ledgers.filter((l) => l.active).map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }));
  const tabs = TABS.filter((t) => (t.key === "new" ? can(actor, "finance.post") : t.key === "opening" ? can(actor, "finance.admin") : true));
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Accounting" }]} title="Accounting" description={`Double-entry general ledger in ${s.baseCurrency}. Posted entries are immutable (enforced in the database); corrections are reversals.`} />
      <Tabs current={tab} tabs={tabs.map((t) => ({ ...t, href: `/finance/accounting${t.key === "coa" ? "" : `?tab=${t.key}`}` }))} />
      <div className="mt-4">
        {tab === "coa" ? <Coa ledgers={ledgers} today={today} base={s.baseCurrency} canAdmin={can(actor, "finance.admin")} editId={sp.edit} /> : null}
        {tab === "journals" ? <Journals sp={sp} ledgers={ledgerOpts} /> : null}
        {tab === "new" && can(actor, "finance.post") ? <Card className="max-w-5xl"><CardHeader title="Manual journal" /><CardBody><JournalForm ledgers={ledgerOpts} today={today} base={s.baseCurrency} /></CardBody></Card> : null}
        {tab === "periods" ? <Periods today={today} canAdmin={can(actor, "finance.admin")} /> : null}
        {tab === "fx" ? <Fx base={s.baseCurrency} today={today} canWrite={can(actor, "finance.write")} /> : null}
        {tab === "opening" && can(actor, "finance.admin") ? (
          <Card className="max-w-5xl">
            <CardHeader title="Opening balances" description="Enter balances from your previous system at go-live, offset against Opening balance equity. Bank opening balances are set on each bank account instead." />
            <CardBody><JournalForm ledgers={ledgerOpts} today={today} base={s.baseCurrency} kind="opening_balance" /></CardBody>
          </Card>
        ) : null}
      </div>
    </>
  );
}

async function Coa({ ledgers, today, base, canAdmin, editId }: { ledgers: (typeof ledgerAccounts.$inferSelect)[]; today: string; base: string; canAdmin: boolean; editId?: string }) {
  const bal = await accountBalances(db, { to: today });
  const editing = ledgers.find((l) => l.id === editId);
  const types = ["asset", "liability", "equity", "income", "expense"] as const;
  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Card>
        {types.map((t) => (
          <div key={t}>
            <p className="border-b border-line bg-sunken/60 px-4 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted">{t}</p>
            <Table>
              <tbody>
                {ledgers.filter((l) => l.type === t).map((l) => {
                  const b = bal.find((x) => x.ledgerAccountId === l.id);
                  const net = b ? d(b.debit).minus(d(b.credit)) : d(0);
                  const shown = t === "asset" || t === "expense" ? net : net.negated();
                  return (
                    <TR key={l.id} className={!l.active ? "opacity-60" : ""}>
                      <TD className="w-20 num">{l.code}</TD>
                      <TD><Link className="hover:underline" href={`/finance/reports?report=ledger&account=${l.id}`}>{l.name}</Link><span className="ml-2 text-[12px] text-muted">{l.subtype}</span>{l.systemKey ? <Badge className="ml-1">system</Badge> : null}{l.isDirectCost ? <Badge tone="info" className="ml-1">direct cost</Badge> : null}{!l.active ? <Badge className="ml-1">inactive</Badge> : null}</TD>
                      <TD align="right"><Money value={shown.toFixed(2)} currency={base} emphasize="negative" /></TD>
                      {canAdmin ? <TD align="right" className="w-14"><Link className="text-[12.5px] text-accent hover:underline" href={`/finance/accounting?edit=${l.id}`}>Edit</Link></TD> : null}
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </div>
        ))}
        <p className="px-4 py-2 text-[12px] text-muted">Balances to {today}, shown with their natural sign (assets and expenses as debits; liabilities, equity and income as credits).</p>
      </Card>
      {canAdmin ? (
        <Card>
          <CardHeader title={editing ? `Edit ${editing.code}` : "Add account"} description={editing?.systemKey ? "System accounts are used by posting rules: their type is fixed and they cannot be deactivated." : undefined} />
          <CardBody>
            <ActionForm action={ledgerAccountAction} key={editing?.id ?? "new"}>
              {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
              <FormGrid cols={2}>
                <Field label="Code"><Input name="code" defaultValue={editing?.code} required /></Field>
                <Field label="Type"><Select name="type" options={types.map((t) => ({ value: t, label: t }))} defaultValue={editing?.type ?? "expense"} /></Field>
                <Field label="Name" className="sm:col-span-2"><Input name="name" defaultValue={editing?.name} required /></Field>
                <Field label="Subtype"><Input name="subtype" defaultValue={editing?.subtype ?? "overhead"} required /></Field>
                <Field label="Description"><Input name="description" defaultValue={editing?.description ?? ""} /></Field>
              </FormGrid>
              <div className="mt-2 flex flex-wrap gap-4"><Checkbox name="isDirectCost" label="Direct cost (counts in gross margin)" defaultChecked={editing?.isDirectCost ?? false} />{editing ? <Checkbox name="active" label="Active" defaultChecked={editing.active} /> : null}</div>
              <div className="mt-3 flex justify-end"><SubmitButton size="sm">Save account</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

async function Journals({ sp, ledgers }: { sp: Record<string, string | undefined>; ledgers: { value: string; label: string }[] }) {
  const conds: (SQL | undefined)[] = [];
  if (sp.q) conds.push(or(ilike(journalEntries.memo, `%${sp.q}%`), ilike(journalEntries.number, `%${sp.q}%`)));
  if (sp.source) conds.push(eq(journalEntries.sourceType, sp.source as "manual"));
  if (sp.from) conds.push(sql`${journalEntries.entryDate} >= ${sp.from}`);
  if (sp.to) conds.push(sql`${journalEntries.entryDate} <= ${sp.to}`);
  if (sp.account) conds.push(sql`exists (select 1 from journal_lines jl where jl.entry_id = "journal_entries"."id" and jl.ledger_account_id = ${sp.account})`);
  const where = and(...conds);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(journalEntries).where(where);
  const rows = await db
    .select({ j: journalEntries, by: user.name, amount: sql<string>`(select sum(debit) from journal_lines jl where jl.entry_id = "journal_entries"."id")` })
    .from(journalEntries)
    .leftJoin(user, eq(user.id, journalEntries.createdBy))
    .where(where)
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.postedAt))
    .limit(50)
    .offset((page - 1) * 50);
  const sources = ["invoice", "credit_note", "customer_payment", "payment_allocation", "bill", "supplier_payment", "expense", "expense_reimbursement", "revenue_recognition", "bank_transfer", "bank_transaction", "manual", "opening_balance", "reversal"];
  return (
    <>
      <FilterBar keep={["tab"]} fields={[{ type: "search", name: "q", label: "Search", placeholder: "Number or memo" }, { type: "select", name: "source", label: "Source", options: sources.map((x) => ({ value: x, label: x.replace(/_/g, " ") })) }, { type: "select", name: "account", label: "Account", options: ledgers }, { type: "date", name: "from", label: "From" }, { type: "date", name: "to", label: "To" }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Entry</TH><TH>Date</TH><TH>Source</TH><TH>Memo</TH><TH align="right">Amount (base)</TH><TH>Posted</TH></tr></THead>
            <tbody>{rows.map(({ j, by, amount }) => <TR key={j.id}><TD><Link className="font-medium hover:underline" href={`/finance/accounting/journals/${j.id}`}>{j.number}</Link>{j.reversedById ? <Badge tone="warning" className="ml-1">reversed</Badge> : null}{j.reversalOfId ? <Badge className="ml-1">reversal</Badge> : null}</TD><TD><DateText value={j.entryDate} /></TD><TD className="text-[12.5px]">{j.sourceType.replace(/_/g, " ")}</TD><TD className="text-[12.5px]">{j.memo}</TD><TD align="right" className="num">{Number(amount ?? 0).toFixed(2)}</TD><TD className="text-[12px] text-muted"><DateTimeText value={j.postedAt} /><div>{by ?? "System"}</div></TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No journal entries match" />}
        <Pagination page={page} pageSize={50} total={Number(total)} hrefFor={(p) => `/finance/accounting${qs({ ...sp, page: p })}`} />
      </Card>
    </>
  );
}

async function Periods({ today, canAdmin }: { today: string; canAdmin: boolean }) {
  const rows = await db.select({ p: accountingPeriods, by: user.name }).from(accountingPeriods).leftJoin(user, eq(user.id, accountingPeriods.lockedBy)).orderBy(desc(accountingPeriods.periodStart));
  const months = Array.from({ length: 12 }, (_, i) => monthStartISO(addMonthsISO(today, -i)));
  return (
    <Card className="max-w-4xl">
      <CardHeader title="Accounting periods" description="Locking a month blocks any posting dated in it (enforced by a database trigger). Reopening is logged." />
      <Table>
        <THead><tr><TH>Month</TH><TH>Status</TH><TH>Locked by</TH><TH>Note</TH>{canAdmin ? <TH /> : null}</tr></THead>
        <tbody>
          {months.map((m) => {
            const r = rows.find((x) => x.p.periodStart === m);
            const locked = r?.p.status === "locked";
            return (
              <TR key={m}>
                <TD>{m.slice(0, 7)}</TD>
                <TD><StatusBadge status={locked ? "locked" : "open"} /></TD>
                <TD className="text-[12.5px]">{locked ? <>{r?.by} · {r?.p.lockedAt ? <DateTimeText value={r.p.lockedAt} /> : null}</> : "—"}</TD>
                <TD className="text-[12.5px]">{r?.p.note ?? ""}</TD>
                {canAdmin ? (
                  <TD align="right">
                    {m <= monthStartISO(today) ? (
                      <ActionForm action={lockPeriodAction} className="flex justify-end gap-1" hideSuccess>
                        <input type="hidden" name="periodStart" value={m} /><input type="hidden" name="periodEnd" value={monthEndISO(m)} /><input type="hidden" name="lock" value={locked ? "false" : "true"} />
                        <Input name="note" aria-label="Note" placeholder="Note" className="h-8 w-40" />
                        <SubmitButton size="sm" variant={locked ? "secondary" : "primary"} confirm={locked ? "Reopen this period? Postings into it will be allowed again." : "Lock this period?"}>{locked ? "Reopen" : "Lock"}</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </TD>
                ) : null}
              </TR>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

async function Fx({ base, today, canWrite }: { base: string; today: string; canWrite: boolean }) {
  const rows = await db.select().from(exchangeRates).orderBy(desc(exchangeRates.rateDate), asc(exchangeRates.fromCurrency)).limit(200);
  return (
    <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardHeader title="Exchange rates" description={`Rates are entered manually (no live rate feed is connected). Postings use the latest rate on or before the transaction date; historical rates are never overwritten.`} />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Date</TH><TH>Pair</TH><TH align="right">Rate</TH><TH>Source</TH></tr></THead>
            <tbody>{rows.map((r) => <TR key={r.id}><TD><DateText value={r.rateDate} /></TD><TD>1 {r.fromCurrency} = … {r.toCurrency}</TD><TD align="right" className="num">{Number(r.rate)}</TD><TD>{r.source}</TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No rates recorded" />}
      </Card>
      {canWrite ? (
        <Card>
          <CardHeader title="Record a rate" />
          <CardBody>
            <ActionForm action={exchangeRateAction} resetOnSuccess>
              <FormGrid cols={2}>
                <Field label="Date"><Input type="date" name="rateDate" defaultValue={today} required /></Field>
                <Field label="Rate"><Input name="rate" inputMode="decimal" placeholder="1.0850" required /></Field>
                <Field label="From"><Select name="fromCurrency" options={CURRENCIES} defaultValue="EUR" /></Field>
                <Field label="To"><Select name="toCurrency" options={CURRENCIES} defaultValue={base} /></Field>
              </FormGrid>
              <div className="mt-3 flex justify-end"><SubmitButton size="sm">Save rate</SubmitButton></div>
            </ActionForm>
            <Notice className="mt-3">Record the source you used (e.g. central bank reference rate) in your close checklist; the system does not fetch rates.</Notice>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

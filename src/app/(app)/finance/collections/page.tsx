import Link from "next/link";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, bankAccounts, customerPayments, invoices } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { invoiceVisibility } from "@/server/auth/scope";
import { daysOverdue, listInvoicesWithBalances, outstandingSql } from "@/server/finance/invoices";
import { receivablesAging } from "@/server/finance/reports";
import { agencyToday } from "@/server/system/settings";
import { allocatePaymentAction, recordPaymentAction, reversePaymentAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { AgingTable } from "@/components/finance/aging-table";

export const metadata = { title: "Collections & payments" };

const TABS = [
  { key: "receivables", label: "Receivables & follow-up" },
  { key: "aging", label: "Aging" },
  { key: "payments", label: "Payments received" },
  { key: "record", label: "Record a payment" },
];

export default async function CollectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "receivables";
  const today = await agencyToday(db);
  const canWrite = can(actor, "finance.write");
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Collections & payments" }]} title="Collections & payments" description="What clients owe, what is late, and money received. Recording a payment documents money already received — this system never initiates payments." />
      <Tabs current={tab} tabs={TABS.filter((t) => t.key !== "record" || canWrite).map((t) => ({ ...t, href: `/finance/collections${t.key === "receivables" ? "" : `?tab=${t.key}`}` }))} />
      <div className="mt-4">
        {tab === "receivables" ? <Receivables actor={actor} today={today} /> : null}
        {tab === "aging" ? <AgingTable aging={await receivablesAging(db, sp.asOf ?? today)} title="Receivables aging" partyHref={(id) => `/crm/accounts/${id}?tab=financials`} itemHref={(id) => `/finance/invoices/${id}`} /> : null}
        {tab === "payments" ? <Payments sp={sp} canWrite={canWrite} canPost={can(actor, "finance.post")} today={today} /> : null}
        {tab === "record" && canWrite ? <Record sp={sp} today={today} /> : null}
      </div>
    </>
  );
}

async function Receivables({ actor, today }: { actor: Awaited<ReturnType<typeof guard>>; today: string }) {
  const rows = await listInvoicesWithBalances(db, and(eq(invoices.status, "issued"), sql`${outstandingSql} > 0`, invoiceVisibility(actor)));
  const lastFollowUp = (await db.execute<{ invoice_id: string; at: string; subject: string }>(sql`
    select distinct on (t.invoice_id) t.invoice_id, coalesce(t.completed_at, t.created_at)::text as at, t.title as subject
    from tasks t where t.invoice_id is not null order by t.invoice_id, coalesce(t.completed_at, t.created_at) desc`)).rows;
  const overdue = rows.filter((r) => r.invoice.dueDate && r.invoice.dueDate < today).sort((a, b) => (a.invoice.dueDate ?? "").localeCompare(b.invoice.dueDate ?? ""));
  const upcoming = rows.filter((r) => !r.invoice.dueDate || r.invoice.dueDate >= today);
  const Section = ({ list, title, desc }: { list: typeof rows; title: string; desc: string }) => (
    <Card>
      <CardHeader title={title} description={desc} />
      {list.length ? (
        <Table>
          <THead><tr><TH>Invoice</TH><TH>Client</TH><TH>Due</TH><TH align="right">Outstanding</TH><TH>Last follow-up</TH><TH /></tr></THead>
          <tbody>
            {list.map(({ invoice: i, accountName, outstanding }) => {
              const f = lastFollowUp.find((x) => x.invoice_id === i.id);
              const late = daysOverdue(i.dueDate, today);
              return (
                <TR key={i.id}>
                  <TD><Link className="font-medium hover:underline" href={`/finance/invoices/${i.id}`}>{i.number}</Link></TD>
                  <TD><Link className="hover:underline" href={`/crm/accounts/${i.accountId}?tab=financials`}>{accountName}</Link></TD>
                  <TD><DateText value={i.dueDate} overdue={late > 0} />{late > 0 ? <div className="text-[11.5px] text-danger">{late} days late</div> : null}</TD>
                  <TD align="right"><Money value={outstanding} currency={i.currency} />{Number(outstanding) < Number(i.total) ? <div className="text-[11.5px] text-muted">of <Money value={i.total} currency={i.currency} /></div> : null}</TD>
                  <TD className="text-[12.5px]">{f ? <>{f.subject}<div className="text-muted"><DateText value={f.at.slice(0, 10)} /></div></> : late > 0 ? <Badge tone="warning">none recorded</Badge> : "—"}</TD>
                  <TD align="right"><Link className="text-[12.5px] text-accent hover:underline" href={`/finance/invoices/${i.id}`}>Follow up</Link></TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      ) : <EmptyState title="Nothing here" />}
    </Card>
  );
  return (
    <div className="space-y-4">
      <Notice>Reminders are not emailed by the system. Log each follow-up as a task or activity on the invoice so the history is visible here.</Notice>
      <Section list={overdue} title={`Overdue (${overdue.length})`} desc="Issued invoices past their due date with a balance, oldest first." />
      <Section list={upcoming} title={`Not yet due (${upcoming.length})`} desc="Issued invoices with a balance that are not yet due." />
    </div>
  );
}

async function Payments({ sp, canWrite, canPost, today }: { sp: Record<string, string | undefined>; canWrite: boolean; canPost: boolean; today: string }) {
  const rows = await db
    .select({
      p: customerPayments,
      accountName: accounts.name,
      bankName: bankAccounts.name,
      unallocated: sql<string>`(${customerPayments.amount} - coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = "customer_payments"."id" and a.reversed_at is null),0))`,
    })
    .from(customerPayments)
    .innerJoin(accounts, eq(accounts.id, customerPayments.accountId))
    .innerJoin(bankAccounts, eq(bankAccounts.id, customerPayments.bankAccountId))
    .where(sp.account ? eq(customerPayments.accountId, sp.account) : undefined)
    .orderBy(desc(customerPayments.paymentDate))
    .limit(200);
  const accts = await db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(sql`${accounts.id} in (select account_id from customer_payments)`).orderBy(accounts.name);
  const openInv = canWrite ? await listInvoicesWithBalances(db, and(eq(invoices.status, "issued"), sql`${outstandingSql} > 0`)) : [];
  return (
    <>
      <FilterBar keep={["tab"]} fields={[{ type: "select", name: "account", label: "Client", options: accts }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Payment</TH><TH>Client</TH><TH>Date</TH><TH>Into</TH><TH align="right">Amount</TH><TH align="right">Unapplied</TH><TH>Status</TH><TH /></tr></THead>
            <tbody>
              {rows.map(({ p, accountName, bankName, unallocated }) => {
                const candidates = openInv.filter((x) => x.invoice.accountId === p.accountId && x.invoice.currency === p.currency);
                return (
                  <TR key={p.id}>
                    <TD className="font-medium">{p.number}<div className="text-[12px] font-normal text-muted">{p.method.replace("_", " ")}{p.reference ? ` · ${p.reference}` : ""}</div></TD>
                    <TD><Link className="hover:underline" href={`/crm/accounts/${p.accountId}?tab=financials`}>{accountName}</Link></TD>
                    <TD><DateText value={p.paymentDate} /></TD>
                    <TD>{bankName}</TD>
                    <TD align="right"><Money value={p.amount} currency={p.currency} /></TD>
                    <TD align="right">{Number(unallocated) > 0 && p.status === "recorded" ? <Money value={unallocated} currency={p.currency} className="text-warning" /> : "—"}</TD>
                    <TD><StatusBadge status={p.status} /></TD>
                    <TD align="right" className="min-w-[220px]">
                      {p.status === "recorded" && Number(unallocated) > 0 && canWrite && candidates.length ? (
                        <details><summary className="cursor-pointer text-[12.5px] text-accent">Apply to invoice</summary>
                          <ActionForm action={allocatePaymentAction} className="mt-1 space-y-1 text-left">
                            <input type="hidden" name="paymentId" value={p.id} />
                            <Select name="invoiceId" aria-label="Invoice" options={candidates.map((c) => ({ value: c.invoice.id, label: `${c.invoice.number} — ${c.outstanding} due` }))} />
                            <div className="flex gap-1"><Input name="amount" aria-label="Amount" inputMode="decimal" defaultValue={unallocated} className="h-8" /><Input type="date" name="allocationDate" aria-label="Date" defaultValue={today} className="h-8" /></div>
                            <SubmitButton size="sm">Apply</SubmitButton>
                          </ActionForm>
                        </details>
                      ) : null}
                      {p.status === "recorded" && canPost ? (
                        <details><summary className="cursor-pointer text-[12.5px] text-danger">Reverse</summary>
                          <ActionForm action={reversePaymentAction} className="mt-1 flex gap-1"><input type="hidden" name="id" value={p.id} /><input type="hidden" name="kind" value="payment" /><Input name="reason" aria-label="Reason" placeholder="Reason (e.g. bounced)" required className="h-8" /><SubmitButton size="sm" variant="danger" confirm="Reverse this payment and its allocations?">Reverse</SubmitButton></ActionForm>
                        </details>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No payments recorded" />}
      </Card>
    </>
  );
}

async function Record({ sp, today }: { sp: Record<string, string | undefined>; today: string }) {
  const accts = await db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(sql`${accounts.id} in (select account_id from invoices where status = 'issued')`).orderBy(asc(accounts.name));
  const banks = await db.select().from(bankAccounts).where(eq(bankAccounts.active, true)).orderBy(bankAccounts.name);
  const open = sp.account ? await listInvoicesWithBalances(db, and(eq(invoices.accountId, sp.account), eq(invoices.status, "issued"), sql`${outstandingSql} > 0`)) : [];
  const preselect = open.find((x) => x.invoice.id === sp.invoice);
  const currency = preselect?.invoice.currency ?? open[0]?.invoice.currency ?? banks[0]?.currency ?? "USD";
  return (
    <div className="max-w-5xl space-y-4">
      <FilterBar keep={["tab"]} fields={[{ type: "select", name: "account", label: "Client", options: accts, allLabel: "Choose a client" }]} />
      {!banks.length ? <Notice tone="warning">Add a bank account in Finance → Bank first.</Notice> : null}
      {sp.account && banks.length ? (
        <Card>
          <CardHeader title="Payment details" description="Enter what arrived in the bank. Apply it to one or more open invoices; any remainder stays as unapplied client credit." />
          <CardBody>
            <ActionForm action={recordPaymentAction}>
              <input type="hidden" name="accountId" value={sp.account} />
              <FormGrid cols={3}>
                <Field label="Received on" required><Input type="date" name="paymentDate" defaultValue={today} max={today} required /></Field>
                <Field label="Amount received" required><Input name="amount" inputMode="decimal" defaultValue={preselect?.outstanding ?? ""} required /></Field>
                <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={currency} /></Field>
                <Field label="Into bank account" required><Select name="bankAccountId" options={banks.map((b) => ({ value: b.id, label: `${b.name} (${b.currency})` }))} defaultValue={banks.find((b) => b.currency === currency)?.id} /></Field>
                <Field label="Method"><Select name="method" options={[{ value: "bank_transfer", label: "Bank transfer" }, { value: "card", label: "Card" }, { value: "cheque", label: "Cheque" }, { value: "cash", label: "Cash" }, { value: "processor", label: "Payment processor" }, { value: "other", label: "Other" }]} /></Field>
                <Field label="Reference"><Input name="reference" placeholder="Bank reference" /></Field>
              </FormGrid>
              <Field label="Evidence note" className="mt-3"><Input name="evidenceNote" placeholder="e.g. Seen on bank statement 15 Oct" /></Field>
              <p className="mt-4 text-[13px] font-medium">Apply to open invoices</p>
              {open.length ? (
                <Table>
                  <THead><tr><TH>Invoice</TH><TH>Due</TH><TH align="right">Outstanding</TH><TH align="right">Apply</TH></tr></THead>
                  <tbody>
                    {open.map(({ invoice: i, outstanding }, n) => (
                      <TR key={i.id}>
                        <TD>{i.number}<input type="hidden" name={`allocations.${n}.invoiceId`} value={i.id} /></TD>
                        <TD><DateText value={i.dueDate} overdue={!!i.dueDate && i.dueDate < today} /></TD>
                        <TD align="right"><Money value={outstanding} currency={i.currency} /></TD>
                        <TD align="right"><Input name={`allocations.${n}.amount`} aria-label={`Apply to ${i.number}`} inputMode="decimal" className="ml-auto h-8 w-32 text-right" defaultValue={i.id === sp.invoice ? outstanding : ""} /></TD>
                      </TR>
                    ))}
                  </tbody>
                </Table>
              ) : <p className="text-[13px] text-muted">No open invoices for this client — the payment will be held as client credit.</p>}
              <p className="mt-2 text-[12px] text-muted">Invoices in a different currency from the payment cannot be paid by it. Exchange differences on foreign-currency invoices post to realised FX gain/loss.</p>
              <div className="mt-3 flex justify-end"><SubmitButton>Record payment</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

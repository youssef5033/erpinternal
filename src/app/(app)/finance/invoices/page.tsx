import Link from "next/link";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, invoices, recurringInvoiceSchedules } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { invoiceVisibility } from "@/server/auth/scope";
import { daysOverdue, isOverdue, listInvoicesWithBalances, outstandingSql, statusFromOutstanding } from "@/server/finance/invoices";
import { recurringStatusAction, runRecurringNowAction } from "@/server/actions/finance";
import { agencyToday, getSettings } from "@/server/system/settings";
import { qs } from "@/lib/utils";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { RecurringForm } from "@/components/finance/invoice-form";
import { invoiceLookups } from "@/components/finance/lookups";

export const metadata = { title: "Invoices" };

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const tab = sp.tab === "recurring" ? "recurring" : "invoices";
  const today = await agencyToday(db);
  const canWrite = can(actor, "finance.write");
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Invoices" }]} title="Invoices" description="Issued invoices are immutable and posted to the ledger. Corrections are made with credit notes or by voiding, never by editing." actions={<>{can(actor, "finance.export") ? <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href="/api/export/invoices">Export</a> : null}{canWrite ? <LinkButton variant="primary" href="/finance/invoices/new">New invoice</LinkButton> : null}</>} />
      <Tabs current={tab} tabs={[{ key: "invoices", label: "Invoices", href: "/finance/invoices" }, { key: "recurring", label: "Recurring schedules", href: "/finance/invoices?tab=recurring" }]} />
      <div className="mt-4">{tab === "invoices" ? <List sp={sp} actor={actor} today={today} /> : <Recurring canWrite={canWrite} today={today} />}</div>
    </>
  );
}

async function List({ sp, actor, today }: { sp: Record<string, string | undefined>; actor: Awaited<ReturnType<typeof guard>>; today: string }) {
  const conds: (SQL | undefined)[] = [invoiceVisibility(actor)];
  if (sp.q) conds.push(or(ilike(sql`coalesce(${invoices.number},'')`, `%${sp.q}%`), ilike(accounts.name, `%${sp.q}%`), ilike(sql`coalesce(${invoices.reference},'')`, `%${sp.q}%`)));
  if (sp.account) conds.push(eq(invoices.accountId, sp.account));
  if (sp.engagement) conds.push(eq(invoices.engagementId, sp.engagement));
  switch (sp.status) {
    case "draft": conds.push(eq(invoices.status, "draft")); break;
    case "void": conds.push(eq(invoices.status, "void")); break;
    case "open": conds.push(and(eq(invoices.status, "issued"), sql`${outstandingSql} > 0`)); break;
    case "overdue": conds.push(and(eq(invoices.status, "issued"), sql`${outstandingSql} > 0`, sql`${invoices.dueDate} < ${today}`)); break;
    case "paid": conds.push(and(eq(invoices.status, "issued"), sql`${outstandingSql} <= 0`)); break;
  }
  if (sp.from) conds.push(sql`${invoices.issueDate} >= ${sp.from}`);
  if (sp.to) conds.push(sql`${invoices.issueDate} <= ${sp.to}`);
  const rows = (await listInvoicesWithBalances(db, and(...conds))).slice(0, 300);
  const accts = await db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(sql`${accounts.id} in (select account_id from invoices)`).orderBy(accounts.name);
  const byCur = new Map<string, { total: number; out: number }>();
  for (const r of rows) if (r.invoice.status === "issued") {
    const g = byCur.get(r.invoice.currency) ?? { total: 0, out: 0 };
    g.total += Number(r.invoice.total); g.out += Number(r.outstanding);
    byCur.set(r.invoice.currency, g);
  }
  return (
    <>
      <FilterBar fields={[{ type: "search", name: "q", label: "Search", placeholder: "Number, client or reference" }, { type: "select", name: "status", label: "Status", options: [{ value: "draft", label: "Draft" }, { value: "open", label: "Open (unpaid / part-paid)" }, { value: "overdue", label: "Overdue" }, { value: "paid", label: "Paid / settled" }, { value: "void", label: "Void" }] }, { type: "select", name: "account", label: "Client", options: accts }, { type: "date", name: "from", label: "Issued from" }, { type: "date", name: "to", label: "Issued to" }]} />
      {byCur.size ? <p className="mb-2 text-[12.5px] text-muted">Issued in this view: {Array.from(byCur.entries()).map(([c, g]) => <span key={c} className="mr-3"><Money value={g.total.toFixed(2)} currency={c} /> invoiced, <Money value={g.out.toFixed(2)} currency={c} /> outstanding</span>)}</p> : null}
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Number</TH><TH>Client</TH><TH>Engagement</TH><TH>Issued</TH><TH>Due</TH><TH align="right">Total</TH><TH align="right">Outstanding</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ invoice: i, accountName, outstanding, engagementNumber }) => {
                const od = isOverdue(i, outstanding, today);
                return (
                  <TR key={i.id}>
                    <TD><Link className="font-medium hover:underline" href={`/finance/invoices/${i.id}`}>{i.number ?? "Draft"}</Link>{i.isDeposit ? <Badge className="ml-1">deposit</Badge> : null}{i.recurringScheduleId ? <Badge className="ml-1">recurring</Badge> : null}</TD>
                    <TD><Link className="hover:underline" href={`/crm/accounts/${i.accountId}?tab=financials`}>{accountName}</Link></TD>
                    <TD className="text-[12.5px]">{i.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${i.engagementId}?tab=billing`}>{engagementNumber}</Link> : "—"}</TD>
                    <TD><DateText value={i.issueDate} /></TD>
                    <TD><DateText value={i.dueDate} overdue={od} />{od ? <div className="text-[11.5px] text-danger">{daysOverdue(i.dueDate, today)} days late</div> : null}</TD>
                    <TD align="right"><Money value={i.total} currency={i.currency} /></TD>
                    <TD align="right">{i.status === "issued" ? <Money value={outstanding} currency={i.currency} /> : "—"}</TD>
                    <TD><StatusBadge status={statusFromOutstanding(i, outstanding)} /></TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No invoices match" />}
      </Card>
      <p className="mt-2 text-[12px] text-muted"><Link className="hover:underline" href={`/finance/invoices${qs({ ...sp, status: "overdue" })}`}>Show overdue only</Link></p>
    </>
  );
}

async function Recurring({ canWrite, today }: { canWrite: boolean; today: string }) {
  const rows = await db.select({ r: recurringInvoiceSchedules, accountName: accounts.name }).from(recurringInvoiceSchedules).innerJoin(accounts, eq(accounts.id, recurringInvoiceSchedules.accountId)).orderBy(desc(recurringInvoiceSchedules.createdAt));
  const s = await getSettings(db);
  const L = canWrite ? await invoiceLookups() : null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Recurring invoice schedules" description="Each run creates one invoice per period (idempotent). Drafts are reviewed before issue unless auto-issue is on. Nothing is emailed." actions={canWrite ? <ActionForm action={runRecurringNowAction}><SubmitButton size="sm" variant="secondary">Run due schedules now</SubmitButton></ActionForm> : null} />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Schedule</TH><TH>Client</TH><TH>Frequency</TH><TH>Next run</TH><TH>End</TH><TH align="right">Per run</TH><TH>Status</TH>{canWrite ? <TH /> : null}</tr></THead>
            <tbody>
              {rows.map(({ r, accountName }) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.name}{r.autoIssue ? <Badge className="ml-1">auto-issue</Badge> : null}</TD>
                  <TD>{accountName}</TD>
                  <TD className="capitalize">{r.frequency}</TD>
                  <TD><DateText value={r.nextRunDate} overdue={r.status === "active" && r.nextRunDate < today} /></TD>
                  <TD><DateText value={r.endDate} /></TD>
                  <TD align="right"><Money value={r.lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0).toFixed(2)} currency={r.currency} /><div className="text-[11.5px] text-muted">before tax</div></TD>
                  <TD><StatusBadge status={r.status} /></TD>
                  {canWrite ? <TD align="right">{r.status !== "ended" ? <ActionForm action={recurringStatusAction} className="flex justify-end gap-1" hideSuccess><input type="hidden" name="id" value={r.id} />{r.status === "active" ? <SubmitButton size="sm" variant="ghost" name="status" value="paused">Pause</SubmitButton> : <SubmitButton size="sm" variant="ghost" name="status" value="active">Resume</SubmitButton>}<SubmitButton size="sm" variant="ghost" name="status" value="ended" confirm="End this schedule?">End</SubmitButton></ActionForm> : null}</TD> : null}
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No recurring schedules" description="Retainer engagements bill through their billing schedule; use recurring schedules for other repeating charges." />}
      </Card>
      {L ? <Card><CardHeader title="New recurring schedule" /><CardBody><RecurringForm L={L} baseCurrency={s.baseCurrency} today={today} /></CardBody></Card> : null}
    </div>
  );
}

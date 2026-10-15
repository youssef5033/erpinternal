import Link from "next/link";
import { Fragment } from "react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ledgerAccounts } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { balanceSheet, budgetVsActual, cashFlowStatement, generalLedger, payablesAging, profitAndLoss, receivablesAging, revenueByServiceAndClient, trialBalance, type AccountLine } from "@/server/finance/reports";
import { agencyToday, getSettings } from "@/server/system/settings";
import { isISODate, resolvePeriod } from "@/lib/dates";
import { qs } from "@/lib/utils";
import { budgetAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { AgingTable } from "@/components/finance/aging-table";
import { PERIOD_OPTIONS } from "@/components/crm/analytics-filters";

export const metadata = { title: "Financial reports" };

const REPORTS = [
  { key: "pnl", label: "Profit & loss" },
  { key: "balance-sheet", label: "Balance sheet" },
  { key: "cash-flow", label: "Cash flow" },
  { key: "trial-balance", label: "Trial balance" },
  { key: "ledger", label: "General ledger" },
  { key: "ar-aging", label: "Receivables aging" },
  { key: "ap-aging", label: "Payables aging" },
  { key: "revenue", label: "Revenue by service & client" },
  { key: "budget", label: "Budget vs actual" },
];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("reports.read");
  const sp = await searchParams;
  const report = REPORTS.some((r) => r.key === sp.report) ? sp.report! : "pnl";
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const p = isISODate(sp.from) && isISODate(sp.to) ? { from: sp.from!, to: sp.to!, label: `${sp.from} → ${sp.to}` } : resolvePeriod(sp.period ?? "ytd", today, s.fiscalYearStartMonth);
  const asOf = isISODate(sp.asOf) ? sp.asOf! : today;
  const pointInTime = ["balance-sheet", "trial-balance", "ar-aging", "ap-aging"].includes(report);
  const ledgers = await db.select().from(ledgerAccounts).orderBy(asc(ledgerAccounts.code));
  const base = s.baseCurrency;
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Reports" }]} title="Financial reports" description={`Computed from posted ledger entries in ${base}. Management reports for internal use — not statutory filings; jurisdiction-specific presentation is not applied.`} actions={can(actor, "finance.export") ? <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href={`/api/export/journal${qs({ from: pointInTime ? undefined : p.from, to: pointInTime ? asOf : p.to })}`}>Export journal lines (CSV)</a> : null} />
      <Tabs current={report} tabs={REPORTS.map((r) => ({ ...r, href: `/finance/reports${qs({ ...sp, report: r.key, account: r.key === "ledger" ? sp.account : null })}` }))} />
      <div className="mt-3">
        {pointInTime ? (
          <FilterBar keep={["report"]} fields={[{ type: "date", name: "asOf", label: "As of" }]} />
        ) : report === "budget" ? null : (
          <FilterBar keep={["report", "account"]} fields={[{ type: "select", name: "period", label: "Period", options: PERIOD_OPTIONS, allLabel: "Fiscal year to date" }, { type: "date", name: "from", label: "From" }, { type: "date", name: "to", label: "To" }, ...(report === "ledger" ? [{ type: "select" as const, name: "account", label: "Account", options: ledgers.map((l) => ({ value: l.id, label: `${l.code} ${l.name}` })) }] : [])]} />
        )}
        {report === "pnl" ? <Pnl r={await profitAndLoss(db, p.from, p.to)} label={p.label} /> : null}
        {report === "balance-sheet" ? <BalanceSheet r={await balanceSheet(db, asOf)} /> : null}
        {report === "cash-flow" ? <CashFlow r={await cashFlowStatement(db, p.from, p.to)} label={p.label} /> : null}
        {report === "trial-balance" ? <Tb r={await trialBalance(db, asOf)} /> : null}
        {report === "ledger" ? (sp.account ? <Gl r={await generalLedger(db, sp.account, p.from, p.to)} base={base} /> : <Card><EmptyState title="Choose an account" description="Select a ledger account above to see every posting with a running balance." /></Card>) : null}
        {report === "ar-aging" ? <AgingTable aging={await receivablesAging(db, asOf)} title="Receivables aging" partyHref={(id) => `/crm/accounts/${id}?tab=financials`} itemHref={(id) => `/finance/invoices/${id}`} /> : null}
        {report === "ap-aging" ? <AgingTable aging={await payablesAging(db, asOf)} title="Payables aging" partyHref={(id) => `/finance/suppliers/${id}`} itemHref={(id) => `/finance/bills/${id}`} /> : null}
        {report === "revenue" ? <Revenue r={await revenueByServiceAndClient(db, p.from, p.to)} label={p.label} /> : null}
        {report === "budget" ? <Budget fy={Number(sp.fy ?? Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < s.fiscalYearStartMonth ? 1 : 0))} ledgers={ledgers} canAdmin={can(actor, "finance.admin")} /> : null}
      </div>
    </>
  );
}

const Lines = ({ lines, currency, title, total }: { lines: AccountLine[]; currency: string; title: string; total: string }) => (
  <>
    <TR className="bg-sunken/60"><TD className="text-[12px] font-semibold uppercase tracking-wide text-muted" colSpan={2}>{title}</TD></TR>
    {lines.map((l) => <TR key={l.account.id}><TD className="pl-8"><Link className="hover:underline" href={`/finance/reports?report=ledger&account=${l.account.id}`}>{l.account.code} {l.account.name}</Link></TD><TD align="right"><Money value={l.amount} currency={currency} emphasize="negative" /></TD></TR>)}
    {!lines.length ? <TR><TD className="pl-8 text-muted" colSpan={2}>None</TD></TR> : null}
    <TR className="font-medium"><TD>Total {title.toLowerCase()}</TD><TD align="right"><Money value={total} currency={currency} /></TD></TR>
  </>
);

function Pnl({ r, label }: { r: Awaited<ReturnType<typeof profitAndLoss>>; label: string }) {
  return (
    <Card className="max-w-4xl">
      <CardHeader title={`Profit & loss — ${label}`} description={`${r.from} → ${r.to}. ${r.basis}`} />
      <Table>
        <tbody>
          <Lines lines={r.revenue} currency={r.currency} title="Revenue" total={r.totalRevenue} />
          <Lines lines={r.directCosts} currency={r.currency} title="Direct costs" total={r.totalDirectCosts} />
          <TR className="font-semibold"><TD>Gross profit{r.grossMarginPct ? <span className="ml-2 text-[12px] font-normal text-muted">{r.grossMarginPct}% margin</span> : null}</TD><TD align="right"><Money value={r.grossProfit} currency={r.currency} emphasize="negative" /></TD></TR>
          <Lines lines={r.otherIncome} currency={r.currency} title="Other income" total={r.totalOtherIncome} />
          <Lines lines={r.overhead} currency={r.currency} title="Overheads" total={r.totalOverhead} />
          <TR className="border-t-2 border-line-strong text-[15px] font-semibold"><TD>Net profit</TD><TD align="right"><Money value={r.netProfit} currency={r.currency} emphasize="negative" /></TD></TR>
        </tbody>
      </Table>
    </Card>
  );
}

function BalanceSheet({ r }: { r: Awaited<ReturnType<typeof balanceSheet>> }) {
  return (
    <Card className="max-w-4xl">
      <CardHeader title={`Balance sheet at ${r.asOf}`} description={r.basis} actions={r.balanced ? <Badge tone="success">balances</Badge> : <Badge tone="danger">does not balance</Badge>} />
      <Table>
        <tbody>
          <Lines lines={r.assets} currency={r.currency} title="Assets" total={r.totalAssets} />
          <Lines lines={r.liabilities} currency={r.currency} title="Liabilities" total={r.totalLiabilities} />
          <Lines lines={r.equity} currency={r.currency} title="Equity" total={(Number(r.totalEquity) - Number(r.currentEarnings)).toFixed(2)} />
          <TR><TD className="pl-8">Current earnings (not yet closed)</TD><TD align="right"><Money value={r.currentEarnings} currency={r.currency} emphasize="negative" /></TD></TR>
          <TR className="border-t-2 border-line-strong font-semibold"><TD>Liabilities + equity</TD><TD align="right"><Money value={(Number(r.totalLiabilities) + Number(r.totalEquity)).toFixed(2)} currency={r.currency} /></TD></TR>
        </tbody>
      </Table>
    </Card>
  );
}

function CashFlow({ r, label }: { r: Awaited<ReturnType<typeof cashFlowStatement>>; label: string }) {
  return (
    <Card className="max-w-4xl">
      <CardHeader title={`Cash flow — ${label}`} description={r.basis} />
      <Table>
        <tbody>
          <TR className="font-medium"><TD>Opening cash</TD><TD align="right"><Money value={r.opening} currency={r.currency} /></TD></TR>
          {r.sections.map((s) => (
            <Fragment key={s.section}>
              <TR key={`${s.section}-h`} className="bg-sunken/60"><TD className="text-[12px] font-semibold uppercase tracking-wide text-muted" colSpan={2}>{s.section} activities</TD></TR>
              {s.items.map((i) => <TR key={`${s.section}-${i.label}`}><TD className="pl-8">{i.label}</TD><TD align="right"><Money value={i.amount} currency={r.currency} emphasize="negative" /></TD></TR>)}
              {!s.items.length ? <TR key={`${s.section}-none`}><TD className="pl-8 text-muted" colSpan={2}>None</TD></TR> : null}
              <TR key={`${s.section}-t`} className="font-medium"><TD>Net {s.section}</TD><TD align="right"><Money value={s.total} currency={r.currency} emphasize="negative" /></TD></TR>
            </Fragment>
          ))}
          <TR className="font-medium"><TD>Net change in cash</TD><TD align="right"><Money value={r.netChange} currency={r.currency} emphasize="negative" /></TD></TR>
          <TR className="border-t-2 border-line-strong font-semibold"><TD>Closing cash</TD><TD align="right"><Money value={r.closing} currency={r.currency} /></TD></TR>
        </tbody>
      </Table>
    </Card>
  );
}

function Tb({ r }: { r: Awaited<ReturnType<typeof trialBalance>> }) {
  return (
    <Card className="max-w-4xl">
      <CardHeader title={`Trial balance at ${r.asOf}`} description="Debit and credit balance of every account with activity." actions={r.balanced ? <Badge tone="success">debits = credits</Badge> : <Badge tone="danger">out of balance</Badge>} />
      <Table>
        <THead><tr><TH>Account</TH><TH align="right">Debit</TH><TH align="right">Credit</TH></tr></THead>
        <tbody>
          {r.lines.map((l) => <TR key={l.account.id}><TD><Link className="hover:underline" href={`/finance/reports?report=ledger&account=${l.account.id}`}>{l.account.code} {l.account.name}</Link></TD><TD align="right">{l.debit !== "0.00" ? <Money value={l.debit} currency={r.currency} /> : ""}</TD><TD align="right">{l.credit !== "0.00" ? <Money value={l.credit} currency={r.currency} /> : ""}</TD></TR>)}
          <TR className="font-semibold"><TD>Total</TD><TD align="right"><Money value={r.totalDebit} currency={r.currency} /></TD><TD align="right"><Money value={r.totalCredit} currency={r.currency} /></TD></TR>
        </tbody>
      </Table>
    </Card>
  );
}

function Gl({ r, base }: { r: Awaited<ReturnType<typeof generalLedger>>; base: string }) {
  return (
    <Card>
      <CardHeader title={`${r.account.code} ${r.account.name}`} description={`${r.from} → ${r.to}. Running balance shown as debit − credit in ${base}.`} />
      <Table>
        <THead><tr><TH>Date</TH><TH>Entry</TH><TH>Description</TH><TH align="right">Debit</TH><TH align="right">Credit</TH><TH align="right">Balance</TH></tr></THead>
        <tbody>
          <TR className="font-medium"><TD colSpan={5}>Opening balance</TD><TD align="right" className="num">{Number(r.opening).toFixed(2)}</TD></TR>
          {r.lines.map(({ line, entry, running }) => <TR key={line.id}><TD><DateText value={entry.entryDate} /></TD><TD><Link className="hover:underline" href={`/finance/accounting/journals/${entry.id}`}>{entry.number}</Link></TD><TD className="text-[12.5px]">{line.description ?? entry.memo}</TD><TD align="right" className="num">{Number(line.debit) ? Number(line.debit).toFixed(2) : ""}</TD><TD align="right" className="num">{Number(line.credit) ? Number(line.credit).toFixed(2) : ""}</TD><TD align="right" className="num">{Number(running).toFixed(2)}</TD></TR>)}
          <TR className="font-semibold"><TD colSpan={5}>Closing balance</TD><TD align="right" className="num">{Number(r.closing).toFixed(2)}</TD></TR>
        </tbody>
      </Table>
    </Card>
  );
}

function Revenue({ r, label }: { r: Awaited<ReturnType<typeof revenueByServiceAndClient>>; label: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title={`Recognised revenue by service — ${label}`} description={`Total ${r.total} ${r.currency}`} />
        <Table><tbody>{r.byService.map((x) => <TR key={x.account.id}><TD>{x.account.name}</TD><TD align="right"><Money value={x.amount} currency={r.currency} /></TD></TR>)}</tbody></Table>
      </Card>
      <Card>
        <CardHeader title="By client" />
        {r.byClient.length ? <Table><tbody>{r.byClient.map((x) => <TR key={x.id}><TD><Link className="hover:underline" href={`/crm/accounts/${x.id}?tab=financials`}>{x.name}</Link></TD><TD align="right"><Money value={x.amount} currency={r.currency} /></TD></TR>)}</tbody></Table> : <EmptyState title="No revenue in this period" />}
      </Card>
    </div>
  );
}

async function Budget({ fy, ledgers, canAdmin }: { fy: number; ledgers: (typeof ledgerAccounts.$inferSelect)[]; canAdmin: boolean }) {
  const r = await budgetVsActual(db, fy);
  return (
    <div className="space-y-4">
      <div className="flex gap-2 text-[13px]">{[fy - 1, fy, fy + 1].map((y) => <Link key={y} className={y === fy ? "font-semibold text-accent" : "hover:underline"} href={`/finance/reports?report=budget&fy=${y}`}>FY{y}</Link>)}</div>
      {!r.hasBudget ? <Notice>No budget has been entered for FY{fy}. Actuals are shown; enter annual budgets per account below.</Notice> : null}
      <Card>
        <CardHeader title={`Budget vs actual — FY${fy}`} description={`${r.from} → ${r.to}, ${r.currency}. Variance = actual − budget.`} />
        {r.rows.length ? (
          <Table>
            <THead><tr><TH>Account</TH><TH align="right">Budget</TH><TH align="right">Actual</TH><TH align="right">Variance</TH><TH align="right">%</TH></tr></THead>
            <tbody>{r.rows.map((x) => <TR key={x.account.id}><TD>{x.account.code} {x.account.name}<span className="ml-1 text-[12px] text-muted">{x.account.type}</span></TD><TD align="right"><Money value={x.budget} currency={r.currency} /></TD><TD align="right"><Money value={x.actual} currency={r.currency} /></TD><TD align="right"><Money value={x.variance} currency={r.currency} sign /></TD><TD align="right">{x.variancePct ? `${x.variancePct}%` : "—"}</TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No budget or activity" />}
      </Card>
      {canAdmin ? (
        <Card className="max-w-3xl">
          <CardHeader title="Set an annual budget" />
          <CardBody>
            <ActionForm action={budgetAction}>
              <input type="hidden" name="fiscalYear" value={fy} />
              <FormGrid cols={3}>
                <Field label="Account"><Select name="ledgerAccountId" options={ledgers.filter((l) => l.type === "income" || l.type === "expense").map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }))} /></Field>
                <Field label="Annual amount"><Input name="annualAmount" inputMode="decimal" required /></Field>
                <Field label="Note"><Input name="note" /></Field>
              </FormGrid>
              <div className="mt-3 flex justify-end"><SubmitButton size="sm">Save budget</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

import Link from "next/link";
import { asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { forecastAdjustments, forecastScenarios } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { cashForecast, type ForecastScenarioKey } from "@/server/finance/forecast";
import { forecastAdjustmentAction, forecastScenarioAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, MetricCard, Money, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { CashChart } from "@/components/finance/cash-chart";

export const metadata = { title: "Cash & working capital" };

const SCEN: { key: ForecastScenarioKey; label: string }[] = [{ key: "base", label: "Base" }, { key: "conservative", label: "Conservative" }, { key: "upside", label: "Upside" }];
const KIND: Record<string, string> = { receivable: "Invoice collections", billing: "Planned billing", pipeline: "Weighted pipeline", payable: "Supplier bills", reimbursement: "Expense reimbursements", adjustment: "Manual adjustments" };

export default async function CashPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const key = (SCEN.some((s) => s.key === sp.scenario) ? sp.scenario : "base") as ForecastScenarioKey;
  let f: Awaited<ReturnType<typeof cashForecast>> | null = null;
  let error: string | null = null;
  try {
    f = await cashForecast(db, key);
  } catch (e) {
    error = e instanceof Error ? e.message : "Forecast unavailable";
  }
  const wc = (await db.execute<{ kind: string; currency: string; amount: string }>(sql`
    select 'ar' as kind, i.currency, sum(i.total - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id and pa.reversed_at is null),0) - coalesce((select sum(cn.total) from credit_notes cn where cn.invoice_id = i.id and cn.status='issued'),0))::text as amount from invoices i where i.status='issued' group by i.currency
    union all
    select 'ap', b.currency, sum(b.total - coalesce((select sum(a.amount) from supplier_payment_allocations a where a.bill_id = b.id and a.reversed_at is null),0))::text from bills b where b.status='approved' group by b.currency
    union all
    select 'unapplied', p.currency, sum(p.amount - coalesce((select sum(a.amount) from payment_allocations a where a.payment_id = p.id and a.reversed_at is null),0))::text from customer_payments p where p.status='recorded' group by p.currency
    union all
    select 'reimburse', e.currency, sum(e.amount)::text from expenses e where e.status='approved' and e.paid_from='personal' group by e.currency`)).rows.filter((r) => Number(r.amount) !== 0);
  const scenario = (await db.select().from(forecastScenarios).where(eq(forecastScenarios.key, key)))[0];
  const adjustments = await db.select().from(forecastAdjustments).orderBy(asc(forecastAdjustments.weekStart), desc(forecastAdjustments.createdAt));
  const canWrite = can(actor, "finance.write");
  const line = (k: string) => wc.filter((r) => r.kind === k);
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Cash & working capital" }]} title="Cash & working capital" description="Thirteen-week cash forecast. Opening cash is actual (posted bank balances); every later figure is a forecast with its assumption shown." />
      <Tabs current={key} tabs={SCEN.map((s) => ({ key: s.key, label: `${s.label} scenario`, href: `/finance/cash${s.key === "base" ? "" : `?scenario=${s.key}`}` }))} />
      {error || !f ? <Notice tone="warning" className="mt-4" title="Forecast unavailable">{error} — usually a missing exchange rate. Record it under Accounting → FX rates.</Notice> : (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Opening cash (actual)" value={f.opening} currency={f.baseCurrency} href="/finance/bank" basis="Posted ledger balance of all active bank accounts, converted at today's rate." range={`At ${f.today}`} detail={f.openingDetail.map((o) => ({ label: o.name, value: o.native, currency: o.currency }))} />
            <MetricCard label="Lowest projected balance" value={f.lowest.closing} currency={f.baseCurrency} href="#weeks" basis="Minimum weekly closing balance across the 13 weeks under this scenario." range={`Week of ${f.lowest.week}`} unavailableReason={f.lowest.belowThreshold ? "Below the minimum cash threshold" : undefined} />
            <MetricCard label="Closing after 13 weeks" value={f.weeks[12].closing} currency={f.baseCurrency} href="#weeks" basis="Opening cash + forecast inflows − forecast outflows." range={`Week of ${f.weeks[12].week}`} />
            <MetricCard label="Minimum cash threshold" value={f.threshold} currency={f.baseCurrency} href="/system/settings" basis="Set in agency settings; weeks below it are flagged." range="Setting" unavailableReason={f.threshold ? undefined : "Not set"} />
          </div>
          <Card>
            <CardHeader title="Projected closing cash" description={f.basis} />
            <CardBody><CashChart data={f.weeks.map((w) => ({ week: w.week, closing: Number(w.closing), inflow: Number(w.inflow), outflow: Number(w.outflow) }))} currency={f.baseCurrency} threshold={f.threshold ? Number(f.threshold) : null} /></CardBody>
          </Card>
          <Card id="weeks">
            <CardHeader title="Weekly view" description="Expand a week to see each movement, where it comes from and its assumption." />
            <Table>
              <THead><tr><TH>Week of</TH><TH align="right">Opening</TH><TH align="right">In</TH><TH align="right">Out</TH><TH align="right">Closing</TH></tr></THead>
              <tbody>
                {f.weeks.map((w) => {
                  const ms = f!.movements.filter((m) => m.week === w.week && m.kind !== "actual_opening");
                  return (
                    <TR key={w.week}>
                      <TD>
                        <DateText value={w.week} />
                        {ms.length ? (
                          <details className="mt-1 text-[12.5px]">
                            <summary className="cursor-pointer text-accent">{ms.length} movement{ms.length > 1 ? "s" : ""}</summary>
                            <ul className="mt-1 space-y-1">
                              {ms.map((m, i) => <li key={i} className="flex justify-between gap-4"><span>{m.href ? <Link className="hover:underline" href={m.href}>{m.label}</Link> : m.label} <span className="text-muted">· {KIND[m.kind] ?? m.kind}{m.assumption ? ` · ${m.assumption}` : ""}</span></span><Money value={m.baseAmount} currency={f!.baseCurrency} className={Number(m.baseAmount) < 0 ? "text-danger" : ""} /></li>)}
                            </ul>
                          </details>
                        ) : null}
                      </TD>
                      <TD align="right"><Money value={w.opening} currency={f!.baseCurrency} /></TD>
                      <TD align="right"><Money value={w.inflow} currency={f!.baseCurrency} /></TD>
                      <TD align="right"><Money value={w.outflow} currency={f!.baseCurrency} /></TD>
                      <TD align="right" className="font-medium"><Money value={w.closing} currency={f!.baseCurrency} />{w.belowThreshold ? <Badge tone="danger" className="ml-1">below minimum</Badge> : null}</TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Working capital today" description="Actual balances by currency (not converted)." />
          <Table>
            <THead><tr><TH>Item</TH><TH align="right">Amount</TH></tr></THead>
            <tbody>
              {line("ar").map((r) => <TR key={`ar${r.currency}`}><TD><Link className="hover:underline" href="/finance/collections?tab=aging">Receivables outstanding</Link></TD><TD align="right"><Money value={r.amount} currency={r.currency} /></TD></TR>)}
              {line("unapplied").map((r) => <TR key={`un${r.currency}`}><TD><Link className="hover:underline" href="/finance/collections?tab=payments">Unapplied client payments (credit)</Link></TD><TD align="right"><Money value={r.amount} currency={r.currency} /></TD></TR>)}
              {line("ap").map((r) => <TR key={`ap${r.currency}`}><TD><Link className="hover:underline" href="/finance/bills?tab=pay">Supplier bills unpaid</Link></TD><TD align="right"><Money value={r.amount} currency={r.currency} /></TD></TR>)}
              {line("reimburse").map((r) => <TR key={`re${r.currency}`}><TD><Link className="hover:underline" href="/finance/bills?tab=expenses&status=approved">Expenses owed to staff</Link></TD><TD align="right"><Money value={r.amount} currency={r.currency} /></TD></TR>)}
              {!wc.length ? <TR><TD colSpan={2}>Nothing outstanding.</TD></TR> : null}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title={`${SCEN.find((s) => s.key === key)!.label} scenario assumptions`} />
          <CardBody>
            {canWrite ? (
              <ActionForm action={forecastScenarioAction}>
                <input type="hidden" name="key" value={key} />
                <FormGrid cols={2}>
                  <Field label="Collection delay (days after due)"><Input type="number" name="collectionDelayDays" defaultValue={scenario?.collectionDelayDays ?? f?.scenario.collectionDelayDays ?? 0} /></Field>
                  <Field label="Share of receivables collected (%)"><Input type="number" min={0} max={100} name="collectionRatePercent" defaultValue={scenario?.collectionRatePercent ?? 100} /></Field>
                  <Field label="Weighted pipeline included (%)"><Input type="number" min={0} max={100} name="pipelineInclusionPercent" defaultValue={scenario?.pipelineInclusionPercent ?? 0} /></Field>
                  <Field label="Costs multiplier (%)"><Input type="number" min={0} name="expenseMultiplierPercent" defaultValue={scenario?.expenseMultiplierPercent ?? 100} /></Field>
                </FormGrid>
                <Field label="Notes" className="mt-2"><Textarea name="notes" rows={2} defaultValue={scenario?.notes ?? ""} /></Field>
                <div className="mt-2 flex justify-end"><SubmitButton size="sm">Save assumptions</SubmitButton></div>
              </ActionForm>
            ) : <p className="text-[13px]">Delay {f?.scenario.collectionDelayDays}d · collect {f?.scenario.collectionRatePercent}% · pipeline {f?.scenario.pipelineInclusionPercent}% · costs {f?.scenario.expenseMultiplierPercent}%</p>}
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Manual adjustments" description="Known future items not yet in the books (payroll, rent, tax payments). They are assumptions and never touch the ledger." />
        {adjustments.length ? (
          <Table>
            <THead><tr><TH>Week</TH><TH>Description</TH><TH>Scenario</TH><TH>Repeats</TH><TH align="right">Amount</TH>{canWrite ? <TH /> : null}</tr></THead>
            <tbody>{adjustments.map((a) => <TR key={a.id}><TD><DateText value={a.weekStart} /></TD><TD>{a.description}</TD><TD>{a.scenarioKey}</TD><TD>{a.recurring}</TD><TD align="right"><Money value={a.direction === "outflow" ? `-${a.amount}` : a.amount} currency={a.currency} /></TD>{canWrite ? <TD align="right"><ActionForm action={forecastAdjustmentAction} hideSuccess><input type="hidden" name="op" value="delete" /><input type="hidden" name="id" value={a.id} /><SubmitButton size="sm" variant="ghost">Remove</SubmitButton></ActionForm></TD> : null}</TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No adjustments" />}
        {canWrite ? (
          <CardBody className="border-t border-line">
            <ActionForm action={forecastAdjustmentAction} resetOnSuccess>
              <input type="hidden" name="op" value="add" />
              <FormGrid cols={4}>
                <Field label="Week starting"><Input type="date" name="weekStart" required defaultValue={f?.weeks[0].week} /></Field>
                <Field label="Description"><Input name="description" required placeholder="e.g. Payroll" /></Field>
                <Field label="Direction"><Select name="direction" options={[{ value: "outflow", label: "Money out" }, { value: "inflow", label: "Money in" }]} /></Field>
                <Field label="Amount"><Input name="amount" inputMode="decimal" required /></Field>
                <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={f?.baseCurrency} /></Field>
                <Field label="Repeats"><Select name="recurring" options={[{ value: "none", label: "Once" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} /></Field>
                <Field label="Scenario"><Select name="scenarioKey" options={[{ value: "all", label: "All scenarios" }, ...SCEN.map((s) => ({ value: s.key, label: s.label }))]} /></Field>
                <div className="self-end"><SubmitButton size="sm">Add adjustment</SubmitButton></div>
              </FormGrid>
            </ActionForm>
          </CardBody>
        ) : null}
      </Card>
    </>
  );
}

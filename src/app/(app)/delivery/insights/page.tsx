import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { canSeeCost } from "@/server/delivery/time";
import { engagementProfitability, rollUp } from "@/server/finance/profitability";
import { d } from "@/lib/money";
import { Card, CardHeader, EmptyState, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Money, Progress } from "@/components/ui/display";

export const metadata = { title: "Client insights" };

export default async function InsightsPage() {
  const actor = await guard("finance.read");
  const showCost = canSeeCost(actor);
  const { baseCurrency, rows } = await engagementProfitability(db);
  const byClient = rollUp(rows, "accountId");
  const totalRevenue = byClient.reduce((a, c) => a.plus(d(c.revenue)), d(0));
  const pay = (await db.execute<{ account_id: string; days: string; n: number }>(sql`
    select i.account_id, round(sum((pa.allocation_date - i.issue_date) * pa.amount) / nullif(sum(pa.amount),0), 1)::text as days, count(*)::int as n
    from payment_allocations pa join invoices i on i.id = pa.invoice_id
    where pa.reversed_at is null and i.issue_date is not null group by i.account_id`)).rows;
  const terms = (await db.execute<{ account_id: string; terms: string }>(sql`select account_id, round(avg(due_date - issue_date),0)::text as terms from invoices where status = 'issued' and issue_date is not null group by account_id`)).rows;
  const services = rollUp(rows, "serviceId");
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: "Client insights" }]} title="Client insights" description="Revenue concentration, profitability and payment behaviour by client — from posted ledger entries and recorded payments only." />
      {!showCost ? <Notice className="mb-4">Cost and margin are hidden: they need cost-rate access.</Notice> : null}
      <Card className="mb-4">
        <CardHeader title="Revenue and margin by client" description={`Recognised revenue to date in ${baseCurrency}. Share = client revenue ÷ all recognised revenue.`} />
        {byClient.length ? (
          <Table>
            <THead><tr><TH>Client</TH><TH align="right">Engagements</TH><TH align="right">Recognised revenue</TH><TH>Share</TH>{showCost ? <><TH align="right">Direct cost</TH><TH align="right">Margin</TH></> : null}<TH align="right">Avg days to pay</TH><TH align="right">Avg terms</TH></tr></THead>
            <tbody>
              {byClient.map((c) => {
                const share = totalRevenue.isZero() ? 0 : d(c.revenue).div(totalRevenue).times(100).toNumber();
                const p = pay.find((x) => x.account_id === c.id);
                const t = terms.find((x) => x.account_id === c.id);
                const slow = p && t && Number(p.days) > Number(t.terms) + 7;
                return (
                  <TR key={c.id}>
                    <TD><Link className="font-medium hover:underline" href={`/crm/accounts/${c.id}?tab=financials`}>{c.name}</Link></TD>
                    <TD align="right">{c.engagements}</TD>
                    <TD align="right"><Money value={c.revenue} currency={baseCurrency} /></TD>
                    <TD className="min-w-[140px]"><div className="flex items-center gap-2"><div className="flex-1"><Progress value={share} tone={share > 40 ? "warning" : "accent"} /></div><span className="num w-10 text-right text-[12px]">{share.toFixed(0)}%</span></div></TD>
                    {showCost ? <><TD align="right"><Money value={c.directCost} currency={baseCurrency} /></TD><TD align="right"><Money value={c.grossMargin} currency={baseCurrency} emphasize="negative" />{c.marginPct ? <div className="text-[12px] text-muted">{c.marginPct}%</div> : null}</TD></> : null}
                    <TD align="right" className={slow ? "text-warning" : ""}>{p ? `${p.days}d` : "—"}{p ? <div className="text-[11.5px] text-muted">{p.n} payment(s)</div> : null}</TD>
                    <TD align="right">{t ? `${t.terms}d` : "—"}</TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No recognised revenue yet" />}
        <p className="border-t border-line px-4 py-2 text-[12px] text-muted">Avg days to pay = amount-weighted days from invoice issue to payment allocation. A share above 40% is highlighted as concentration risk.</p>
      </Card>
      <Card>
        <CardHeader title="By service stream" />
        <Table>
          <THead><tr><TH>Service</TH><TH align="right">Engagements</TH><TH align="right">Recognised revenue</TH>{showCost ? <><TH align="right">Labour</TH><TH align="right">Contractors</TH><TH align="right">Other direct</TH><TH align="right">Margin</TH></> : null}</tr></THead>
          <tbody>{services.map((s) => <TR key={s.id}><TD className="font-medium">{s.name}</TD><TD align="right">{s.engagements}</TD><TD align="right"><Money value={s.revenue} currency={baseCurrency} /></TD>{showCost ? <><TD align="right"><Money value={s.laborCost} currency={baseCurrency} /></TD><TD align="right"><Money value={s.contractorCost} currency={baseCurrency} /></TD><TD align="right"><Money value={s.otherDirectCost} currency={baseCurrency} /></TD><TD align="right"><Money value={s.grossMargin} currency={baseCurrency} emphasize="negative" />{s.marginPct ? <div className="text-[12px] text-muted">{s.marginPct}%</div> : null}</TD></> : null}</TR>)}</tbody>
        </Table>
      </Card>
    </>
  );
}

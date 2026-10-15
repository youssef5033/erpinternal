import Link from "next/link";
import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { canSeeCost } from "@/server/delivery/time";
import { engagementProfitability, rollUp } from "@/server/finance/profitability";
import { agencyToday, getSettings } from "@/server/system/settings";
import { isISODate, resolvePeriod } from "@/lib/dates";
import { qs } from "@/lib/utils";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { PERIOD_OPTIONS } from "@/components/crm/analytics-filters";

export const metadata = { title: "Margins" };

export default async function MarginsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("reports.read");
  const sp = await searchParams;
  if (!canSeeCost(actor)) return (<><PageHeader crumbs={[{ label: "Finance" }, { label: "Margins" }]} title="Margins" /><Notice>Margins use people's cost rates, which your role cannot see.</Notice></>);
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const allTime = !sp.period && !sp.from;
  const p = isISODate(sp.from) && isISODate(sp.to) ? { from: sp.from!, to: sp.to!, label: `${sp.from} → ${sp.to}` } : sp.period ? resolvePeriod(sp.period, today, s.fiscalYearStartMonth) : null;
  const { baseCurrency, rows } = await engagementProfitability(db, p ? { from: p.from, to: p.to } : {});
  const by = sp.by === "client" ? "client" : sp.by === "service" ? "service" : sp.by === "offer" ? "offer" : "engagement";
  const groups = by === "client" ? rollUp(rows, "accountId") : by === "service" ? rollUp(rows, "serviceId") : by === "offer" ? rollUp(rows, "offerId") : null;
  const active = rows.filter((r) => Number(r.revenue) || Number(r.directCost));
  const tot = active.reduce((a, r) => ({ rev: a.rev + Number(r.revenue), cost: a.cost + Number(r.directCost) }), { rev: 0, cost: 0 });
  const missing = rows.reduce((a, r) => a + Number(r.missingCostRateHours), 0);
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Margins" }]} title="Margins" description={`Gross margin = recognised revenue − direct cost (labour at cost rate, contractors, direct expenses). ${allTime ? "All time" : p?.label}. Base currency ${baseCurrency}.`} />
      <FilterBar keep={["by"]} fields={[{ type: "select", name: "period", label: "Period", options: PERIOD_OPTIONS, allLabel: "All time" }, { type: "date", name: "from", label: "From" }, { type: "date", name: "to", label: "To" }]} />
      {missing > 0 ? <Notice tone="warning" className="mb-3" title="Labour cost incomplete">{missing.toFixed(1)} approved hours have no cost rate on their work date, so those engagements' margins are overstated. Add cost rates under People.</Notice> : null}
      <p className="mb-3 text-[13px]">Total: revenue <Money value={tot.rev.toFixed(2)} currency={baseCurrency} /> · direct cost <Money value={tot.cost.toFixed(2)} currency={baseCurrency} /> · margin <Money value={(tot.rev - tot.cost).toFixed(2)} currency={baseCurrency} emphasize="negative" />{tot.rev ? ` (${(((tot.rev - tot.cost) / tot.rev) * 100).toFixed(1)}%)` : ""}</p>
      <Tabs current={by} tabs={["engagement", "client", "service", "offer"].map((k) => ({ key: k, label: `By ${k}`, href: `/finance/margins${qs({ ...sp, by: k === "engagement" ? null : k })}` }))} />
      <Card className="mt-3">
        <CardHeader title={`Margin by ${by}`} />
        {groups ? (
          groups.length ? (
            <Table>
              <THead><tr><TH>{by}</TH><TH align="right">Engagements</TH><TH align="right">Revenue</TH><TH align="right">Labour</TH><TH align="right">Contractors</TH><TH align="right">Other direct</TH><TH align="right">Margin</TH><TH align="right">%</TH></tr></THead>
              <tbody>{groups.map((g) => <TR key={g.id}><TD className="font-medium">{g.name}</TD><TD align="right">{g.engagements}</TD><TD align="right"><Money value={g.revenue} currency={baseCurrency} /></TD><TD align="right"><Money value={g.laborCost} currency={baseCurrency} /></TD><TD align="right"><Money value={g.contractorCost} currency={baseCurrency} /></TD><TD align="right"><Money value={g.otherDirectCost} currency={baseCurrency} /></TD><TD align="right"><Money value={g.grossMargin} currency={baseCurrency} emphasize="negative" /></TD><TD align="right">{g.marginPct ? `${g.marginPct}%` : "—"}</TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="No activity" />
        ) : active.length ? (
          <Table>
            <THead><tr><TH>Engagement</TH><TH align="right">Revenue</TH><TH align="right">Invoiced</TH><TH align="right">Direct cost</TH><TH align="right">Margin</TH><TH align="right">%</TH><TH align="right">Hours used</TH><TH>Flags</TH></tr></THead>
            <tbody>
              {active.map((r) => (
                <TR key={r.engagementId}>
                  <TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${r.engagementId}?tab=budget`}>{r.name}</Link><div className="text-[12px] text-muted">{r.number} · {r.accountName} · {r.serviceName}</div></TD>
                  <TD align="right"><Money value={r.revenue} currency={baseCurrency} /></TD>
                  <TD align="right"><Money value={r.invoicedNet} currency={baseCurrency} /></TD>
                  <TD align="right"><Money value={r.directCost} currency={baseCurrency} /></TD>
                  <TD align="right"><Money value={r.grossMargin} currency={baseCurrency} emphasize="negative" /></TD>
                  <TD align="right">{r.marginPct ? `${r.marginPct}%` : "—"}</TD>
                  <TD align="right">{r.hoursUsedPct ? `${r.hoursUsedPct}%` : "—"}</TD>
                  <TD className="space-x-1">{r.overBudget ? <Badge tone="danger">over budget</Badge> : null}{Number(r.missingCostRateHours) ? <Badge tone="warning">missing cost rates</Badge> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No revenue or cost in this period" />}
      </Card>
    </>
  );
}

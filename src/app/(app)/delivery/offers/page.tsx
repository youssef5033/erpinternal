import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { offers, services } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { canSeeCost } from "@/server/delivery/time";
import { engagementProfitability, rollUp } from "@/server/finance/profitability";
import { Card, CardHeader, EmptyState, Notice, PageHeader, ServiceBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Money } from "@/components/ui/display";

export const metadata = { title: "Offer performance" };

export default async function OffersPage() {
  const actor = await guard("reports.read");
  const list = await db
    .select({
      o: offers,
      serviceName: services.name,
      serviceKey: services.key,
      opps: sql<number>`(select count(distinct os.opportunity_id) from opportunity_services os where os.offer_id = "offers"."id")`,
      won: sql<number>`(select count(distinct o.id) from opportunity_services os join opportunities o on o.id = os.opportunity_id where os.offer_id = "offers"."id" and o.status = 'won')`,
      lost: sql<number>`(select count(distinct o.id) from opportunity_services os join opportunities o on o.id = os.opportunity_id where os.offer_id = "offers"."id" and o.status = 'lost')`,
      engs: sql<number>`(select count(*) from engagements e where e.offer_id = "offers"."id")`,
    })
    .from(offers)
    .innerJoin(services, eq(services.id, offers.serviceId))
    .orderBy(services.sortOrder, offers.name);
  const showMargin = can(actor, "finance.read") && canSeeCost(actor);
  const prof = showMargin ? await engagementProfitability(db) : null;
  const byOffer = prof ? rollUp(prof.rows, "offerId") : [];
  const base = prof?.baseCurrency ?? null;
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: "Offer performance" }]} title="Offer performance" description="How each packaged offer sells and delivers. Win rate counts closed deals only; margin uses posted revenue and approved costs." />
      {!showMargin ? <Notice className="mb-4">Revenue and margin columns need finance and cost-rate access.</Notice> : null}
      <Card>
        <CardHeader title="Offers" />
        {list.length ? (
          <Table>
            <THead><tr><TH>Offer</TH><TH>Service</TH><TH align="right">Opportunities</TH><TH align="right">Won / lost</TH><TH align="right">Win rate</TH><TH align="right">Engagements</TH>{showMargin ? <><TH align="right">Recognised revenue</TH><TH align="right">Direct cost</TH><TH align="right">Margin</TH></> : null}</tr></THead>
            <tbody>
              {list.map(({ o, serviceName, serviceKey, opps, won, lost, engs }) => {
                const p = byOffer.find((x) => x.id === o.id);
                const closed = Number(won) + Number(lost);
                return (
                  <TR key={o.id}>
                    <TD><span className="font-medium">{o.name}</span>{!o.active ? <span className="ml-1 text-[12px] text-muted">(inactive)</span> : null}</TD>
                    <TD><ServiceBadge serviceKey={serviceKey} name={serviceName} /></TD>
                    <TD align="right">{Number(opps)}</TD>
                    <TD align="right">{Number(won)} / {Number(lost)}</TD>
                    <TD align="right">{closed ? `${((Number(won) / closed) * 100).toFixed(0)}%` : "—"}</TD>
                    <TD align="right">{Number(engs)}</TD>
                    {showMargin ? <><TD align="right"><Money value={p?.revenue ?? "0"} currency={base} /></TD><TD align="right"><Money value={p?.directCost ?? "0"} currency={base} /></TD><TD align="right">{p ? <><Money value={p.grossMargin} currency={base} emphasize="negative" />{p.marginPct ? <div className="text-[12px] text-muted">{p.marginPct}%</div> : null}</> : "—"}</TD></> : null}
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No offers configured" description="Add offers under System → Services & offers." />}
      </Card>
    </>
  );
}

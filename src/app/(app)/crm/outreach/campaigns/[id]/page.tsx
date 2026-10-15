import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, campaigns, leads, opportunities, pipelineStages, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { leadVisibility, opportunityVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { getRate } from "@/server/finance/ledger";
import { getSettings } from "@/server/system/settings";
import { d, Decimal } from "@/lib/money";
import { Card, CardBody, CardHeader, DefinitionList, EmptyState, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, MetricCard, Money } from "@/components/ui/display";
import { CampaignForm } from "@/components/crm/outreach-forms";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [c] = await db.select({ c: campaigns, ownerName: user.name }).from(campaigns).leftJoin(user, eq(user.id, campaigns.ownerId)).where(eq(campaigns.id, id));
  if (!c) notFound();
  const L = await crmLookups();
  const s = await getSettings(db);
  const ls = await db.select({ l: leads, ownerName: user.name }).from(leads).leftJoin(user, eq(user.id, leads.ownerId)).where(and(eq(leads.campaignId, id), ne(leads.status, "merged"), leadVisibility(actor))).orderBy(desc(leads.dateAdded));
  const os = await db.select({ o: opportunities, accountName: accounts.name, stage: pipelineStages.name }).from(opportunities).innerJoin(accounts, eq(accounts.id, opportunities.accountId)).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).where(and(eq(opportunities.campaignId, id), opportunityVisibility(actor))).orderBy(desc(opportunities.createdAt));
  const won = os.filter((x) => x.o.status === "won");
  let wonValue = new Decimal(0);
  const missing = new Set<string>();
  for (const w of won) {
    try {
      wonValue = wonValue.plus(d(w.o.closedValue ?? w.o.value).times((await getRate(db, w.o.currency, s.baseCurrency, w.o.wonAt!.toISOString().slice(0, 10))).rate));
    } catch {
      missing.add(w.o.currency);
    }
  }
  const camp = c.c;
  const costPerWin = camp.cost && won.length ? d(camp.cost).div(won.length).toFixed(2) : null;
  return (
    <>
      <PageHeader crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Campaigns", href: "/crm/outreach?tab=campaigns" }, { label: camp.name }]} title={camp.name} meta={<StatusBadge status={camp.status} />} description={camp.goal ?? undefined} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Leads attributed" value={String(ls.length)} currency={null} href={`/crm/leads?include=all&campaign=${id}`} basis="Leads whose first-touch campaign is this campaign (merged duplicates excluded)." range="All time" detail={[{ label: "Qualified or converted", value: String(ls.filter((x) => ["qualified", "converted"].includes(x.l.status)).length) }]} />
        <MetricCard label="Opportunities" value={String(os.length)} currency={null} href={`/crm/opportunities?status=all&campaign=${id}`} basis="Opportunities whose first-touch campaign is this campaign." range="All time" detail={[{ label: "Won", value: String(won.length) }, { label: "Lost", value: String(os.filter((x) => x.o.status === "lost").length) }]} />
        <MetricCard label="Bookings" value={wonValue.toFixed(2)} currency={s.baseCurrency} href={`/crm/opportunities?status=won&campaign=${id}`} basis="Closed value of won deals at the rate on each win date." range="All time" unavailableReason={missing.size ? `Missing rates for ${Array.from(missing).join(", ")}` : undefined} />
        <MetricCard label="Cost per win" value={costPerWin} currency={camp.currency} href={`/crm/outreach/campaigns/${id}`} basis="Recorded campaign cost ÷ won deals attributed to it." range="All time" unavailableReason={!camp.cost ? "No campaign cost recorded." : !won.length ? "No won deals yet." : undefined} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <DefinitionList items={[{ label: "Channel", value: L.channelLabel(camp.channel) }, { label: "Owner", value: c.ownerName ?? "—" }, { label: "Dates", value: <><DateText value={camp.startDate} /> – <DateText value={camp.endDate} /></> }, { label: "Segment", value: camp.targetSegment ?? "—" }, { label: "Cost", value: camp.cost ? <Money value={camp.cost} currency={camp.currency} /> : "Not recorded" }, { label: "Outcome notes", value: camp.outcomeNotes ?? "—", full: true }]} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Opportunities" />
          {os.length ? (
            <Table>
              <THead><tr><TH>Opportunity</TH><TH>Stage</TH><TH align="right">Value</TH></tr></THead>
              <tbody>{os.map(({ o, accountName, stage }) => <TR key={o.id}><TD><Link className="font-medium hover:underline" href={`/crm/opportunities/${o.id}`}>{o.name}</Link><div className="text-[12px] text-muted">{accountName}</div></TD><TD>{o.status === "open" ? stage : <StatusBadge status={o.status} />}</TD><TD align="right"><Money value={o.closedValue ?? o.value} currency={o.currency} /></TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="No opportunities attributed" />}
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Leads" />
        {ls.length ? (
          <Table>
            <THead><tr><TH>Company</TH><TH>Status</TH><TH>Added</TH><TH>Owner</TH></tr></THead>
            <tbody>{ls.map(({ l, ownerName }) => <TR key={l.id}><TD><Link className="font-medium hover:underline" href={`/crm/leads/${l.id}`}>{l.companyName}</Link></TD><TD><StatusBadge status={l.status} /></TD><TD><DateText value={l.dateAdded} /></TD><TD>{ownerName ?? "—"}</TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No leads attributed" />}
      </Card>
      {can(actor, "crm.write") ? (
        <Card className="mt-4">
          <CardHeader title="Edit campaign" />
          <CardBody><CampaignForm services={L.services} offers={L.offers.map((o) => ({ value: o.id, label: o.name }))} users={L.users} channels={L.channels} c={camp} /></CardBody>
        </Card>
      ) : null}
    </>
  );
}

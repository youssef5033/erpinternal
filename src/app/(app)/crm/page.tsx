import Link from "next/link";
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, opportunities, pipelineStages, proposals, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility, opportunityVisibility } from "@/server/auth/scope";
import { crmAnalytics } from "@/server/crm/analytics";
import { crmLookups } from "@/server/crm/lookups";
import { getRate } from "@/server/finance/ledger";
import { agencyToday, getSettings } from "@/server/system/settings";
import { d, Decimal } from "@/lib/money";
import { addDaysISO } from "@/lib/dates";
import { Badge, Card, CardHeader, EmptyState, LinkButton, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, MetricCard, Money } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { drill, parseCrmFilters, PERIOD_OPTIONS } from "@/components/crm/analytics-filters";

export const metadata = { title: "CRM overview" };

export default async function CrmOverviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const settings = await getSettings(db);
  const today = await agencyToday(db);
  const { f, label, ownerLocked } = parseCrmFilters(sp, actor, today, settings.fiscalYearStartMonth);
  const L = await crmLookups();
  const a = await crmAnalytics(db, f);
  const base = a.base;
  const range = `${f.from} → ${f.to} (${label})`;

  // Open pipeline right now (not period-bound), visible to this user.
  const open = await db
    .select({ o: opportunities, stage: pipelineStages, accountName: accounts.name, ownerName: user.name })
    .from(opportunities)
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .leftJoin(user, eq(user.id, opportunities.ownerId))
    .where(and(eq(opportunities.status, "open"), opportunityVisibility(actor), f.owner ? eq(opportunities.ownerId, f.owner) : undefined))
    .orderBy(asc(pipelineStages.sortOrder));
  let unweighted = new Decimal(0);
  let weighted = new Decimal(0);
  const missing = new Set<string>(a.missingRates);
  const byStage = new Map<string, { id: string; name: string; count: number; value: Decimal; weighted: Decimal }>();
  for (const r of open) {
    let rate: string;
    try {
      rate = (await getRate(db, r.o.currency, base, today)).rate;
    } catch {
      missing.add(r.o.currency);
      continue;
    }
    const v = d(r.o.value).times(rate);
    const w = v.times(r.o.probabilityOverride ?? r.stage.probability).div(100);
    unweighted = unweighted.plus(v);
    weighted = weighted.plus(w);
    const g = byStage.get(r.stage.id) ?? { id: r.stage.id, name: r.stage.name, count: 0, value: new Decimal(0), weighted: new Decimal(0) };
    g.count++;
    g.value = g.value.plus(v);
    g.weighted = g.weighted.plus(w);
    byStage.set(r.stage.id, g);
  }
  const noNext = open.filter((r) => !r.o.nextAction || !r.o.nextActionDate || r.o.nextActionDate < today);
  const stale = open.filter((r) => Date.now() - r.o.stageEnteredAt.getTime() > (r.stage.staleAfterDays ?? settings.staleOpportunityDays) * 86400000);

  const awaiting = await db
    .select({ p: proposals, accountName: accounts.name })
    .from(proposals)
    .innerJoin(accounts, eq(accounts.id, proposals.accountId))
    .where(and(eq(proposals.status, "sent"), accountVisibility(actor), f.owner ? eq(proposals.ownerId, f.owner) : undefined))
    .orderBy(asc(proposals.sentAt));

  const renewals = can(actor, "delivery.read")
    ? await db
        .select({ e: engagements, accountName: accounts.name })
        .from(engagements)
        .innerJoin(accounts, eq(accounts.id, engagements.accountId))
        .where(and(inArray(engagements.status, ["onboarding", "active"]), accountVisibility(actor), or(lte(engagements.renewalDate, addDaysISO(today, 90)), and(isNull(engagements.renewalDate), lte(engagements.endDate, addDaysISO(today, 90))))))
        .orderBy(asc(engagements.endDate))
        .limit(10)
    : [];

  const s = a.summary;
  const leadsHref = `/crm/leads${drill(f, { include: "all", from: f.from, to: f.to })}`;
  const oppCreated = `/crm/opportunities${drill(f, { status: "all", dateBasis: "created", from: f.from, to: f.to })}`;
  const oppWon = `/crm/opportunities${drill(f, { status: "won", dateBasis: "won", from: f.from, to: f.to })}`;
  const oppClosed = `/crm/opportunities${drill(f, { status: "all", dateBasis: "closed", from: f.from, to: f.to })}`;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial" }]}
        title="CRM overview"
        description="Lead flow, pipeline and bookings. Pipeline, bookings, invoicing and collections are reported separately — they are different numbers."
        actions={<LinkButton href={`/crm/analytics${drill(f, { period: sp.period, from: sp.from, to: sp.to })}`}>Detailed analytics</LinkButton>}
      />
      <FilterBar
        fields={[
          { type: "select", name: "period", label: "Period", options: PERIOD_OPTIONS, allLabel: "Last 90 days" },
          { type: "date", name: "from", label: "From" },
          { type: "date", name: "to", label: "To" },
          ...(ownerLocked ? [] : [{ type: "select" as const, name: "owner", label: "Owner", options: L.users }]),
          { type: "select", name: "service", label: "Service", options: L.services },
          { type: "select", name: "offer", label: "Offer", options: L.offers.map((o) => ({ value: o.id, label: o.name })) },
          { type: "select", name: "channel", label: "Channel", options: [...L.channels, { value: "unknown", label: "Unknown" }] },
          { type: "select", name: "campaign", label: "Campaign", options: L.campaigns },
          { type: "search", name: "country", label: "Country", placeholder: "e.g. GB" },
        ]}
      />
      {ownerLocked ? <Notice className="mb-4">You are seeing records you own. Ask an administrator for full CRM read access to see agency-wide numbers.</Notice> : null}
      {missing.size ? <Notice tone="warning" className="mb-4" title="Missing exchange rates">Values in {Array.from(missing).join(", ")} are excluded from base-currency totals until a rate is recorded in Finance → Accounting → FX rates.</Notice> : null}

      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Pipeline (open now)</h2>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Open pipeline (unweighted)" value={unweighted.toFixed(2)} currency={base} href="/crm/opportunities" basis="Sum of open opportunity values converted at today's rate. Not revenue, not bookings." range={`As of ${today}`} />
        <MetricCard label="Weighted pipeline" value={weighted.toFixed(2)} currency={base} href="/crm/opportunities?view=forecast" basis="Open value × stage probability (or the opportunity's override)." range={`As of ${today}`} />
        <MetricCard label="Missing next action" value={String(noNext.length)} currency={null} href="/crm/opportunities?noNext=1" basis="Open opportunities without a next action and date, or with a next-action date in the past." range={`As of ${today}`} />
        <MetricCard label="Proposals awaiting reply" value={String(awaiting.length)} currency={null} href="/crm/proposals?status=sent" basis="Proposals in Sent status (not yet accepted, declined or expired)." range={`As of ${today}`} />
      </div>

      <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted">Period performance — {label}</h2>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Leads added" value={String(s.leads)} currency={null} href={leadsHref} basis="Leads with date added in the period (merged duplicates excluded)." range={range} detail={[{ label: "Qualified", value: String(s.qualified) }, { label: "Contacted", value: String(s.contacted) }, { label: "Responded", value: String(s.responded) }]} />
        <MetricCard label="Qualification rate" value={s.qualificationRate} suffix="%" currency={null} href={leadsHref} basis="Leads added in the period that reached Qualified or were converted ÷ leads added in the period." range={range} unavailableReason={s.qualificationRate === null ? "No leads added in this period." : undefined} />
        <MetricCard label="Response rate" value={s.responseRate} suffix="%" currency={null} href={leadsHref} basis="Contacted cohort leads with at least one logged inbound reply ÷ cohort leads with at least one logged outbound touch. Replies are only counted when someone logged them — nothing is inferred." range={range} unavailableReason={s.responseRate === null ? "No outbound touches logged for this cohort." : undefined} />
        <MetricCard label="Meetings" value={String(a.meetingsBooked)} currency={null} href="/operations/calendar?view=agenda" basis="Discovery/meeting/call events linked to a lead or opportunity starting in the period." range={range} detail={[{ label: "Completed", value: String(a.meetingsCompleted) }]} />
        <MetricCard label="Opportunities created" value={String(s.opps)} currency={null} href={oppCreated} basis="Opportunities created in the period." range={range} detail={[{ label: "With a proposal sent", value: String(s.proposalsSent) }]} />
        <MetricCard label="Win rate" value={s.winRate} suffix="%" currency={null} href={oppClosed} basis="Won ÷ (won + lost) for opportunities closed in the period. Open deals are not in the denominator." range={range} detail={[{ label: "Won", value: String(s.wonCount) }, { label: "Lost", value: String(s.lostCount) }]} unavailableReason={s.winRate === null ? "No deals closed in this period." : undefined} />
        <MetricCard label="Bookings (won contract value)" value={s.wonValue} currency={base} href={oppWon} basis="Closed value of deals won in the period, at the exchange rate on the win date. Bookings are not invoiced or recognised revenue." range={range} detail={s.avgDealValue ? [{ label: "Average deal", value: s.avgDealValue, currency: base }] : []} />
        <MetricCard label="Average sales cycle" value={s.avgCycleDays === null ? null : String(s.avgCycleDays)} suffix=" days" currency={null} href={oppWon} basis="Average days from opportunity creation to win, for deals won in the period." range={range} unavailableReason={s.avgCycleDays === null ? "No deals won in this period." : undefined} />
      </div>
      {can(actor, "finance.read") ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Invoiced on deals won" value={a.invoiced} currency={base} href="/finance/invoices" basis="Issued invoices (net of discount, excluding tax) on engagements created from deals won in the period, at each invoice's rate." range={range} />
          <MetricCard label="Collected on deals won" value={a.collected} currency={base} href="/finance/collections" basis="Payment allocations (not reversed) against those invoices." range={range} />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Open pipeline by stage" description={`Base currency ${base}`} />
          {byStage.size ? (
            <Table>
              <THead><tr><TH>Stage</TH><TH align="right">Deals</TH><TH align="right">Value</TH><TH align="right">Weighted</TH></tr></THead>
              <tbody>
                {Array.from(byStage.values()).map((g) => (
                  <TR key={g.id}>
                    <TD><Link className="hover:underline" href={`/crm/opportunities?stage=${g.id}`}>{g.name}</Link></TD>
                    <TD align="right">{g.count}</TD>
                    <TD align="right"><Money value={g.value.toFixed(2)} currency={base} /></TD>
                    <TD align="right"><Money value={g.weighted.toFixed(2)} currency={base} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No open opportunities" />}
        </Card>
        <Card>
          <CardHeader title="Stage conversion" description="Opportunities created in the period that reached each stage and then the next one." />
          {a.conversion.some((c) => c.entered) ? (
            <Table>
              <THead><tr><TH>From → to</TH><TH align="right">Reached</TH><TH align="right">Advanced</TH><TH align="right">Rate</TH></tr></THead>
              <tbody>
                {a.conversion.map((c) => (
                  <TR key={c.from}><TD>{c.from} → {c.to}</TD><TD align="right">{c.entered}</TD><TD align="right">{c.advanced}</TD><TD align="right">{c.rate === null ? "—" : `${c.rate.toFixed(0)}%`}</TD></TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No stage movement in this period" />}
        </Card>
        <Card>
          <CardHeader title="Follow-ups needed" description="Open opportunities missing a current next action, or sitting in a stage too long." />
          {noNext.length || stale.length ? (
            <Table>
              <THead><tr><TH>Opportunity</TH><TH>Owner</TH><TH>Issue</TH></tr></THead>
              <tbody>
                {[...new Map([...noNext, ...stale].map((r) => [r.o.id, r])).values()].slice(0, 12).map((r) => (
                  <TR key={r.o.id}>
                    <TD><Link className="font-medium hover:underline" href={`/crm/opportunities/${r.o.id}`}>{r.o.name}</Link><div className="text-[12px] text-muted">{r.accountName} · {r.stage.name}</div></TD>
                    <TD>{r.ownerName ?? "—"}</TD>
                    <TD className="space-x-1">{noNext.includes(r) ? <Badge tone="warning">{r.o.nextActionDate && r.o.nextActionDate < today ? "next action overdue" : "no next action"}</Badge> : null}{stale.includes(r) ? <Badge tone="danger">stale</Badge> : null}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="Every open opportunity has a current next action" />}
        </Card>
        <Card>
          <CardHeader title="Proposals awaiting reply" />
          {awaiting.length ? (
            <Table>
              <THead><tr><TH>Proposal</TH><TH>Sent</TH><TH>Valid until</TH></tr></THead>
              <tbody>
                {awaiting.slice(0, 10).map(({ p, accountName }) => (
                  <TR key={p.id}>
                    <TD><Link className="font-medium hover:underline" href={`/crm/proposals/${p.id}`}>{p.title}</Link><div className="text-[12px] text-muted">{accountName}</div></TD>
                    <TD><DateText value={p.sentAt?.toISOString().slice(0, 10)} /></TD>
                    <TD><DateText value={p.validUntil} overdue={!!p.validUntil && p.validUntil < today} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No proposals awaiting a reply" />}
        </Card>
        {can(actor, "delivery.read") ? (
          <Card>
            <CardHeader title="Renewals and expansion (next 90 days)" description="Engagements whose renewal or end date falls within 90 days." />
            {renewals.length ? (
              <Table>
                <THead><tr><TH>Engagement</TH><TH>Renewal / end</TH><TH /></tr></THead>
                <tbody>
                  {renewals.map(({ e, accountName }) => (
                    <TR key={e.id}>
                      <TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${e.id}`}>{e.name}</Link><div className="text-[12px] text-muted">{accountName}</div></TD>
                      <TD><DateText value={e.renewalDate ?? e.endDate} overdue={(e.renewalDate ?? e.endDate ?? "9999") < today} /></TD>
                      <TD align="right">{can(actor, "crm.write") ? <Link className="text-[12.5px] text-accent hover:underline" href={`/crm/opportunities/new?account=${e.accountId}&kind=renewal&engagement=${e.id}`}>Start renewal deal</Link> : null}</TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="No renewals due in the next 90 days" />}
          </Card>
        ) : null}
        <Card>
          <CardHeader title="Outbound touches by channel" description="All logged outbound emails, messages, LinkedIn actions and calls in the period (later-touch influence, separate from first-touch attribution)." />
          {a.touches.length ? (
            <Table>
              <THead><tr><TH>Channel</TH><TH>Type</TH><TH align="right">Touches</TH></tr></THead>
              <tbody>
                {a.touches.map((t, i) => (
                  <TR key={i}><TD>{L.channelLabel(t.channel)}</TD><TD className="capitalize">{t.type}</TD><TD align="right">{Number(t.n)}</TD></TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No outbound touches logged in this period" />}
        </Card>
      </div>
    </>
  );
}

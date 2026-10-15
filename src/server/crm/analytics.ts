import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import {
  accounts,
  activities,
  campaigns,
  engagements,
  events,
  leadServiceFits,
  leadStatusHistory,
  leads,
  offers,
  opportunities,
  opportunityServices,
  opportunityStageHistory,
  pipelineStages,
  proposals,
  services,
  user,
} from "@/db/schema";
import { d, Decimal } from "@/lib/money";
import { getRate } from "../finance/ledger";
import { getSettings } from "../system/settings";

/**
 * CRM analytics with explicit denominators and reporting dates
 * (docs/DEFINITIONS.md):
 *  - Lead cohort: leads ADDED in the period (date_added). Merged leads excluded.
 *  - Qualification rate = cohort leads that ever reached Qualified (or were converted) ÷ cohort leads.
 *  - Contacted = cohort leads with ≥1 outbound email/message/LinkedIn/call; response rate = contacted
 *    leads with ≥1 inbound reply ÷ contacted leads.
 *  - Opportunity cohort: opportunities CREATED in the period. Proposal rate = cohort opps with a
 *    proposal sent ÷ cohort opps.
 *  - Win rate = won ÷ (won + lost) for opportunities CLOSED in the period (won_at / lost_at).
 *  - Sales cycle = average days created → won, for deals won in the period.
 *  - Won contract value (bookings) = closed value of deals won in the period, converted to the base
 *    currency at the rate on the win date.
 *  - Attribution: first-touch acquisition channel / campaign recorded on the lead or opportunity.
 *    Unknown stays "Unknown". Later touches are reported separately (touches by channel).
 *  - Acquisition cost only where campaign costs are recorded.
 */
export type CrmFilters = { from: string; to: string; owner?: string; service?: string; offer?: string; channel?: string; country?: string; campaign?: string };
export type GroupKey = "service" | "offer" | "owner" | "geography" | "campaign" | "channel";

type LeadRow = { id: string; channel: string | null; campaignId: string | null; country: string | null; ownerId: string | null; services: string[]; offers: string[]; qualified: boolean; contacted: boolean; responded: boolean };
type OppRow = { id: string; channel: string | null; campaignId: string | null; country: string | null; ownerId: string | null; services: string[]; offers: string[]; created: boolean; proposalSent: boolean; wonInPeriod: boolean; lostInPeriod: boolean; wonBase: Decimal | null; cycleDays: number | null; engagementIds: string[] };

export async function crmAnalytics(db: DB, f: CrmFilters, groupBy?: GroupKey) {
  const s = await getSettings(db);
  const base = s.baseCurrency;
  const inRange = (col: Parameters<typeof gte>[0]) => and(gte(col, f.from), lte(col, f.to));

  // ---- Leads cohort
  const leadRows = await db
    .select({ l: leads })
    .from(leads)
    .where(and(ne(leads.status, "merged"), inRange(leads.dateAdded), f.owner ? eq(leads.ownerId, f.owner) : undefined, f.channel ? (f.channel === "unknown" ? sql`${leads.acquisitionChannel} is null` : eq(leads.acquisitionChannel, f.channel)) : undefined, f.country ? eq(leads.country, f.country) : undefined, f.campaign ? eq(leads.campaignId, f.campaign) : undefined));
  const leadIds = leadRows.map((r) => r.l.id);
  const fits = leadIds.length ? await db.select().from(leadServiceFits).where(inArray(leadServiceFits.leadId, leadIds)) : [];
  const qualifiedSet = new Set(leadIds.length ? (await db.select({ id: leadStatusHistory.leadId }).from(leadStatusHistory).where(and(inArray(leadStatusHistory.leadId, leadIds), inArray(leadStatusHistory.toStatus, ["qualified", "converted"])))).map((r) => r.id) : []);
  const acts = leadIds.length ? await db.select({ leadId: activities.leadId, direction: activities.direction, type: activities.type, channel: activities.channel }).from(activities).where(and(inArray(activities.leadId, leadIds), inArray(activities.type, ["email", "message", "linkedin", "call"]))) : [];
  let L: LeadRow[] = leadRows.map(({ l }) => ({
    id: l.id,
    channel: l.acquisitionChannel,
    campaignId: l.campaignId,
    country: l.country,
    ownerId: l.ownerId,
    services: fits.filter((x) => x.leadId === l.id).map((x) => x.serviceId),
    offers: fits.filter((x) => x.leadId === l.id && x.offerId).map((x) => x.offerId!),
    qualified: qualifiedSet.has(l.id) || l.status === "converted",
    contacted: acts.some((a) => a.leadId === l.id && a.direction === "outbound"),
    responded: acts.some((a) => a.leadId === l.id && a.direction === "inbound"),
  }));
  if (f.service) L = L.filter((x) => x.services.includes(f.service!));
  if (f.offer) L = L.filter((x) => x.offers.includes(f.offer!));

  // ---- Opportunities: created in period OR closed in period
  const oppRows = await db
    .select({ o: opportunities, country: accounts.country })
    .from(opportunities)
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .where(and(sql`(${opportunities.createdAt}::date between ${f.from} and ${f.to} or ${opportunities.wonAt}::date between ${f.from} and ${f.to} or ${opportunities.lostAt}::date between ${f.from} and ${f.to})`, f.owner ? eq(opportunities.ownerId, f.owner) : undefined, f.channel ? (f.channel === "unknown" ? sql`${opportunities.acquisitionChannel} is null` : eq(opportunities.acquisitionChannel, f.channel)) : undefined, f.country ? eq(accounts.country, f.country) : undefined, f.campaign ? eq(opportunities.campaignId, f.campaign) : undefined));
  const oppIds = oppRows.map((r) => r.o.id);
  const osv = oppIds.length ? await db.select().from(opportunityServices).where(inArray(opportunityServices.opportunityId, oppIds)) : [];
  const sentProps = new Set(oppIds.length ? (await db.select({ id: proposals.opportunityId }).from(proposals).where(and(inArray(proposals.opportunityId, oppIds), sql`${proposals.sentAt} is not null`))).map((r) => r.id) : []);
  const engs = oppIds.length ? await db.select({ id: engagements.id, opp: engagements.opportunityId }).from(engagements).where(inArray(engagements.opportunityId, oppIds)) : [];
  const missingRates = new Set<string>();
  let O: OppRow[] = [];
  for (const { o, country } of oppRows) {
    const wonDate = o.wonAt?.toISOString().slice(0, 10) ?? null;
    const lostDate = o.lostAt?.toISOString().slice(0, 10) ?? null;
    const wonInPeriod = o.status === "won" && !!wonDate && wonDate >= f.from && wonDate <= f.to;
    let wonBase: Decimal | null = null;
    if (wonInPeriod) {
      try {
        wonBase = d(o.closedValue ?? o.value).times(d((await getRate(db, o.currency, base, wonDate!)).rate));
      } catch {
        missingRates.add(o.currency);
      }
    }
    const created = o.createdAt.toISOString().slice(0, 10);
    O.push({
      id: o.id,
      channel: o.acquisitionChannel,
      campaignId: o.campaignId,
      country,
      ownerId: o.ownerId,
      services: osv.filter((x) => x.opportunityId === o.id).map((x) => x.serviceId),
      offers: osv.filter((x) => x.opportunityId === o.id && x.offerId).map((x) => x.offerId!),
      created: created >= f.from && created <= f.to,
      proposalSent: sentProps.has(o.id),
      wonInPeriod,
      lostInPeriod: o.status === "lost" && !!lostDate && lostDate >= f.from && lostDate <= f.to,
      wonBase,
      cycleDays: wonInPeriod ? Math.round((o.wonAt!.getTime() - o.createdAt.getTime()) / 86400000) : null,
      engagementIds: engs.filter((e) => e.opp === o.id).map((e) => e.id),
    });
  }
  if (f.service) O = O.filter((x) => x.services.includes(f.service!));
  if (f.offer) O = O.filter((x) => x.offers.includes(f.offer!));

  // ---- Meetings
  const meetings = await db
    .select({ e: events })
    .from(events)
    .where(and(inArray(events.kind, ["discovery", "meeting", "call"]), sql`(${events.leadId} is not null or ${events.opportunityId} is not null)`, sql`${events.startsAt}::date between ${f.from} and ${f.to}`));
  const meetingsBooked = meetings.length;
  const meetingsCompleted = meetings.filter((m) => m.e.status === "completed").length;

  // ---- Invoicing & collections related to deals won in the period
  const wonEngIds = O.filter((o) => o.wonInPeriod).flatMap((o) => o.engagementIds);
  let invoiced = new Decimal(0), collected = new Decimal(0);
  if (wonEngIds.length) {
    const r = await db.execute<{ inv: string; col: string }>(sql`
      select coalesce(sum((i.subtotal - i.discount_total) * i.exchange_rate),0) as inv,
             coalesce(sum((select coalesce(sum(pa.amount),0) from payment_allocations pa where pa.invoice_id = i.id and pa.reversed_at is null) * i.exchange_rate),0) as col
      from invoices i where i.status = 'issued' and i.engagement_id in (${sql.join(wonEngIds.map((x) => sql`${x}`), sql`, `)})`);
    invoiced = d(r.rows[0].inv);
    collected = d(r.rows[0].col);
  }

  // ---- Stage conversion (opportunities created in the period)
  const cohortOppIds = O.filter((o) => o.created).map((o) => o.id);
  const stages = await db.select().from(pipelineStages).orderBy(pipelineStages.sortOrder);
  const hist = cohortOppIds.length ? await db.select().from(opportunityStageHistory).where(inArray(opportunityStageHistory.opportunityId, cohortOppIds)) : [];
  const reached = (stageSort: number) => new Set(hist.filter((h) => (stages.find((s) => s.id === h.toStageId)?.sortOrder ?? 0) >= stageSort && stages.find((s) => s.id === h.toStageId)?.kind !== "lost").map((h) => h.opportunityId));
  const openStages = stages.filter((s) => s.kind !== "lost");
  const conversion = openStages.slice(0, -1).map((s, i) => {
    const entered = reached(s.sortOrder).size;
    const next = reached(openStages[i + 1].sortOrder).size;
    return { from: s.name, to: openStages[i + 1].name, entered, advanced: next, rate: entered ? (next / entered) * 100 : null };
  });

  // ---- Touches by channel (later influences, separate from first-touch)
  const touches = await db
    .select({ channel: activities.channel, type: activities.type, n: sql<number>`count(*)` })
    .from(activities)
    .where(and(eq(activities.direction, "outbound"), inArray(activities.type, ["email", "message", "linkedin", "call"]), sql`${activities.occurredAt}::date between ${f.from} and ${f.to}`))
    .groupBy(activities.channel, activities.type);

  const summary = summarize(L, O);
  const won = O.filter((o) => o.wonInPeriod);
  const camp = await db.select().from(campaigns);

  let groups: { key: string; label: string; metrics: ReturnType<typeof summarize>; acquisitionCost: string | null; costCurrency: string | null }[] = [];
  if (groupBy) {
    const [svcs, ofs, users] = await Promise.all([db.select().from(services), db.select().from(offers), db.select({ id: user.id, name: user.name }).from(user)]);
    const keysOf = (x: LeadRow | OppRow): string[] => {
      switch (groupBy) {
        case "service": return x.services.length ? x.services : ["none"];
        case "offer": return x.offers.length ? x.offers : ["none"];
        case "owner": return [x.ownerId ?? "none"];
        case "geography": return [x.country ?? "none"];
        case "campaign": return [x.campaignId ?? "none"];
        case "channel": return [x.channel ?? "none"];
      }
    };
    const labelOf = (k: string) => {
      if (k === "none") return groupBy === "channel" || groupBy === "campaign" || groupBy === "geography" ? "Unknown / none" : "Unassigned";
      if (groupBy === "service") return svcs.find((x) => x.id === k)?.name ?? k;
      if (groupBy === "offer") return ofs.find((x) => x.id === k)?.name ?? k;
      if (groupBy === "owner") return users.find((x) => x.id === k)?.name ?? k;
      if (groupBy === "campaign") return camp.find((x) => x.id === k)?.name ?? k;
      return k;
    };
    const keys = new Set<string>([...L.flatMap(keysOf), ...O.flatMap(keysOf)]);
    groups = Array.from(keys).map((k) => {
      const m = summarize(L.filter((x) => keysOf(x).includes(k)), O.filter((x) => keysOf(x).includes(k)));
      let acquisitionCost: string | null = null;
      let costCurrency: string | null = null;
      if (groupBy === "campaign" && k !== "none") {
        const c = camp.find((x) => x.id === k);
        if (c?.cost && c.currency && m.wonCount > 0) {
          acquisitionCost = d(c.cost).div(m.wonCount).toFixed(2);
          costCurrency = c.currency;
        }
      }
      return { key: k, label: labelOf(k), metrics: m, acquisitionCost, costCurrency };
    }).sort((a, b) => b.metrics.leads + b.metrics.opps - (a.metrics.leads + a.metrics.opps));
  }

  return {
    base,
    filters: f,
    summary,
    meetingsBooked,
    meetingsCompleted,
    invoiced: invoiced.toFixed(2),
    collected: collected.toFixed(2),
    conversion,
    touches,
    groups,
    missingRates: Array.from(missingRates),
    wonIds: won.map((w) => w.id),
  };
}

function summarize(L: LeadRow[], O: OppRow[]) {
  const qualified = L.filter((l) => l.qualified).length;
  const contacted = L.filter((l) => l.contacted).length;
  const responded = L.filter((l) => l.contacted && l.responded).length;
  const cohort = O.filter((o) => o.created);
  const withProposal = cohort.filter((o) => o.proposalSent).length;
  const won = O.filter((o) => o.wonInPeriod);
  const lost = O.filter((o) => o.lostInPeriod).length;
  const wonValue = won.reduce((a, o) => a.plus(o.wonBase ?? 0), new Decimal(0));
  const cycles = won.map((o) => o.cycleDays!).filter((x) => x !== null);
  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) : null);
  return {
    leads: L.length,
    qualified,
    qualificationRate: pct(qualified, L.length),
    contacted,
    responded,
    responseRate: pct(responded, contacted),
    opps: cohort.length,
    proposalsSent: withProposal,
    proposalRate: pct(withProposal, cohort.length),
    wonCount: won.length,
    lostCount: lost,
    winRate: pct(won.length, won.length + lost),
    wonValue: wonValue.toFixed(2),
    avgDealValue: won.length ? wonValue.div(won.length).toFixed(2) : null,
    avgCycleDays: cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null,
  };
}

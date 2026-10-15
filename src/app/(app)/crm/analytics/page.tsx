import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { crmAnalytics, type GroupKey } from "@/server/crm/analytics";
import { crmLookups } from "@/server/crm/lookups";
import { agencyToday, getSettings } from "@/server/system/settings";
import { Card, CardHeader, EmptyState, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { drill, parseCrmFilters, PERIOD_OPTIONS } from "@/components/crm/analytics-filters";
import { qs } from "@/lib/utils";

export const metadata = { title: "CRM analytics" };

const GROUPS: { key: GroupKey; label: string }[] = [
  { key: "service", label: "Service" },
  { key: "offer", label: "Offer" },
  { key: "owner", label: "Owner" },
  { key: "channel", label: "Acquisition channel" },
  { key: "campaign", label: "Campaign" },
  { key: "geography", label: "Geography" },
];

const pct = (v: string | null) => (v === null ? "—" : `${v}%`);

export default async function CrmAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const settings = await getSettings(db);
  const today = await agencyToday(db);
  const { f, label, ownerLocked } = parseCrmFilters(sp, actor, today, settings.fiscalYearStartMonth);
  const by = (GROUPS.find((g) => g.key === sp.by)?.key ?? "service") as GroupKey;
  const L = await crmLookups();
  const a = await crmAnalytics(db, f, by);
  const base = a.base;
  const s = a.summary;

  // Drill-down: a group key becomes the matching list filter where the list supports it.
  const groupFilter = (key: string): Record<string, string | undefined> => {
    if (key === "none") return by === "channel" ? { channel: "unknown" } : by === "owner" ? { owner: "none" } : {};
    if (by === "service") return { service: key };
    if (by === "owner") return { owner: key };
    if (by === "channel") return { channel: key };
    if (by === "campaign") return { campaign: key };
    if (by === "geography") return { country: key };
    return {};
  };

  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Analytics" }]}
        title="CRM analytics"
        description={`Lead and opportunity performance for ${label}. Each rate states its denominator; attribution is first-touch and unknown sources stay "Unknown".`}
        actions={<a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href="#definitions">Definitions</a>}
      />
      <FilterBar
        keep={["by"]}
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
      {a.missingRates.length ? <Notice tone="warning" className="mb-4" title="Missing exchange rates">Won deals in {a.missingRates.join(", ")} are excluded from value totals until a rate is recorded.</Notice> : null}

      <Card className="mb-4">
        <CardHeader title="Totals for the selection" description={`${f.from} → ${f.to}`} />
        <Table>
          <THead><tr><TH>Leads</TH><TH align="right">Qualified</TH><TH align="right">Response</TH><TH align="right">Opps</TH><TH align="right">Proposal rate</TH><TH align="right">Won / lost</TH><TH align="right">Win rate</TH><TH align="right">Bookings</TH><TH align="right">Avg deal</TH><TH align="right">Cycle</TH></tr></THead>
          <tbody>
            <TR>
              <TD>{s.leads}</TD><TD align="right">{s.qualified} ({pct(s.qualificationRate)})</TD><TD align="right">{s.responded}/{s.contacted} ({pct(s.responseRate)})</TD><TD align="right">{s.opps}</TD><TD align="right">{pct(s.proposalRate)}</TD><TD align="right">{s.wonCount} / {s.lostCount}</TD><TD align="right">{pct(s.winRate)}</TD><TD align="right"><Money value={s.wonValue} currency={base} /></TD><TD align="right">{s.avgDealValue ? <Money value={s.avgDealValue} currency={base} /> : "—"}</TD><TD align="right">{s.avgCycleDays === null ? "—" : `${s.avgCycleDays}d`}</TD>
            </TR>
          </tbody>
        </Table>
      </Card>

      <Tabs current={by} tabs={GROUPS.map((g) => ({ key: g.key, label: `By ${g.label.toLowerCase()}`, href: `/crm/analytics${qs({ ...sp, by: g.key })}` }))} />
      <Card className="mt-3">
        {a.groups.length ? (
          <Table>
            <THead>
              <tr>
                <TH>{GROUPS.find((g) => g.key === by)!.label}</TH>
                <TH align="right">Leads</TH>
                <TH align="right">Qualification</TH>
                <TH align="right">Response</TH>
                <TH align="right">Opps created</TH>
                <TH align="right">Proposal rate</TH>
                <TH align="right">Won</TH>
                <TH align="right">Win rate</TH>
                <TH align="right">Bookings ({base})</TH>
                <TH align="right">Avg cycle</TH>
                {by === "campaign" ? <TH align="right">Cost per win</TH> : null}
              </tr>
            </THead>
            <tbody>
              {a.groups.map((g) => {
                const gf = groupFilter(g.key);
                return (
                  <TR key={g.key}>
                    <TD className="font-medium">{by === "channel" && g.key !== "none" ? L.channelLabel(g.key) : g.label}</TD>
                    <TD align="right"><a className="hover:underline" href={`/crm/leads${drill(f, { include: "all", from: f.from, to: f.to, ...gf })}`}>{g.metrics.leads}</a></TD>
                    <TD align="right">{pct(g.metrics.qualificationRate)}</TD>
                    <TD align="right">{pct(g.metrics.responseRate)}</TD>
                    <TD align="right"><a className="hover:underline" href={`/crm/opportunities${drill(f, { status: "all", dateBasis: "created", from: f.from, to: f.to, ...gf })}`}>{g.metrics.opps}</a></TD>
                    <TD align="right">{pct(g.metrics.proposalRate)}</TD>
                    <TD align="right"><a className="hover:underline" href={`/crm/opportunities${drill(f, { status: "won", dateBasis: "won", from: f.from, to: f.to, ...gf })}`}>{g.metrics.wonCount}</a></TD>
                    <TD align="right">{pct(g.metrics.winRate)}</TD>
                    <TD align="right"><Money value={g.metrics.wonValue} currency={base} /></TD>
                    <TD align="right">{g.metrics.avgCycleDays === null ? "—" : `${g.metrics.avgCycleDays}d`}</TD>
                    {by === "campaign" ? <TD align="right">{g.acquisitionCost ? <Money value={g.acquisitionCost} currency={g.costCurrency} /> : <span className="text-faint" title="Requires a recorded campaign cost and at least one win">—</span>}</TD> : null}
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No leads or opportunities in this selection" />}
        {by === "service" || by === "offer" ? <p className="border-t border-line px-4 py-2 text-[12px] text-muted">A lead or opportunity fitting several services is counted under each of them, so rows can add up to more than the total.</p> : null}
      </Card>

      <Card id="definitions" className="mt-4">
        <CardHeader title="Definitions" />
        <ul className="list-disc space-y-1 px-8 py-3 text-[13px] text-ink-2">
          <li><b>Lead cohort</b>: leads whose date added falls in the period. Merged duplicates are excluded.</li>
          <li><b>Qualification rate</b>: cohort leads that reached Qualified (or were converted) ÷ cohort leads.</li>
          <li><b>Response rate</b>: cohort leads with a logged inbound reply ÷ cohort leads with a logged outbound touch. Replies are never inferred.</li>
          <li><b>Opportunity cohort</b>: opportunities created in the period. Proposal rate = those with a proposal marked sent ÷ cohort.</li>
          <li><b>Win rate</b>: won ÷ (won + lost) for opportunities closed in the period.</li>
          <li><b>Bookings</b>: closed value of deals won in the period, converted at the rate on the win date. Bookings are not invoiced or recognised revenue.</li>
          <li><b>Attribution</b>: first-touch channel and campaign recorded on the lead or opportunity. Later touches are shown on the CRM overview as touches by channel.</li>
          <li><b>Cost per win</b>: recorded campaign cost ÷ deals won in the period attributed to that campaign. Shown only where a cost is recorded.</li>
        </ul>
      </Card>
    </>
  );
}

import Link from "next/link";
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { q } from "@/db/sql";
import { accounts, opportunities, opportunityServices, pipelineStages, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { opportunityVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { getDefaultPipeline, getSettings, agencyToday } from "@/server/system/settings";
import { getRate } from "@/server/finance/ledger";
import { qs } from "@/lib/utils";
import { d, Decimal } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { Badge, Card, CardHeader, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { SavedViews } from "@/components/records/saved-views";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Select } from "@/components/forms/fields";
import { opportunityStageAction } from "@/server/actions/crm";

export const metadata = { title: "Opportunities" };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const view = ["board", "forecast"].includes(sp.view ?? "") ? sp.view! : "table";
  const L = await crmLookups();
  const { stages } = await getDefaultPipeline(db);
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const status = sp.status ?? (view === "table" ? "open" : "open");
  const conds: (SQL | undefined)[] = [opportunityVisibility(actor), status === "all" ? undefined : eq(opportunities.status, status as "open")];
  if (sp.q) conds.push(or(ilike(opportunities.name, `%${sp.q}%`), ilike(accounts.name, `%${sp.q}%`), ilike(opportunities.number, `%${sp.q}%`)));
  if (sp.owner) conds.push(sp.owner === "none" ? sql`${opportunities.ownerId} is null` : eq(opportunities.ownerId, sp.owner));
  if (sp.stage) conds.push(eq(opportunities.stageId, sp.stage));
  if (sp.service) conds.push(sql`exists (select 1 from ${opportunityServices} os where os.opportunity_id = ${q(opportunities.id)} and os.service_id = ${sp.service})`);
  if (sp.kind) conds.push(eq(opportunities.kind, sp.kind as "expansion"));
  if (sp.channel) conds.push(sp.channel === "unknown" ? sql`${opportunities.acquisitionChannel} is null` : eq(opportunities.acquisitionChannel, sp.channel));
  if (sp.campaign) conds.push(eq(opportunities.campaignId, sp.campaign));
  // Date windows used by analytics drill-downs: created / won / lost in an inclusive range.
  if (sp.from && sp.to) {
    const col = sp.dateBasis === "won" ? opportunities.wonAt : sp.dateBasis === "lost" ? opportunities.lostAt : sp.dateBasis === "closed" ? sql`coalesce(${opportunities.wonAt}, ${opportunities.lostAt})` : opportunities.createdAt;
    conds.push(sql`${col}::date between ${sp.from} and ${sp.to}`);
  }
  if (sp.noNext === "1") conds.push(sql`(${opportunities.nextAction} is null or ${opportunities.nextActionDate} is null)`);
  const rows = await db
    .select({
      o: opportunities,
      accountName: accounts.name,
      stage: pipelineStages,
      ownerName: user.name,
      services: sql<string[]>`coalesce((select array_agg(s.short_name) from ${opportunityServices} os join ${services} s on s.id = os.service_id where os.opportunity_id = ${q(opportunities.id)}), '{}')`,
    })
    .from(opportunities)
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(user, eq(user.id, opportunities.ownerId))
    .where(and(...conds))
    .orderBy(asc(pipelineStages.sortOrder), sp.sort === "value" ? desc(opportunities.value) : asc(opportunities.expectedCloseDate))
    .limit(500);
  const base = { ...sp };
  // Totals per currency, and converted to base where a rate exists (labelled).
  const perCurrency = new Map<string, { value: Decimal; weighted: Decimal }>();
  for (const r of rows) {
    const g = perCurrency.get(r.o.currency) ?? { value: new Decimal(0), weighted: new Decimal(0) };
    g.value = g.value.plus(d(r.o.value));
    g.weighted = g.weighted.plus(d(r.o.value).times(r.o.probabilityOverride ?? r.stage.probability).div(100));
    perCurrency.set(r.o.currency, g);
  }
  let baseTotal = new Decimal(0), baseWeighted = new Decimal(0);
  const missing: string[] = [];
  for (const [cur, g] of perCurrency) {
    try {
      const { rate } = await getRate(db, cur, s.baseCurrency, today);
      baseTotal = baseTotal.plus(g.value.times(d(rate)));
      baseWeighted = baseWeighted.plus(g.weighted.times(d(rate)));
    } catch {
      missing.push(cur);
    }
  }
  const canWrite = can(actor, "crm.write");
  const openStages = stages.filter((st) => st.kind === "open");

  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Opportunities" }]}
        title="Opportunity pipeline"
        description="Stage history and time in stage are recorded on every move. Won means booked — not revenue or cash."
        actions={<>{can(actor, "crm.export") ? <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href="/api/export/opportunities">Export</a> : null}{canWrite ? <LinkButton href="/crm/opportunities/new" variant="primary">New opportunity</LinkButton> : null}</>}
      />
      <Tabs tabs={[{ key: "table", label: "Table", href: `/crm/opportunities${qs({ ...base, view: null })}` }, { key: "board", label: "Board", href: `/crm/opportunities${qs({ ...base, view: "board" })}` }, { key: "forecast", label: "Forecast", href: `/crm/opportunities${qs({ ...base, view: "forecast" })}` }]} current={view} />
      <FilterBar
        keep={["view"]}
        fields={[
          { type: "search", name: "q", label: "Search", placeholder: "Deal, account or number" },
          { type: "select", name: "status", label: "Status", allLabel: "Open", options: [{ value: "won", label: "Won" }, { value: "lost", label: "Lost" }, { value: "all", label: "All" }] },
          { type: "select", name: "stage", label: "Stage", options: stages.map((x) => ({ value: x.id, label: x.name })) },
          { type: "select", name: "owner", label: "Owner", options: L.users },
          { type: "select", name: "service", label: "Service", options: L.services },
          { type: "select", name: "kind", label: "Type", options: [{ value: "new_business", label: "New business" }, { value: "expansion", label: "Expansion" }, { value: "renewal", label: "Renewal" }] },
          { type: "select", name: "channel", label: "Channel", options: L.channels },
          { type: "select", name: "noNext", label: "Next action", options: [{ value: "1", label: "Missing" }] },
        ]}
      />
      <SavedViews actor={actor} module="opportunities" basePath="/crm/opportunities" query={qs(base).slice(1)} />
      <div className="mb-3 flex flex-wrap gap-4 text-[13px]">
        <span>
          <span className="text-muted">Unweighted:</span> <Money value={baseTotal.toFixed(2)} currency={s.baseCurrency} />
        </span>
        <span>
          <span className="text-muted">Weighted:</span> <Money value={baseWeighted.toFixed(2)} currency={s.baseCurrency} />
        </span>
        <span className="text-muted">({rows.length} deals; converted to {s.baseCurrency} at latest rate ≤ {formatDate(today)}{Array.from(perCurrency.keys()).length > 1 ? `; ${Array.from(perCurrency.entries()).map(([c, g]) => `${c} ${g.value.toFixed(0)}`).join(", ")} native` : ""})</span>
      </div>
      {missing.length ? <Notice tone="warning" className="mb-3">Totals exclude {missing.join(", ")} deals — no exchange rate to {s.baseCurrency}.</Notice> : null}

      {view === "table" ? (
        <Card>
          {rows.length ? (
            <Table>
              <THead>
                <tr><TH>Opportunity</TH><TH>Account</TH><TH>Services</TH><TH>Stage</TH><TH align="right">Prob.</TH><TH align="right">Value</TH><TH>Close</TH><TH>Owner</TH><TH>Next action</TH><TH>In stage</TH></tr>
              </THead>
              <tbody>
                {rows.map(({ o, accountName, stage, ownerName, services: sv }) => {
                  const days = Math.floor((Date.now() - o.stageEnteredAt.getTime()) / 86400000);
                  return (
                    <TR key={o.id}>
                      <TD className="min-w-[200px]">
                        <Link href={`/crm/opportunities/${o.id}`} className="font-medium hover:underline">{o.name}</Link>
                        <p className="text-[11.5px] text-muted">{o.number}{o.kind !== "new_business" ? ` · ${o.kind}` : ""}</p>
                      </TD>
                      <TD><Link href={`/crm/accounts/${o.accountId}`} className="hover:underline">{accountName}</Link></TD>
                      <TD><div className="flex flex-wrap gap-1">{sv.map((x) => <Badge key={x}>{x}</Badge>)}</div></TD>
                      <TD><StatusBadge status={o.status === "open" ? "open" : o.status} label={stage.name} /></TD>
                      <TD align="right">{o.probabilityOverride ?? stage.probability}%</TD>
                      <TD align="right"><Money value={o.value} currency={o.currency} /></TD>
                      <TD><DateText value={o.expectedCloseDate} overdue={o.status === "open" && !!o.expectedCloseDate && o.expectedCloseDate < today} /></TD>
                      <TD>{ownerName}</TD>
                      <TD className="min-w-[160px] text-[12.5px]">{o.nextAction ? <>{o.nextAction}<br /><DateText value={o.nextActionDate} overdue={!!o.nextActionDate && o.nextActionDate < today} /></> : o.status === "open" ? <Badge tone="warning">missing</Badge> : null}</TD>
                      <TD className={days > (stage.staleAfterDays ?? s.staleOpportunityDays) && o.status === "open" ? "text-warning" : ""}>{days}d</TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          ) : <EmptyState title="No opportunities match" />}
        </Card>
      ) : null}

      {view === "board" ? (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {openStages.map((st) => {
            const col = rows.filter((r) => r.stage.id === st.id);
            const total = col.reduce((a, r) => (r.o.currency === s.baseCurrency ? a.plus(d(r.o.value)) : a), new Decimal(0));
            return (
              <section key={st.id} aria-label={st.name} className="w-64 shrink-0 rounded-lg border border-line bg-sunken/60 p-2">
                <h2 className="mb-1 flex items-center justify-between px-1 text-[12.5px] font-semibold text-ink-2">{st.name}<Badge>{col.length}</Badge></h2>
                <p className="mb-2 px-1 text-[11.5px] text-muted">{st.probability}% · <Money value={total.toFixed(2)} currency={s.baseCurrency} compact /> ({s.baseCurrency} deals)</p>
                <ul className="space-y-2">
                  {col.map(({ o, accountName }) => (
                    <li key={o.id} className="rounded-md border border-line bg-surface p-2.5">
                      <Link href={`/crm/opportunities/${o.id}`} className="text-[13px] font-medium hover:underline">{o.name}</Link>
                      <p className="text-[11.5px] text-muted">{accountName}</p>
                      <p className="mt-1 text-[12.5px]"><Money value={o.value} currency={o.currency} /></p>
                      {o.nextAction ? <p className="text-[11.5px] text-ink-2">Next: {o.nextAction}</p> : <Badge tone="warning">no next action</Badge>}
                      {canWrite ? (
                        <ActionForm action={opportunityStageAction} hideSuccess className="mt-1.5 flex gap-1">
                          <input type="hidden" name="id" value={o.id} />
                          <Select name="stageId" defaultValue={o.stageId} aria-label="Move to stage" className="h-7 py-0 text-[12px]" options={openStages.map((x) => ({ value: x.id, label: x.name }))} />
                          <SubmitButton size="sm" variant="ghost">Move</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : null}

      {view === "forecast" ? <Forecast rows={rows} base={s.baseCurrency} today={today} /> : null}
    </>
  );
}

async function Forecast({ rows, base, today }: { rows: { o: typeof opportunities.$inferSelect; stage: typeof pipelineStages.$inferSelect; accountName: string }[]; base: string; today: string }) {
  const months = new Map<string, { value: Decimal; weighted: Decimal; deals: number }>();
  for (const r of rows) {
    if (r.o.status !== "open") continue;
    const m = (r.o.expectedCloseDate ?? "unscheduled").slice(0, 7);
    let rate = "1";
    try {
      rate = (await getRate(db, r.o.currency, base, today)).rate;
    } catch {
      continue;
    }
    const v = d(r.o.value).times(d(rate));
    const g = months.get(m) ?? { value: new Decimal(0), weighted: new Decimal(0), deals: 0 };
    g.value = g.value.plus(v);
    g.weighted = g.weighted.plus(v.times(r.o.probabilityOverride ?? r.stage.probability).div(100));
    g.deals++;
    months.set(m, g);
  }
  const list = Array.from(months.entries()).sort(([a], [b]) => a.localeCompare(b));
  return (
    <Card>
      <CardHeader title="Forecast by expected close month" description={`Weighted = value × probability (stage default or override). ${base}, converted at the latest rate. This is a sales forecast — not booked, invoiced or recognised revenue.`} />
      <Table>
        <THead><tr><TH>Month</TH><TH align="right">Deals</TH><TH align="right">Unweighted</TH><TH align="right">Weighted</TH></tr></THead>
        <tbody>
          {list.map(([m, g]) => (
            <TR key={m}>
              <TD className={m !== "unscheduled" && m < today.slice(0, 7) ? "text-danger" : ""}>{m === "unscheduled" ? "No close date" : formatDate(`${m}-01`, "MMMM yyyy")}{m !== "unscheduled" && m < today.slice(0, 7) ? " (past — update close dates)" : ""}</TD>
              <TD align="right">{g.deals}</TD>
              <TD align="right"><Money value={g.value.toFixed(2)} currency={base} /></TD>
              <TD align="right"><Money value={g.weighted.toFixed(2)} currency={base} /></TD>
            </TR>
          ))}
          {!list.length ? <TR><TD colSpan={4} className="text-muted">No open opportunities.</TD></TR> : null}
        </tbody>
      </Table>
    </Card>
  );
}

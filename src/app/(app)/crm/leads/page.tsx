import Link from "next/link";
import { and, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { q } from "@/db/sql";
import { leadContacts, leadServiceFits, leads, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { leadVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { agencyToday } from "@/server/system/settings";
import { qs } from "@/lib/utils";
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Pagination, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { SavedViews } from "@/components/records/saved-views";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Input, Select } from "@/components/forms/fields";
import { bulkLeadsAction } from "@/server/actions/crm";

export const metadata = { title: "Leads" };

const STATUSES = ["new", "researching", "qualified", "nurture", "disqualified"] as const;
type SP = Record<string, string | undefined>;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const view = sp.view === "board" ? "board" : "table";
  const L = await crmLookups();
  const today = await agencyToday(db);
  const conds: (SQL | undefined)[] = [leadVisibility(actor), sp.status ? eq(leads.status, sp.status as "new") : sp.include === "all" ? undefined : inArray(leads.status, ["new", "researching", "qualified", "nurture"])];
  if (sp.q) conds.push(or(ilike(leads.companyName, `%${sp.q}%`), ilike(sql`coalesce(${leads.domain}, '')`, `%${sp.q}%`), sql`exists (select 1 from lead_contacts lc where lc.lead_id = ${q(leads.id)} and (lc.full_name ilike ${`%${sp.q}%`} or lc.email ilike ${`%${sp.q}%`}))`));
  if (sp.owner) conds.push(sp.owner === "none" ? sql`${leads.ownerId} is null` : eq(leads.ownerId, sp.owner));
  if (sp.channel) conds.push(sp.channel === "unknown" ? sql`${leads.acquisitionChannel} is null` : eq(leads.acquisitionChannel, sp.channel));
  if (sp.service) conds.push(sql`exists (select 1 from ${leadServiceFits} f where f.lead_id = ${q(leads.id)} and f.service_id = ${sp.service})`);
  if (sp.country) conds.push(ilike(sql`coalesce(${leads.country}, '')`, `%${sp.country}%`));
  if (sp.tag) conds.push(sql`${sp.tag} = any(${leads.tags})`);
  if (sp.campaign) conds.push(eq(leads.campaignId, sp.campaign));
  if (sp.due === "overdue") conds.push(sql`coalesce(${leads.nextActionDate}, ${leads.followUpDate}) < ${today}`);
  const where = and(...conds, ne(leads.status, "merged"));
  const page = Math.max(1, Number(sp.page ?? 1));
  const pageSize = view === "board" ? 500 : 50;
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(leads).where(where);
  const rows = await db
    .select({ l: leads, ownerName: user.name, contactName: sql<string | null>`(select lc.full_name from ${leadContacts} lc where lc.lead_id = ${q(leads.id)} order by lc.is_primary desc limit 1)`, services: sql<string[]>`coalesce((select array_agg(s.short_name order by s.sort_order) from ${leadServiceFits} f join ${services} s on s.id = f.service_id where f.lead_id = ${q(leads.id)}), '{}')` })
    .from(leads)
    .leftJoin(user, eq(user.id, leads.ownerId))
    .where(where)
    .orderBy(sp.sort === "value" ? desc(leads.estimatedValue) : sp.sort === "next" ? sql`coalesce(${leads.nextActionDate}, ${leads.followUpDate}) asc nulls last` : desc(leads.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const base = { ...sp, page: undefined };
  const query = qs(base).slice(1);
  const canWrite = can(actor, "crm.write");

  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Leads" }]}
        title="Lead workspace"
        description="Prospect research and qualification. Qualification status is separate from opportunity stage and account lifecycle."
        actions={
          <>
            {can(actor, "crm.import") ? <LinkButton href="/crm/leads/import">Import CSV</LinkButton> : null}
            {can(actor, "crm.export") ? <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href={`/api/export/leads${qs({ ...base })}`}>Export</a> : null}
            {canWrite ? <LinkButton href="/crm/leads/new" variant="primary">New lead</LinkButton> : null}
          </>
        }
      />
      <Tabs tabs={[{ key: "table", label: "Table", href: `/crm/leads${qs({ ...base, view: null })}` }, { key: "board", label: "Board", href: `/crm/leads${qs({ ...base, view: "board" })}` }]} current={view} />
      <FilterBar
        keep={["view"]}
        fields={[
          { type: "search", name: "q", label: "Search", placeholder: "Company, domain, contact…" },
          { type: "select", name: "status", label: "Qualification", allLabel: "Open (not disqualified)", options: [...STATUSES, "converted"].map((s) => ({ value: s as string, label: s as string })) },
          { type: "select", name: "owner", label: "Owner", options: [{ value: "none", label: "Unassigned" }, ...L.users] },
          { type: "select", name: "service", label: "Service fit", options: L.services },
          { type: "select", name: "channel", label: "Channel", options: [{ value: "unknown", label: "Unknown" }, ...L.channels] },
          { type: "select", name: "campaign", label: "Campaign", options: L.campaigns },
          { type: "select", name: "due", label: "Follow-up", options: [{ value: "overdue", label: "Overdue" }] },
          { type: "select", name: "sort", label: "Sort", allLabel: "Newest", options: [{ value: "next", label: "Next action date" }, { value: "value", label: "Estimated value" }] },
        ]}
      />
      <SavedViews actor={actor} module="leads" basePath="/crm/leads" query={query} />
      {view === "board" ? (
        <div className="grid gap-3 overflow-x-auto md:grid-cols-5">
          {STATUSES.map((s) => {
            const col = rows.filter((r) => r.l.status === s);
            return (
              <section key={s} aria-label={s} className="min-w-[220px] rounded-lg border border-line bg-sunken/60 p-2">
                <h2 className="mb-2 flex items-center justify-between px-1 text-[12.5px] font-semibold capitalize text-ink-2">
                  {s} <Badge>{col.length}</Badge>
                </h2>
                <ul className="space-y-2">
                  {col.map(({ l, ownerName, services: sv }) => (
                    <li key={l.id} className="rounded-md border border-line bg-surface p-2.5">
                      <Link href={`/crm/leads/${l.id}`} className="text-[13px] font-medium text-ink hover:underline">
                        {l.companyName}
                      </Link>
                      <p className="text-[11.5px] text-muted">{[L.channelLabel(l.acquisitionChannel), ownerName].filter(Boolean).join(" · ")}</p>
                      <div className="mt-1 flex flex-wrap gap-1">{sv.map((x) => <Badge key={x}>{x}</Badge>)}</div>
                      {l.nextAction ? (
                        <p className="mt-1 text-[11.5px] text-ink-2">
                          Next: {l.nextAction} · <DateText value={l.nextActionDate} overdue={!!l.nextActionDate && l.nextActionDate < today} />
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      ) : (
        <Card>
          {rows.length ? (
            <ActionForm action={bulkLeadsAction} resetOnSuccess>
              {canWrite ? (
                <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[#fbfbf9] px-3 py-2 text-[12.5px]">
                  <span className="text-muted">Bulk action on selected:</span>
                  <Select name="op" aria-label="Bulk action" className="h-8 w-40 py-0" options={[{ value: "assign", label: "Assign owner" }, { value: "tag", label: "Add tag" }, { value: "untag", label: "Remove tag" }, { value: "task", label: "Create task" }]} />
                  <Select name="ownerId" aria-label="Owner" className="h-8 w-40 py-0" placeholder="Owner…" options={L.users} />
                  <Input name="tag" placeholder="Tag" aria-label="Tag" className="h-8 w-28 py-0" />
                  <Input name="title" placeholder="Task title" aria-label="Task title" className="h-8 w-44 py-0" />
                  <Input name="dueDate" type="date" aria-label="Task due date" className="h-8 w-36 py-0" />
                  <SubmitButton size="sm" variant="secondary">Apply</SubmitButton>
                </div>
              ) : null}
              <Table>
                <THead>
                  <tr>
                    {canWrite ? <TH><span className="sr-only">Select</span></TH> : null}
                    <TH>Company</TH>
                    <TH>Contact</TH>
                    <TH>Fit</TH>
                    <TH>Status</TH>
                    <TH>Source</TH>
                    <TH>Owner</TH>
                    <TH>Next action</TH>
                    <TH align="right">Est. value</TH>
                    <TH>Last interaction</TH>
                  </tr>
                </THead>
                <tbody>
                  {rows.map(({ l, ownerName, contactName, services: sv }) => {
                    const due = l.nextActionDate ?? l.followUpDate;
                    return (
                      <TR key={l.id}>
                        {canWrite ? (
                          <TD>
                            <input type="checkbox" name="ids[]" value={l.id} aria-label={`Select ${l.companyName}`} className="h-4 w-4 accent-[var(--color-accent)]" />
                          </TD>
                        ) : null}
                        <TD className="min-w-[180px]">
                          <Link href={`/crm/leads/${l.id}`} className="font-medium text-ink hover:underline">
                            {l.companyName}
                          </Link>
                          <p className="text-[11.5px] text-muted">{[l.domain, l.industry, l.country].filter(Boolean).join(" · ")}</p>
                          {l.tags.length ? <div className="mt-0.5 flex flex-wrap gap-1">{l.tags.map((t) => <Badge key={t}>#{t}</Badge>)}</div> : null}
                        </TD>
                        <TD>{contactName ?? <span className="text-faint">—</span>}</TD>
                        <TD><div className="flex flex-wrap gap-1">{sv.map((x) => <Badge key={x}>{x}</Badge>)}</div></TD>
                        <TD><StatusBadge status={l.status} /></TD>
                        <TD className="text-[12.5px]">
                          {L.channelLabel(l.acquisitionChannel)}
                          <p className="text-[11.5px] text-muted"><DateText value={l.dateAdded} /></p>
                        </TD>
                        <TD>{ownerName ?? <span className="text-faint">Unassigned</span>}</TD>
                        <TD className="min-w-[160px] text-[12.5px]">
                          {l.nextAction ?? <span className="text-faint">None set</span>}
                          {due ? <p><DateText value={due} overdue={due < today} /></p> : null}
                        </TD>
                        <TD align="right"><Money value={l.estimatedValue} currency={l.currency} /></TD>
                        <TD className="text-[12px]">{l.lastInteractionAt ? <DateText value={l.lastInteractionAt.toISOString().slice(0, 10)} /> : <span className="text-faint">—</span>}</TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
            </ActionForm>
          ) : (
            <EmptyState title="No leads match" description="Adjust the filters, add a lead, or import a CSV." action={canWrite ? <LinkButton href="/crm/leads/new" variant="primary">New lead</LinkButton> : undefined} />
          )}
          <Pagination page={page} pageSize={pageSize} total={Number(total)} hrefFor={(p) => `/crm/leads${qs({ ...base, page: p })}`} />
        </Card>
      )}
    </>
  );
}

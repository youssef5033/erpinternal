import Link from "next/link";
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { q } from "@/db/sql";
import { accounts, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { qs } from "@/lib/utils";
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { SavedViews } from "@/components/records/saved-views";

export const metadata = { title: "Accounts" };

export default async function AccountsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const L = await crmLookups();
  const conds: (SQL | undefined)[] = [accountVisibility(actor), sp.archived ? undefined : isNull(accounts.archivedAt)];
  if (sp.q) conds.push(or(ilike(accounts.name, `%${sp.q}%`), ilike(sql`coalesce(${accounts.domain},'')`, `%${sp.q}%`)));
  if (sp.lifecycle) conds.push(eq(accounts.lifecycleStatus, sp.lifecycle as "active"));
  if (sp.owner) conds.push(eq(accounts.ownerId, sp.owner));
  if (sp.industry) conds.push(eq(accounts.industry, sp.industry));
  if (sp.service) conds.push(sql`exists (select 1 from engagements e join services s on s.id = e.service_id where e.account_id = ${q(accounts.id)} and s.id = ${sp.service})`);
  const where = and(...conds);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(accounts).where(where);
  const rows = await db
    .select({
      a: accounts,
      ownerName: user.name,
      contacts: sql<number>`(select count(*) from contacts c where c.primary_account_id = ${q(accounts.id)} and c.archived_at is null)`,
      openOpps: sql<number>`(select count(*) from opportunities o where o.account_id = ${q(accounts.id)} and o.status = 'open')`,
      activeEngs: sql<number>`(select count(*) from engagements e where e.account_id = ${q(accounts.id)} and e.status in ('onboarding','active','on_hold'))`,
      services: sql<string[]>`coalesce((select array_agg(distinct s.short_name) from engagements e join services s on s.id = e.service_id where e.account_id = ${q(accounts.id)}), '{}')`,
    })
    .from(accounts)
    .leftJoin(user, eq(user.id, accounts.ownerId))
    .where(where)
    .orderBy(asc(accounts.name))
    .limit(50)
    .offset((page - 1) * 50);
  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Accounts" }]}
        title="Accounts"
        description="Shared directory of prospects, clients, former clients and partners."
        actions={<>{can(actor, "crm.export") ? <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href="/api/export/accounts">Export</a> : null}{can(actor, "crm.write") ? <LinkButton href="/crm/accounts/new" variant="primary">New account</LinkButton> : null}</>}
      />
      <FilterBar
        fields={[
          { type: "search", name: "q", label: "Search", placeholder: "Name or domain" },
          { type: "select", name: "lifecycle", label: "Lifecycle", options: ["prospect", "onboarding", "active", "former", "partner"].map((v) => ({ value: v, label: v })) },
          { type: "select", name: "owner", label: "Owner", options: L.users },
          { type: "select", name: "industry", label: "Industry", options: L.industries.map((i) => ({ value: i, label: i })) },
          { type: "select", name: "service", label: "Buys service", options: L.services },
          { type: "select", name: "archived", label: "Archived", allLabel: "Hide", options: [{ value: "1", label: "Include" }] },
        ]}
      />
      <SavedViews actor={actor} module="accounts" basePath="/crm/accounts" query={qs({ ...sp, page: undefined }).slice(1)} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Account</TH><TH>Lifecycle</TH><TH>Services bought</TH><TH>Owner</TH><TH align="right">Contacts</TH><TH align="right">Open deals</TH><TH align="right">Active engagements</TH></tr></THead>
            <tbody>
              {rows.map(({ a, ownerName, contacts, openOpps, activeEngs, services }) => (
                <TR key={a.id}>
                  <TD>
                    <Link href={`/crm/accounts/${a.id}`} className="font-medium text-ink hover:underline">{a.name}</Link>
                    <p className="text-[11.5px] text-muted">{[a.domain, a.industry, a.country].filter(Boolean).join(" · ")}</p>
                  </TD>
                  <TD><StatusBadge status={a.lifecycleStatus} />{a.archivedAt ? <Badge className="ml-1">archived</Badge> : null}</TD>
                  <TD><div className="flex flex-wrap gap-1">{services.map((s) => <Badge key={s}>{s}</Badge>)}</div></TD>
                  <TD>{ownerName ?? <span className="text-faint">—</span>}</TD>
                  <TD align="right">{contacts}</TD>
                  <TD align="right">{openOpps}</TD>
                  <TD align="right">{activeEngs}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No accounts match" />
        )}
        <Pagination page={page} pageSize={50} total={Number(total)} hrefFor={(p) => `/crm/accounts${qs({ ...sp, page: p })}`} />
      </Card>
    </>
  );
}

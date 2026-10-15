import Link from "next/link";
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { qs } from "@/lib/utils";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Contacts" };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const L = await crmLookups();
  const conds: (SQL | undefined)[] = [isNull(contacts.archivedAt), or(accountVisibility(actor), isNull(contacts.primaryAccountId))];
  if (sp.q) conds.push(or(ilike(contacts.fullName, `%${sp.q}%`), ilike(sql`coalesce(${contacts.email},'')`, `%${sp.q}%`), ilike(sql`coalesce(${accounts.name},'')`, `%${sp.q}%`)));
  if (sp.role) conds.push(sql`${sp.role} = any(${contacts.buyingRoles})`);
  if (sp.optout === "1") conds.push(eq(contacts.doNotContact, true));
  if (sp.owner) conds.push(eq(contacts.ownerId, sp.owner));
  const where = and(...conds);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(contacts).leftJoin(accounts, eq(accounts.id, contacts.primaryAccountId)).where(where);
  const rows = await db.select({ c: contacts, accountName: accounts.name, ownerName: user.name }).from(contacts).leftJoin(accounts, eq(accounts.id, contacts.primaryAccountId)).leftJoin(user, eq(user.id, contacts.ownerId)).where(where).orderBy(asc(contacts.fullName)).limit(50).offset((page - 1) * 50);
  return (
    <>
      <PageHeader crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Contacts" }]} title="Contacts" description="People at accounts and partners, with buying roles and contact restrictions." actions={<>{can(actor, "crm.export") ? <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href="/api/export/contacts">Export</a> : null}{can(actor, "crm.write") ? <LinkButton href="/crm/contacts/new" variant="primary">New contact</LinkButton> : null}</>} />
      <FilterBar fields={[{ type: "search", name: "q", label: "Search", placeholder: "Name, email or account" }, { type: "select", name: "role", label: "Buying role", options: L.contactRoles }, { type: "select", name: "owner", label: "Owner", options: L.users }, { type: "select", name: "optout", label: "Opt-out", options: [{ value: "1", label: "Opted out only" }] }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Account</TH><TH>Title</TH><TH>Roles</TH><TH>Email</TH><TH>Owner</TH></tr></THead>
            <tbody>
              {rows.map(({ c, accountName, ownerName }) => (
                <TR key={c.id}>
                  <TD><Link href={`/crm/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>{c.doNotContact ? <Badge tone="danger" className="ml-1">opted out</Badge> : null}</TD>
                  <TD>{c.primaryAccountId ? <Link href={`/crm/accounts/${c.primaryAccountId}`} className="hover:underline">{accountName}</Link> : "—"}</TD>
                  <TD>{c.jobTitle}</TD>
                  <TD><div className="flex flex-wrap gap-1">{c.buyingRoles.map((r) => <Badge key={r}>{L.contactRoles.find((x) => x.value === r)?.label ?? r}</Badge>)}</div></TD>
                  <TD className="text-[12.5px]">{c.email}</TD>
                  <TD>{ownerName}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No contacts match" />}
        <Pagination page={page} pageSize={50} total={Number(total)} hrefFor={(p) => `/crm/contacts${qs({ ...sp, page: p })}`} />
      </Card>
    </>
  );
}

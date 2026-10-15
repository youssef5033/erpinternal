import Link from "next/link";
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import { departments, people } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { agencyToday } from "@/server/system/settings";
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "People" };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("people.read");
  const sp = await searchParams;
  const today = await agencyToday(db);
  const mgr = alias(people, "mgr");
  const conds: (SQL | undefined)[] = [sp.status ? eq(people.status, sp.status as "active") : inArray(people.status, ["active", "onboarding", "offboarding"])];
  if (sp.q) conds.push(or(ilike(people.fullName, `%${sp.q}%`), ilike(sql`coalesce(${people.jobTitle},'')`, `%${sp.q}%`)));
  if (sp.type) conds.push(eq(people.type, sp.type as "employee"));
  if (sp.dept) conds.push(eq(people.departmentId, sp.dept));
  const rows = await db
    .select({
      p: people,
      dept: departments.name,
      manager: mgr.fullName,
      away: sql<boolean>`exists (select 1 from leave_requests l where l.person_id = "people"."id" and l.status = 'approved' and ${today} between l.start_date and l.end_date)`,
      engagements: sql<number>`(select count(*) from engagement_members em join engagements e on e.id = em.engagement_id where em.user_id = "people"."user_id" and e.status in ('onboarding','active'))`,
      openChecklist: sql<string | null>`(select kind from person_checklists c where c.person_id = "people"."id" and c.completed_at is null limit 1)`,
    })
    .from(people)
    .leftJoin(departments, eq(departments.id, people.departmentId))
    .leftJoin(mgr, eq(mgr.id, people.managerId))
    .where(and(...conds))
    .orderBy(asc(people.fullName));
  const depts = await db.select({ value: departments.id, label: departments.name }).from(departments).orderBy(departments.name);
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }]} title="People" description="Employees and contractors, their capacity, assignments and availability." actions={can(actor, "people.write") ? <LinkButton variant="primary" href="/people/new">Add person</LinkButton> : null} />
      <FilterBar fields={[{ type: "search", name: "q", label: "Search", placeholder: "Name or title" }, { type: "select", name: "type", label: "Type", options: [{ value: "employee", label: "Employees" }, { value: "contractor", label: "Contractors" }] }, { type: "select", name: "dept", label: "Department", options: depts }, { type: "select", name: "status", label: "Status", allLabel: "Current", options: ["onboarding", "active", "offboarding", "inactive"].map((s) => ({ value: s, label: s })) }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Role</TH><TH>Department</TH><TH>Manager</TH><TH align="right">Capacity / wk</TH><TH align="right">Active engagements</TH><TH>Time zone</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ p, dept, manager, away, engagements, openChecklist }) => (
                <TR key={p.id}>
                  <TD><Link className="font-medium hover:underline" href={`/people/${p.id}`}>{p.fullName}</Link>{p.type === "contractor" ? <Badge className="ml-1">contractor</Badge> : null}{away ? <Badge tone="info" className="ml-1">away today</Badge> : null}</TD>
                  <TD>{p.jobTitle ?? "—"}</TD>
                  <TD>{dept ?? "—"}</TD>
                  <TD>{manager ?? "—"}</TD>
                  <TD align="right">{Number(p.weeklyCapacityHours)}h</TD>
                  <TD align="right">{Number(engagements)}</TD>
                  <TD className="text-[12.5px]">{p.timeZone}</TD>
                  <TD><StatusBadge status={p.status} />{openChecklist ? <Badge tone="warning" className="ml-1">{openChecklist} open</Badge> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No people match" />}
      </Card>
    </>
  );
}

import Link from "next/link";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { departments, engagementMembers, engagements, leaveRequests, people, tasks, timeEntries } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { personCapacity } from "@/server/ops/dashboard";
import { OPEN_TASK_STATUSES } from "@/server/delivery/tasks";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO, weekStartISO } from "@/lib/dates";
import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Progress } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Capacity" };

export default async function CapacityPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("people.read");
  const sp = await searchParams;
  const weeks = [2, 4, 8].includes(Number(sp.weeks)) ? Number(sp.weeks) : 4;
  const today = await agencyToday(db);
  const from = weekStartISO(today);
  const to = addDaysISO(from, weeks * 7 - 1);
  const pastFrom = addDaysISO(from, -28);
  const pastTo = addDaysISO(from, -1);
  const ppl = await db.select({ p: people, dept: departments.name }).from(people).leftJoin(departments, eq(departments.id, people.departmentId)).where(and(inArray(people.status, ["active", "onboarding", "offboarding"]), sp.type ? eq(people.type, sp.type as "employee") : undefined)).orderBy(people.fullName);
  const ids = ppl.map((x) => x.p.id);
  const leave = ids.length ? await db.select().from(leaveRequests).where(and(inArray(leaveRequests.personId, ids), eq(leaveRequests.status, "approved"), lte(leaveRequests.startDate, to), gte(leaveRequests.endDate, pastFrom))) : [];
  const past = ids.length ? await db.select({ personId: timeEntries.personId, hours: sql<string>`sum(${timeEntries.hours})`, billable: sql<string>`sum(case when ${timeEntries.billable} and ${timeEntries.engagementId} is not null then ${timeEntries.hours} else 0 end)` }).from(timeEntries).where(and(inArray(timeEntries.personId, ids), inArray(timeEntries.status, ["approved", "submitted"]), gte(timeEntries.workDate, pastFrom), lte(timeEntries.workDate, pastTo))).groupBy(timeEntries.personId) : [];
  const rows = [];
  for (const { p, dept } of ppl) {
    const myLeave = leave.filter((l) => l.personId === p.id);
    const cap = Number(personCapacity(p, from, to, myLeave));
    const pastCap = Number(personCapacity(p, pastFrom, pastTo, myLeave));
    const [alloc] = p.userId ? await db.select({ h: sql<string>`coalesce(sum(${engagementMembers.allocationHoursPerWeek}),0)`, n: sql<number>`count(*)` }).from(engagementMembers).innerJoin(engagements, eq(engagements.id, engagementMembers.engagementId)).where(and(eq(engagementMembers.userId, p.userId), inArray(engagements.status, ["onboarding", "active"]))) : [{ h: "0", n: 0 }];
    const [est] = p.userId ? await db.select({ h: sql<string>`coalesce(sum(${tasks.estimateHours}),0)`, n: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.ownerId, p.userId), inArray(tasks.status, OPEN_TASK_STATUSES), lte(tasks.dueDate, to))) : [{ h: "0", n: 0 }];
    const allocated = Number(alloc.h) * weeks;
    const booked = Math.max(allocated, Number(est.h));
    const pt = past.find((x) => x.personId === p.id);
    rows.push({ p, dept, cap, allocated, estimates: Number(est.h), openTasks: Number(est.n), engagements: Number(alloc.n), load: cap ? (booked / cap) * 100 : null, leaveDays: myLeave.filter((l) => l.endDate >= from).length, util: pastCap ? (Number(pt?.hours ?? 0) / pastCap) * 100 : null, billable: pt && Number(pt.hours) ? (Number(pt.billable) / Number(pt.hours)) * 100 : null });
  }
  rows.sort((a, b) => (b.load ?? 0) - (a.load ?? 0));
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Capacity" }]} title="Capacity" description={`Forward load for ${from} → ${to} and utilisation over the previous four weeks.`} />
      <FilterBar fields={[{ type: "select", name: "weeks", label: "Horizon", allLabel: "4 weeks", options: [{ value: "2", label: "2 weeks" }, { value: "8", label: "8 weeks" }] }, { type: "select", name: "type", label: "Type", options: [{ value: "employee", label: "Employees" }, { value: "contractor", label: "Contractors" }] }]} />
      <Card>
        <CardHeader title="Team load" description="Load = max(engagement allocations, open task estimates due in the window) ÷ capacity. Capacity excludes approved leave and non-working days. Utilisation = logged hours ÷ capacity in the last 4 weeks." />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Person</TH><TH align="right">Capacity</TH><TH align="right">Allocated</TH><TH align="right">Task estimates</TH><TH className="w-48">Forward load</TH><TH align="right">Utilisation (4 wks)</TH><TH align="right">Billable share</TH></tr></THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r.p.id}>
                  <TD><Link className="font-medium hover:underline" href={`/people/${r.p.id}`}>{r.p.fullName}</Link><div className="text-[12px] text-muted">{[r.p.jobTitle, r.dept].filter(Boolean).join(" · ")}{r.leaveDays ? " · leave booked" : ""}</div></TD>
                  <TD align="right">{r.cap.toFixed(0)}h</TD>
                  <TD align="right">{r.allocated.toFixed(0)}h<div className="text-[11.5px] text-muted">{r.engagements} engagement(s)</div></TD>
                  <TD align="right">{r.estimates.toFixed(0)}h<div className="text-[11.5px] text-muted">{r.openTasks} task(s)</div></TD>
                  <TD>{r.load === null ? <span className="text-faint">no capacity</span> : <div className="flex items-center gap-2"><div className="flex-1"><Progress value={Math.min(r.load, 150)} max={150} tone={r.load > 100 ? "danger" : r.load > 85 ? "warning" : "accent"} /></div><span className="num w-10 text-right text-[12px]">{r.load.toFixed(0)}%</span>{r.load > 100 ? <Badge tone="danger">over</Badge> : r.load < 50 ? <Badge>available</Badge> : null}</div>}</TD>
                  <TD align="right">{r.util === null ? "—" : `${r.util.toFixed(0)}%`}</TD>
                  <TD align="right">{r.billable === null ? "—" : `${r.billable.toFixed(0)}%`}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No active people" />}
      </Card>
    </>
  );
}

import Link from "next/link";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { engagements, people, tasks, timeEntries } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { engagementVisibility } from "@/server/auth/scope";
import { personCapacity } from "@/server/ops/dashboard";
import { OPEN_TASK_STATUSES } from "@/server/delivery/tasks";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO, isISODate, weekStartISO } from "@/lib/dates";
import { approveTimeAction, logTimeAction } from "@/server/actions/delivery";
import { qs } from "@/lib/utils";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select } from "@/components/forms/fields";

export const metadata = { title: "Timesheets" };

export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("time.write", "time.approve");
  const sp = await searchParams;
  const tab = sp.tab === "approvals" && can(actor, "time.approve") ? "approvals" : "week";
  const today = await agencyToday(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Timesheets" }]} title="Timesheets" description="Log time against engagements and tasks. Approved time drives labour cost, time-and-materials billing and percent-complete revenue." />
      <Tabs current={tab} tabs={[{ key: "week", label: "My week", href: "/people/timesheets" }, ...(can(actor, "time.approve") ? [{ key: "approvals", label: "Approvals", href: "/people/timesheets?tab=approvals" }] : [])]} />
      <div className="mt-4">{tab === "week" ? <Week sp={sp} actor={actor} today={today} /> : <Approvals sp={sp} actor={actor} />}</div>
    </>
  );
}

async function Week({ sp, actor, today }: { sp: Record<string, string | undefined>; actor: Awaited<ReturnType<typeof guard>>; today: string }) {
  const [me] = await db.select().from(people).where(eq(people.userId, actor.userId));
  if (!me) return <Notice tone="warning">Your login is not linked to a person record, so time cannot be logged. Ask an administrator to link it under People.</Notice>;
  const start = weekStartISO(isISODate(sp.week) ? sp.week! : today);
  const end = addDaysISO(start, 6);
  const entries = await db.select({ t: timeEntries, engName: engagements.name, taskTitle: tasks.title }).from(timeEntries).leftJoin(engagements, eq(engagements.id, timeEntries.engagementId)).leftJoin(tasks, eq(tasks.id, timeEntries.taskId)).where(and(eq(timeEntries.personId, me.id), gte(timeEntries.workDate, start), lte(timeEntries.workDate, end))).orderBy(asc(timeEntries.workDate));
  const engs = await db.select({ value: engagements.id, label: engagements.name }).from(engagements).where(and(inArray(engagements.status, ["onboarding", "active", "on_hold"]), engagementVisibility(actor))).orderBy(engagements.name);
  const myTasks = await db.select({ value: tasks.id, label: tasks.title }).from(tasks).where(and(eq(tasks.ownerId, actor.userId), inArray(tasks.status, OPEN_TASK_STATUSES))).orderBy(tasks.title);
  const cap = personCapacity(me, start, end, []);
  const total = entries.reduce((a, e) => a + Number(e.t.hours), 0);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(start, i));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <LinkButton size="sm" href={`/people/timesheets${qs({ week: addDaysISO(start, -7) })}`}>← Previous</LinkButton>
        <LinkButton size="sm" href="/people/timesheets">This week</LinkButton>
        <LinkButton size="sm" href={`/people/timesheets${qs({ week: addDaysISO(start, 7) })}`}>Next →</LinkButton>
        <p className="ml-2 text-[14px] font-semibold">Week of <DateText value={start} /></p>
        <p className="ml-auto text-[13px]">{total.toFixed(2)}h logged of {Number(cap).toFixed(1)}h capacity</p>
      </div>
      <Card>
        <Table>
          <THead><tr><TH>Day</TH><TH>Engagement / task</TH><TH>Description</TH><TH align="right">Hours</TH><TH>Status</TH></tr></THead>
          <tbody>
            {days.map((day) => {
              const list = entries.filter((e) => e.t.workDate === day);
              return list.length ? list.map((e, i) => (
                <TR key={e.t.id}>
                  <TD>{i === 0 ? <DateText value={day} /> : ""}</TD>
                  <TD className="text-[12.5px]">{e.t.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${e.t.engagementId}?tab=time`}>{e.engName}</Link> : "Internal"}{e.taskTitle ? <div className="text-muted">{e.taskTitle}</div> : null}</TD>
                  <TD className="text-[12.5px]">{e.t.description}{!e.t.billable ? <Badge className="ml-1">non-billable</Badge> : null}</TD>
                  <TD align="right">{Number(e.t.hours).toFixed(2)}</TD>
                  <TD><StatusBadge status={e.t.status} />{e.t.rejectionReason ? <div className="text-[12px] text-danger">{e.t.rejectionReason}</div> : null}</TD>
                </TR>
              )) : <TR key={day}><TD><DateText value={day} /></TD><TD colSpan={4} className="text-[12.5px] text-faint">—</TD></TR>;
            })}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Add time" description="Entries are submitted for approval by the engagement lead or operations." />
        <CardBody>
          <ActionForm action={logTimeAction} resetOnSuccess>
            <FormGrid cols={4}>
              <Field label="Date"><Input type="date" name="workDate" defaultValue={today >= start && today <= end ? today : start} max={today} required /></Field>
              <Field label="Hours"><Input name="hours" inputMode="decimal" required placeholder="1.5" /></Field>
              <Field label="Engagement"><Select name="engagementId" options={engs} placeholder="Internal / overhead" /></Field>
              <Field label="Task"><Select name="taskId" options={myTasks} placeholder="—" /></Field>
            </FormGrid>
            <Field label="Description" className="mt-2"><Input name="description" /></Field>
            <div className="mt-2 flex items-center justify-between"><Checkbox name="billable" label="Billable (client work)" defaultChecked /><SubmitButton size="sm">Add entry</SubmitButton></div>
          </ActionForm>
        </CardBody>
      </Card>
    </div>
  );
}

async function Approvals({ sp, actor }: { sp: Record<string, string | undefined>; actor: Awaited<ReturnType<typeof guard>> }) {
  const rows = await db
    .select({ t: timeEntries, person: people.fullName, engName: engagements.name, taskTitle: tasks.title })
    .from(timeEntries)
    .innerJoin(people, eq(people.id, timeEntries.personId))
    .leftJoin(engagements, eq(engagements.id, timeEntries.engagementId))
    .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(and(eq(timeEntries.status, "submitted"), sp.person ? eq(timeEntries.personId, sp.person) : undefined, sp.engagement ? eq(timeEntries.engagementId, sp.engagement) : undefined))
    .orderBy(asc(people.fullName), desc(timeEntries.workDate))
    .limit(300);
  const mine = rows.filter((r) => r.t.userId !== actor.userId);
  return (
    <Card>
      <CardHeader title={`Awaiting approval (${mine.length})`} description="You cannot approve your own time. Leads with assigned scope can only approve time on engagements they lead or are on." />
      {mine.length ? (
        <ActionForm action={approveTimeAction}>
          <Table>
            <THead><tr><TH className="w-8"><span className="sr-only">Select</span></TH><TH>Person</TH><TH>Date</TH><TH>Engagement / task</TH><TH>Description</TH><TH align="right">Hours</TH></tr></THead>
            <tbody>
              {mine.map(({ t, person, engName, taskTitle }) => (
                <TR key={t.id}>
                  <TD><input type="checkbox" name="ids[]" value={t.id} defaultChecked aria-label={`Select ${person} ${t.workDate}`} className="h-4 w-4 accent-[var(--color-accent)]" /></TD>
                  <TD>{person}</TD>
                  <TD><DateText value={t.workDate} /></TD>
                  <TD className="text-[12.5px]">{engName ?? "Internal"}{taskTitle ? <div className="text-muted">{taskTitle}</div> : null}</TD>
                  <TD className="text-[12.5px]">{t.description}{!t.billable ? <Badge className="ml-1">non-billable</Badge> : null}</TD>
                  <TD align="right">{Number(t.hours).toFixed(2)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-end justify-end gap-2 border-t border-line p-3">
            <Field label="Reason (when returning)"><Input name="reason" className="w-64" /></Field>
            <SubmitButton variant="secondary" name="decision" value="reject">Return selected</SubmitButton>
            <SubmitButton name="decision" value="approve">Approve selected</SubmitButton>
          </div>
        </ActionForm>
      ) : <EmptyState title="Nothing awaiting approval" />}
    </Card>
  );
}

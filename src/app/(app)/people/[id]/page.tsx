import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { checklistItems, costRates, departments, engagementMembers, engagements, leaveRequests, people, personChecklists, tasks, timeEntries, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { engagementVisibility, taskVisibility } from "@/server/auth/scope";
import { personCapacity } from "@/server/ops/dashboard";
import { OPEN_TASK_STATUSES } from "@/server/delivery/tasks";
import { agencyToday, getSettings } from "@/server/system/settings";
import { addDaysISO, weekStartISO } from "@/lib/dates";
import { checklistAction, costRateAction } from "@/server/actions/people";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, PageHeader, PriorityBadge, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Progress } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel } from "@/components/records/panels";
import { PersonForm } from "@/components/people/person-form";
import { personFormLookups } from "@/components/people/lookups";

export const metadata = { title: "Person" };

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("people.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db.select({ p: people, dept: departments.name, login: user.email }).from(people).leftJoin(departments, eq(departments.id, people.departmentId)).leftJoin(user, eq(user.id, people.userId)).where(eq(people.id, id));
  if (!row) notFound();
  const p = row.p;
  const self = p.userId === actor.userId;
  const today = await agencyToday(db);
  const s = await getSettings(db);
  const [manager] = p.managerId ? await db.select().from(people).where(eq(people.id, p.managerId)) : [];
  const leave = await db.select().from(leaveRequests).where(eq(leaveRequests.personId, id)).orderBy(desc(leaveRequests.startDate)).limit(20);
  const from = weekStartISO(today);
  const to = addDaysISO(from, 27);
  const cap = personCapacity(p, from, to, leave.filter((l) => l.status === "approved"));
  const engs = p.userId ? await db.select({ e: engagements, role: engagementMembers.role, alloc: engagementMembers.allocationHoursPerWeek }).from(engagementMembers).innerJoin(engagements, eq(engagements.id, engagementMembers.engagementId)).where(and(eq(engagementMembers.userId, p.userId), inArray(engagements.status, ["onboarding", "active", "on_hold"]), engagementVisibility(actor))) : [];
  const allocated = engs.reduce((a, x) => a + Number(x.alloc ?? 0), 0) * 4;
  const openTasks = p.userId ? await db.select().from(tasks).where(and(eq(tasks.ownerId, p.userId), inArray(tasks.status, OPEN_TASK_STATUSES), taskVisibility(actor))).orderBy(asc(tasks.dueDate)).limit(20) : [];
  const canSeeTime = self || can(actor, "time.approve") || can(actor, "people.write");
  const time = canSeeTime ? await db.select({ t: timeEntries, engName: engagements.name }).from(timeEntries).leftJoin(engagements, eq(engagements.id, timeEntries.engagementId)).where(eq(timeEntries.personId, id)).orderBy(desc(timeEntries.workDate)).limit(15) : [];
  const checklists = await db.select().from(personChecklists).where(eq(personChecklists.personId, id)).orderBy(desc(personChecklists.createdAt));
  const items = checklists.length ? await db.select().from(checklistItems).where(and(eq(checklistItems.parentType, "person_checklist"), inArray(checklistItems.parentId, checklists.map((c) => c.id)))).orderBy(asc(checklistItems.sortOrder)) : [];
  const rates = can(actor, "costrates.read") ? await db.select().from(costRates).where(eq(costRates.personId, id)).orderBy(desc(costRates.effectiveFrom)) : null;
  const canWrite = can(actor, "people.write");
  const showLeaveDetail = self || canWrite;
  const L = canWrite ? await personFormLookups() : null;
  return (
    <>
      <PageHeader crumbs={[{ label: "People", href: "/people" }, { label: p.fullName }]} title={p.fullName} meta={<><StatusBadge status={p.status} />{p.type === "contractor" ? <Badge>contractor</Badge> : null}</>} description={[p.jobTitle, row.dept].filter(Boolean).join(" · ") || undefined} />
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Capacity — next 4 weeks" description={`${from} → ${to}. Capacity = weekly hours × working days, minus approved leave.`} />
            <CardBody>
              <div className="flex flex-wrap gap-6 text-[13px]"><span>Capacity <b>{cap.toFixed(1)}h</b></span><span>Allocated to engagements <b>{allocated.toFixed(1)}h</b></span><span>Open task estimates <b>{openTasks.reduce((a, t) => a + Number(t.estimateHours ?? 0), 0).toFixed(1)}h</b></span></div>
              <div className="mt-2"><Progress value={allocated} max={Number(cap) || 1} tone={allocated > Number(cap) ? "danger" : allocated > Number(cap) * 0.85 ? "warning" : "accent"} /></div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Engagements" />
            {engs.length ? <Table><tbody>{engs.map(({ e, role, alloc }) => <TR key={e.id}><TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${e.id}`}>{e.name}</Link></TD><TD>{role}</TD><TD align="right">{alloc ? `${Number(alloc)}h/wk` : "—"}</TD><TD><StatusBadge status={e.status} /></TD></TR>)}</tbody></Table> : <EmptyState title="Not assigned to any current engagement" />}
          </Card>
          <Card>
            <CardHeader title="Open tasks" actions={p.userId ? <Link className="text-[13px] text-accent hover:underline" href={`/people/tasks?owner=${p.userId}`}>All tasks</Link> : null} />
            {openTasks.length ? <Table><tbody>{openTasks.map((t) => <TR key={t.id}><TD><Link className="hover:underline" href={`/people/tasks/${t.id}`}>{t.title}</Link></TD><TD><PriorityBadge priority={t.priority} /></TD><TD><DateText value={t.dueDate} overdue={!!t.dueDate && t.dueDate < today} /></TD><TD><StatusBadge status={t.status} /></TD></TR>)}</tbody></Table> : <EmptyState title="No open tasks" />}
          </Card>
          {canSeeTime ? (
            <Card>
              <CardHeader title="Recent time" actions={<Link className="text-[13px] text-accent hover:underline" href={`/people/timesheets${self ? "" : `?person=${id}`}`}>Timesheets</Link>} />
              {time.length ? <Table><tbody>{time.map(({ t, engName }) => <TR key={t.id}><TD><DateText value={t.workDate} /></TD><TD>{engName ?? "Internal"}</TD><TD className="text-[12.5px] text-muted">{t.description}</TD><TD align="right">{Number(t.hours).toFixed(2)}h</TD><TD><StatusBadge status={t.status} /></TD></TR>)}</tbody></Table> : <EmptyState title="No time logged" />}
            </Card>
          ) : null}
          {checklists.length || canWrite ? (
            <Card>
              <CardHeader title="Onboarding & offboarding" actions={canWrite ? <ActionForm action={checklistAction} className="flex gap-1" hideSuccess><input type="hidden" name="personId" value={id} /><SubmitButton size="sm" variant="secondary" name="kind" value="onboarding">Start onboarding</SubmitButton><SubmitButton size="sm" variant="secondary" name="kind" value="offboarding" confirm="Start offboarding? Status becomes 'offboarding'.">Start offboarding</SubmitButton></ActionForm> : null} />
              {checklists.length ? checklists.map((c) => (
                <div key={c.id} className="border-t border-line px-4 py-3">
                  <p className="text-[13px] font-medium">{c.title} {c.completedAt ? <Badge tone="success">complete</Badge> : <Badge tone="warning">in progress</Badge>}</p>
                  <ul className="mt-1 space-y-1">
                    {items.filter((i) => i.parentId === c.id).map((i) => (
                      <li key={i.id}>
                        {canWrite ? (
                          <ActionForm action={checklistAction} hideSuccess className="flex items-center gap-2 text-[13px]">
                            <input type="hidden" name="itemId" value={i.id} />
                            <input type="hidden" name="done" value={i.done ? "false" : "true"} />
                            <button type="submit" className={`flex h-4 w-4 items-center justify-center rounded border ${i.done ? "border-accent bg-accent text-white" : "border-line-strong"}`} aria-label={i.done ? `Mark "${i.label}" not done` : `Mark "${i.label}" done`}>{i.done ? "✓" : ""}</button>
                            <span className={i.done ? "text-muted line-through" : ""}>{i.label}</span>
                          </ActionForm>
                        ) : <span className={`text-[13px] ${i.done ? "text-muted line-through" : ""}`}>{i.done ? "✓ " : "○ "}{i.label}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )) : <EmptyState title="No checklists" />}
            </Card>
          ) : null}
          <DocumentsPanel actor={actor} link={{ personId: id }} defaultType="employment" title="Documents (HR-private files visible only to HR)" />
          {canWrite && L ? <Card><CardHeader title="Edit" /><CardBody><PersonForm v={p} {...L} defaultTz={s.timeZone} /></CardBody></Card> : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={1} items={[
                { label: "Email", value: p.email ?? "—" },
                { label: "Phone", value: p.phone ?? "—" },
                { label: "Manager", value: manager ? <Link className="hover:underline" href={`/people/${manager.id}`}>{manager.fullName}</Link> : "—" },
                { label: "Start / end", value: <><DateText value={p.startDate} /> – <DateText value={p.endDate} /></> },
                { label: "Time zone", value: p.timeZone },
                { label: "Weekly capacity", value: `${Number(p.weeklyCapacityHours)} hours` },
                { label: "System login", value: row.login ?? "None" },
                ...(canWrite ? [{ label: "Notes", value: p.notes ?? "—" }] : []),
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Leave" actions={<Link className="text-[13px] text-accent hover:underline" href="/people/leave">{self ? "Request leave" : "Leave calendar"}</Link>} />
            {leave.length ? <ul className="divide-y divide-line text-[13px]">{leave.map((l) => <li key={l.id} className="flex justify-between px-4 py-2"><span><DateText value={l.startDate} /> – <DateText value={l.endDate} />{showLeaveDetail ? <span className="ml-1 text-muted">· {l.leaveType}</span> : null}</span><StatusBadge status={l.status} /></li>)}</ul> : <EmptyState title="No leave recorded" />}
          </Card>
          {rates ? (
            <Card>
              <CardHeader title="Cost rates" description="Internal hourly cost used for margins. Visible only to roles with cost-rate access." />
              {rates.length ? <ul className="divide-y divide-line text-[13px]">{rates.map((r) => <li key={r.id} className="flex justify-between px-4 py-2"><span>from <DateText value={r.effectiveFrom} />{r.note ? <span className="text-muted"> · {r.note}</span> : null}</span><Money value={r.hourlyCost} currency={r.currency} /></li>)}</ul> : <EmptyState title="No cost rate — margins will be understated" />}
              {can(actor, "costrates.write") ? (
                <CardBody className="border-t border-line">
                  <ActionForm action={costRateAction} resetOnSuccess>
                    <input type="hidden" name="personId" value={id} />
                    <FormGrid cols={3}>
                      <Field label="Effective from"><Input type="date" name="effectiveFrom" defaultValue={today} required /></Field>
                      <Field label="Hourly cost"><Input name="hourlyCost" inputMode="decimal" required /></Field>
                      <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={s.baseCurrency} /></Field>
                    </FormGrid>
                    <Field label="Note" className="mt-2"><Input name="note" /></Field>
                    <div className="mt-2 flex justify-end"><SubmitButton size="sm">Record rate</SubmitButton></div>
                  </ActionForm>
                </CardBody>
              ) : null}
            </Card>
          ) : null}
          <AuditPanel actor={actor} entityType="person" entityId={id} />
        </div>
      </div>
    </>
  );
}

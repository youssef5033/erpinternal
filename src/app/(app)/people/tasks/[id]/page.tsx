import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, checklistItems, engagements, taskComments, taskDependencies, tasks, timeEntries, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { taskVisibility } from "@/server/auth/scope";
import { OPEN_TASK_STATUSES, TASK_TRANSITIONS } from "@/server/delivery/tasks";
import { agencyToday } from "@/server/system/settings";
import { checklistAddAction, checklistToggleAction, taskCommentAction, taskDependencyAction, taskStatusAction } from "@/server/actions/shared";
import { logTimeAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, PageHeader, PriorityBadge, StatusBadge } from "@/components/ui/primitives";
import { DateText, DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { AuditPanel } from "@/components/records/panels";
import { TaskForm } from "@/components/people/task-form";
import { taskLookups } from "@/components/people/task-lookups";

export const metadata = { title: "Task" };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db.select({ t: tasks, ownerName: user.name, engName: engagements.name, accountName: accounts.name }).from(tasks).leftJoin(user, eq(user.id, tasks.ownerId)).leftJoin(engagements, eq(engagements.id, tasks.engagementId)).leftJoin(accounts, eq(accounts.id, tasks.accountId)).where(and(eq(tasks.id, id), taskVisibility(actor)));
  if (!row) notFound();
  const t = row.t;
  const today = await agencyToday(db);
  const items = await db.select().from(checklistItems).where(and(eq(checklistItems.parentType, "task"), eq(checklistItems.parentId, id))).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.createdAt));
  const comments = await db.select({ c: taskComments, author: user.name }).from(taskComments).leftJoin(user, eq(user.id, taskComments.authorId)).where(eq(taskComments.taskId, id)).orderBy(asc(taskComments.createdAt));
  const deps = await db.select({ d: taskDependencies, title: tasks.title, status: tasks.status }).from(taskDependencies).innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId)).where(eq(taskDependencies.taskId, id));
  const candidates = t.engagementId ? await db.select({ value: tasks.id, label: tasks.title }).from(tasks).where(and(eq(tasks.engagementId, t.engagementId), inArray(tasks.status, OPEN_TASK_STATUSES))) : [];
  const time = await db.select({ te: timeEntries, who: user.name }).from(timeEntries).leftJoin(user, eq(user.id, timeEntries.userId)).where(eq(timeEntries.taskId, id)).orderBy(desc(timeEntries.workDate)).limit(20);
  const L = await taskLookups(actor);
  const open = OPEN_TASK_STATUSES.includes(t.status);
  const waiting = deps.filter((x) => OPEN_TASK_STATUSES.includes(x.status));
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Tasks", href: "/people/tasks" }, { label: t.title }]} title={t.title} meta={<><StatusBadge status={t.status} /><PriorityBadge priority={t.priority} />{t.kind !== "task" ? <Badge>{t.kind.replace("_", " ")}</Badge> : null}{t.recurrence !== "none" ? <Badge>repeats {t.recurrence}</Badge> : null}</>} />
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Status" />
            <CardBody>
              {waiting.length ? <p className="mb-2 text-[13px] text-warning">Waiting on {waiting.length} unfinished task(s) before it can complete.</p> : null}
              {t.status === "blocked" && t.blockedReason ? <p className="mb-2 text-[13px] text-danger">Blocked: {t.blockedReason}</p> : null}
              <ActionForm action={taskStatusAction} className="space-y-2">
                <input type="hidden" name="id" value={id} />
                {TASK_TRANSITIONS[t.status].includes("blocked") ? <Field label="Blocked reason (when blocking)"><Input name="blockedReason" /></Field> : null}
                <div className="flex flex-wrap gap-2">{TASK_TRANSITIONS[t.status].map((s) => <SubmitButton key={s} size="sm" variant={s === "completed" ? "primary" : s === "cancelled" ? "ghost" : "secondary"} name="status" value={s}>{s === "in_progress" && t.status === "completed" ? "Reopen" : s.replace(/_/g, " ")}</SubmitButton>)}</div>
              </ActionForm>
            </CardBody>
          </Card>
          {t.description ? <Card><CardHeader title="Description" /><CardBody><p className="whitespace-pre-wrap text-[13.5px]">{t.description}</p></CardBody></Card> : null}
          <Card>
            <CardHeader title="Checklist" description={items.length ? `${items.filter((i) => i.done).length} of ${items.length} done` : undefined} />
            {items.length ? (
              <ul className="space-y-1 px-4 py-3">
                {items.map((i) => (
                  <li key={i.id}>
                    <ActionForm action={checklistToggleAction} hideSuccess className="flex items-center gap-2 text-[13px]">
                      <input type="hidden" name="id" value={i.id} /><input type="hidden" name="done" value={i.done ? "false" : "true"} />
                      <button type="submit" aria-label={i.done ? `Mark "${i.label}" not done` : `Mark "${i.label}" done`} className={`flex h-4 w-4 items-center justify-center rounded border ${i.done ? "border-accent bg-accent text-white" : "border-line-strong"}`}>{i.done ? "✓" : ""}</button>
                      <span className={i.done ? "text-muted line-through" : ""}>{i.label}</span>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : null}
            <CardBody className={items.length ? "border-t border-line" : undefined}>
              <ActionForm action={checklistAddAction} resetOnSuccess hideSuccess className="flex gap-2">
                <input type="hidden" name="parentType" value="task" /><input type="hidden" name="parentId" value={id} />
                <Input name="label" aria-label="New checklist item" placeholder="Add an item" required />
                <SubmitButton size="sm" variant="secondary">Add</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Comments" />
            {comments.length ? <ul className="divide-y divide-line">{comments.map(({ c, author }) => <li key={c.id} className="px-4 py-2.5"><p className="text-[12px] text-muted">{author ?? "System"} · <DateTimeText value={c.createdAt} /></p><p className="whitespace-pre-wrap text-[13.5px]">{c.body}</p></li>)}</ul> : null}
            <CardBody className={comments.length ? "border-t border-line" : undefined}>
              <ActionForm action={taskCommentAction} resetOnSuccess hideSuccess>
                <input type="hidden" name="id" value={id} />
                <Textarea name="body" rows={2} aria-label="Comment" placeholder="Write a comment" required />
                <div className="mt-2 flex justify-end"><SubmitButton size="sm">Comment</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
          {can(actor, "time.write") ? (
            <Card>
              <CardHeader title="Time on this task" description={`${time.reduce((a, x) => a + Number(x.te.hours), 0).toFixed(2)}h logged${t.estimateHours ? ` of ${Number(t.estimateHours)}h estimated` : ""}`} />
              {time.length ? <ul className="divide-y divide-line text-[13px]">{time.map(({ te, who }) => <li key={te.id} className="flex justify-between px-4 py-2"><span><DateText value={te.workDate} /> · {who}{te.description ? <span className="text-muted"> · {te.description}</span> : null}</span><span>{Number(te.hours).toFixed(2)}h <StatusBadge status={te.status} /></span></li>)}</ul> : null}
              {open ? (
                <CardBody className="border-t border-line">
                  <ActionForm action={logTimeAction} resetOnSuccess>
                    <input type="hidden" name="taskId" value={id} />
                    {t.engagementId ? <input type="hidden" name="engagementId" value={t.engagementId} /> : null}
                    <FormGrid cols={3}>
                      <Field label="Date"><Input type="date" name="workDate" defaultValue={today} max={today} required /></Field>
                      <Field label="Hours"><Input name="hours" inputMode="decimal" required /></Field>
                      <Field label="Note"><Input name="description" /></Field>
                    </FormGrid>
                    <input type="hidden" name="billable" value={t.engagementId ? "on" : ""} />
                    <div className="mt-2 flex justify-end"><SubmitButton size="sm">Log time</SubmitButton></div>
                  </ActionForm>
                </CardBody>
              ) : null}
            </Card>
          ) : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={1} items={[
                { label: "Owner", value: row.ownerName ?? "Unassigned" },
                { label: "Due", value: <DateText value={t.dueDate} overdue={!!t.dueDate && t.dueDate < today && open} /> },
                { label: "Engagement", value: t.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${t.engagementId}?tab=tasks`}>{row.engName}</Link> : "—" },
                { label: "Account", value: t.accountId ? <Link className="hover:underline" href={`/crm/accounts/${t.accountId}`}>{row.accountName}</Link> : "—" },
                ...(t.opportunityId ? [{ label: "Opportunity", value: <Link className="hover:underline" href={`/crm/opportunities/${t.opportunityId}`}>Open</Link> }] : []),
                ...(t.leadId ? [{ label: "Lead", value: <Link className="hover:underline" href={`/crm/leads/${t.leadId}`}>Open</Link> }] : []),
                ...(t.invoiceId ? [{ label: "Invoice", value: <Link className="hover:underline" href={`/finance/invoices/${t.invoiceId}`}>Open</Link> }] : []),
                ...(t.eventId ? [{ label: "From meeting", value: <Link className="hover:underline" href={`/operations/calendar/events/${t.eventId}`}>Open</Link> }] : []),
                { label: "Reminder", value: t.reminderAt ? <DateTimeText value={t.reminderAt} /> : "—" },
                { label: "Completed", value: t.completedAt ? <DateTimeText value={t.completedAt} /> : "—" },
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Depends on" />
            {deps.length ? <ul className="divide-y divide-line text-[13px]">{deps.map((x) => <li key={x.d.dependsOnTaskId} className="flex justify-between px-4 py-2"><Link className="hover:underline" href={`/people/tasks/${x.d.dependsOnTaskId}`}>{x.title}</Link><StatusBadge status={x.status} /></li>)}</ul> : <EmptyState title="No dependencies" />}
            {candidates.filter((c) => c.value !== id && !deps.some((x) => x.d.dependsOnTaskId === c.value)).length ? (
              <CardBody className="border-t border-line">
                <ActionForm action={taskDependencyAction} hideSuccess className="flex gap-2">
                  <input type="hidden" name="id" value={id} />
                  <Select name="dependsOn" aria-label="Depends on task" options={candidates.filter((c) => c.value !== id && !deps.some((x) => x.d.dependsOnTaskId === c.value))} />
                  <SubmitButton size="sm" variant="secondary">Add</SubmitButton>
                </ActionForm>
              </CardBody>
            ) : null}
          </Card>
          <Card><CardHeader title="Edit" /><CardBody><TaskForm {...L} v={t} /></CardBody></Card>
          <AuditPanel actor={actor} entityType="task" entityId={id} />
        </div>
      </div>
    </>
  );
}

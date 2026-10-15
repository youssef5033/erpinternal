import Link from "next/link";
import { and, asc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, tasks, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { taskVisibility } from "@/server/auth/scope";
import { OPEN_TASK_STATUSES, TASK_STATUSES } from "@/server/delivery/tasks";
import { agencyToday } from "@/server/system/settings";
import { taskStatusAction } from "@/server/actions/shared";
import { qs } from "@/lib/utils";
import { Badge, Card, EmptyState, LinkButton, PageHeader, PriorityBadge, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { TASK_KINDS, PRIORITIES } from "@/components/people/task-form";

export const metadata = { title: "Tasks" };

const BOARD = ["backlog", "ready", "in_progress", "internal_review", "client_review", "blocked", "completed"] as const;

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard();
  const sp = await searchParams;
  const view = sp.view === "board" ? "board" : "list";
  const today = await agencyToday(db);
  const owner = sp.owner === "all" ? undefined : sp.owner ?? actor.userId;
  const conds: (SQL | undefined)[] = [taskVisibility(actor)];
  if (owner) conds.push(owner === "none" ? sql`${tasks.ownerId} is null` : eq(tasks.ownerId, owner));
  if (sp.status === "all") void 0;
  else if (sp.status) conds.push(eq(tasks.status, sp.status as "ready"));
  else if (view === "list") conds.push(inArray(tasks.status, OPEN_TASK_STATUSES));
  else conds.push(sql`(${tasks.status} <> 'cancelled' and (${tasks.status} <> 'completed' or ${tasks.completedAt} > now() - interval '14 days'))`);
  if (sp.q) conds.push(ilike(tasks.title, `%${sp.q}%`));
  if (sp.kind) conds.push(eq(tasks.kind, sp.kind as "task"));
  if (sp.priority) conds.push(eq(tasks.priority, sp.priority as "high"));
  if (sp.due === "overdue") conds.push(sql`${tasks.dueDate} < ${today}`);
  if (sp.due === "week") conds.push(sql`${tasks.dueDate} between ${today} and (${today}::date + 7)`);
  if (sp.engagement) conds.push(eq(tasks.engagementId, sp.engagement));
  const rows = await db
    .select({ t: tasks, ownerName: user.name, engName: engagements.name, accountName: accounts.name, blockedBy: sql<number>`(select count(*) from task_dependencies d join tasks dt on dt.id = d.depends_on_task_id where d.task_id = "tasks"."id" and dt.status not in ('completed','cancelled'))` })
    .from(tasks)
    .leftJoin(user, eq(user.id, tasks.ownerId))
    .leftJoin(engagements, eq(engagements.id, tasks.engagementId))
    .leftJoin(accounts, eq(accounts.id, tasks.accountId))
    .where(and(...conds))
    .orderBy(sql`${tasks.dueDate} asc nulls last`, asc(tasks.createdAt))
    .limit(300);
  const users = await db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name);
  const base = `/people/tasks`;
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Tasks" }]} title="Tasks" description="All work items across CRM, delivery, finance and people — filtered to what you can see." actions={<LinkButton variant="primary" href="/people/tasks/new">New task</LinkButton>} />
      <Tabs current={view} tabs={[{ key: "list", label: "List", href: `${base}${qs({ ...sp, view: null })}` }, { key: "board", label: "Board", href: `${base}${qs({ ...sp, view: "board" })}` }, { key: "calendar", label: "Calendar", href: `/operations/calendar?kind=task${owner && owner !== "none" ? `&owner=${owner}` : ""}` }]} />
      <div className="mt-3">
        <FilterBar keep={["view"]} fields={[{ type: "search", name: "q", label: "Search", placeholder: "Title" }, { type: "select", name: "owner", label: "Owner", allLabel: "Me", options: [{ value: "all", label: "Everyone" }, { value: "none", label: "Unassigned" }, ...users] }, { type: "select", name: "status", label: "Status", allLabel: view === "list" ? "Open" : "Board default", options: [{ value: "all", label: "All" }, ...TASK_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))] }, { type: "select", name: "due", label: "Due", options: [{ value: "overdue", label: "Overdue" }, { value: "week", label: "Next 7 days" }] }, { type: "select", name: "priority", label: "Priority", options: PRIORITIES.map((p) => ({ value: p, label: p })) }, { type: "select", name: "kind", label: "Kind", options: TASK_KINDS.map((k) => ({ value: k, label: k.replace("_", " ") })) }]} />
      </div>
      {view === "list" ? (
        <Card>
          {rows.length ? (
            <Table>
              <THead><tr><TH>Task</TH><TH>Linked to</TH><TH>Owner</TH><TH>Due</TH><TH>Priority</TH><TH>Status</TH><TH /></tr></THead>
              <tbody>
                {rows.map(({ t, ownerName, engName, accountName, blockedBy }) => (
                  <TR key={t.id}>
                    <TD><Link className="font-medium hover:underline" href={`/people/tasks/${t.id}`}>{t.title}</Link>{t.kind !== "task" ? <Badge className="ml-1">{t.kind.replace("_", " ")}</Badge> : null}{Number(blockedBy) ? <Badge tone="warning" className="ml-1">waiting on {blockedBy}</Badge> : null}{t.blockedReason && t.status === "blocked" ? <div className="text-[12px] text-danger">{t.blockedReason}</div> : null}</TD>
                    <TD className="text-[12.5px]">{t.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${t.engagementId}?tab=tasks`}>{engName}</Link> : accountName ?? (t.invoiceId ? <Link className="hover:underline" href={`/finance/invoices/${t.invoiceId}`}>Invoice</Link> : t.opportunityId ? <Link className="hover:underline" href={`/crm/opportunities/${t.opportunityId}`}>Opportunity</Link> : t.leadId ? <Link className="hover:underline" href={`/crm/leads/${t.leadId}`}>Lead</Link> : "—")}</TD>
                    <TD>{ownerName ?? <span className="text-warning">unassigned</span>}</TD>
                    <TD><DateText value={t.dueDate} overdue={!!t.dueDate && t.dueDate < today && OPEN_TASK_STATUSES.includes(t.status)} /></TD>
                    <TD><PriorityBadge priority={t.priority} /></TD>
                    <TD><StatusBadge status={t.status} /></TD>
                    <TD align="right">{OPEN_TASK_STATUSES.includes(t.status) && t.status !== "blocked" ? <ActionForm action={taskStatusAction} hideSuccess><input type="hidden" name="id" value={t.id} /><SubmitButton size="sm" variant="ghost" name="status" value="completed">Complete</SubmitButton></ActionForm> : null}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No tasks match" description="Change the owner filter to see the team's tasks." />}
        </Card>
      ) : (
        <div className="grid grid-flow-col auto-cols-[minmax(240px,1fr)] gap-3 overflow-x-auto pb-2">
          {BOARD.map((col) => {
            const list = rows.filter((r) => r.t.status === col);
            return (
              <section key={col} className="rounded-[var(--radius-card)] border border-line bg-sunken/40" aria-label={col.replace(/_/g, " ")}>
                <h2 className="flex items-center justify-between border-b border-line px-3 py-2 text-[12.5px] font-semibold capitalize">{col.replace(/_/g, " ")}<Badge>{list.length}</Badge></h2>
                <ul className="space-y-2 p-2">
                  {list.map(({ t, ownerName, engName }) => (
                    <li key={t.id} className="rounded-md border border-line bg-surface p-2.5 text-[13px] shadow-[0_1px_0_rgba(0,0,0,0.02)]">
                      <Link className="font-medium hover:underline" href={`/people/tasks/${t.id}`}>{t.title}</Link>
                      <p className="mt-0.5 text-[12px] text-muted">{engName ?? ""}{engName && ownerName ? " · " : ""}{ownerName ?? "unassigned"}</p>
                      <div className="mt-1.5 flex items-center justify-between"><DateText value={t.dueDate} overdue={!!t.dueDate && t.dueDate < today && col !== "completed"} className="text-[12px]" /><PriorityBadge priority={t.priority} /></div>
                      <ActionForm action={taskStatusAction} className="mt-2 flex flex-wrap gap-1" hideSuccess>
                        <input type="hidden" name="id" value={t.id} />
                        {(col === "backlog" ? ["ready"] : col === "ready" ? ["in_progress"] : col === "in_progress" ? ["internal_review", "completed"] : col === "internal_review" ? ["client_review", "completed"] : col === "client_review" ? ["completed"] : col === "blocked" ? ["ready"] : []).map((to) => <SubmitButton key={to} size="sm" variant="ghost" name="status" value={to}>→ {to.replace(/_/g, " ")}</SubmitButton>)}
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

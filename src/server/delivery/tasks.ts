import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { checklistItems, taskComments, taskDependencies, tasks, type TaskKind, type TaskPriority, type TaskStatus } from "@/db/schema";
import { addDaysISO, addMonthsISO } from "@/lib/dates";
import { can, canAll, isSystem, type Actor } from "../auth/actor";
import { assertEngagementAccess } from "../auth/scope";
import { audit, diff } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";

export const TASK_STATUSES: TaskStatus[] = ["backlog", "ready", "in_progress", "internal_review", "client_review", "completed", "blocked", "cancelled"];

export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready", "in_progress", "blocked", "cancelled"],
  ready: ["backlog", "in_progress", "blocked", "cancelled", "completed"],
  in_progress: ["ready", "internal_review", "client_review", "completed", "blocked", "cancelled"],
  internal_review: ["in_progress", "client_review", "completed", "blocked", "cancelled"],
  client_review: ["in_progress", "internal_review", "completed", "blocked", "cancelled"],
  blocked: ["ready", "in_progress", "cancelled"],
  completed: ["in_progress"],
  cancelled: ["ready"],
};

export const OPEN_TASK_STATUSES: TaskStatus[] = ["backlog", "ready", "in_progress", "internal_review", "client_review", "blocked"];

export type TaskInput = {
  title: string;
  description?: string | null;
  kind?: TaskKind;
  module?: "crm" | "delivery" | "finance" | "people" | "operations";
  status?: TaskStatus;
  priority?: TaskPriority;
  ownerId?: string | null;
  dueDate?: string | null;
  startDate?: string | null;
  estimateHours?: string | null;
  nextAction?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  opportunityId?: string | null;
  engagementId?: string | null;
  projectId?: string | null;
  milestoneId?: string | null;
  deliverableId?: string | null;
  invoiceId?: string | null;
  billId?: string | null;
  personId?: string | null;
  eventId?: string | null;
  recurrence?: "none" | "daily" | "weekly" | "monthly";
  reminderAt?: Date | null;
  generationKey?: string | null;
  checklist?: string[];
};

function inferModule(input: TaskInput): TaskInput["module"] {
  if (input.module) return input.module;
  if (input.engagementId || input.deliverableId || input.milestoneId) return "delivery";
  if (input.invoiceId || input.billId) return "finance";
  if (input.leadId || input.opportunityId || input.accountId || input.contactId) return "crm";
  if (input.personId) return "people";
  return "operations";
}

function assertTaskWrite(actor: Actor, task: { ownerId: string | null; createdBy?: string | null; module: string }) {
  if (isSystem(actor)) return;
  if (task.ownerId === actor.userId || task.createdBy === actor.userId) return;
  const perm = task.module === "crm" ? "crm.write" : task.module === "finance" ? "finance.write" : task.module === "people" ? "people.write" : "delivery.write";
  if (!canAll(actor, perm)) throw new ForbiddenError("You can only change tasks you own or created.");
}

/** Create a task. With a generationKey the call is idempotent (returns existing). */
export async function createTask(tx: Tx, actor: Actor, input: TaskInput) {
  if (!input.title?.trim()) throw new ValidationError("Task title is required.", { title: "Required" });
  if (input.engagementId && !isSystem(actor)) await assertEngagementAccess(tx, actor, input.engagementId, "delivery.read");
  if (!isSystem(actor) && !can(actor, "delivery.write") && !can(actor, "crm.write") && !can(actor, "finance.write") && !can(actor, "people.write")) {
    throw new ForbiddenError();
  }
  if (input.generationKey) {
    const [existing] = await tx.select().from(tasks).where(eq(tasks.generationKey, input.generationKey));
    if (existing) return existing;
  }
  const [task] = await tx
    .insert(tasks)
    .values({
      title: input.title.trim(),
      description: input.description || null,
      kind: input.kind ?? "task",
      module: inferModule(input)!,
      status: input.status ?? "ready",
      priority: input.priority ?? "medium",
      ownerId: input.ownerId || (isSystem(actor) ? null : actor.userId),
      dueDate: input.dueDate || null,
      startDate: input.startDate || null,
      estimateHours: input.estimateHours || null,
      nextAction: input.nextAction || null,
      accountId: input.accountId || null,
      contactId: input.contactId || null,
      leadId: input.leadId || null,
      opportunityId: input.opportunityId || null,
      engagementId: input.engagementId || null,
      projectId: input.projectId || null,
      milestoneId: input.milestoneId || null,
      deliverableId: input.deliverableId || null,
      invoiceId: input.invoiceId || null,
      billId: input.billId || null,
      personId: input.personId || null,
      eventId: input.eventId || null,
      recurrence: input.recurrence ?? "none",
      reminderAt: input.reminderAt ?? null,
      generationKey: input.generationKey || null,
      createdBy: isSystem(actor) ? null : actor.userId,
    })
    .onConflictDoNothing({ target: tasks.generationKey })
    .returning();
  if (!task) {
    const [existing] = await tx.select().from(tasks).where(eq(tasks.generationKey, input.generationKey!));
    return existing;
  }
  if (input.checklist?.length) {
    await tx.insert(checklistItems).values(input.checklist.filter(Boolean).map((label, i) => ({ parentType: "task" as const, parentId: task.id, label, sortOrder: String(i) })));
  }
  await audit(tx, actor, { action: "task.created", entityType: "task", entityId: task.id, summary: `Task: ${task.title}` });
  return task;
}

export async function updateTask(tx: Tx, actor: Actor, id: string, input: Partial<TaskInput>) {
  const [before] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  if (!before) throw new NotFoundError("Task");
  assertTaskWrite(actor, before);
  const patch: Partial<typeof tasks.$inferInsert> = {};
  const keys = ["title", "description", "priority", "ownerId", "dueDate", "startDate", "estimateHours", "nextAction", "recurrence", "reminderAt", "blockedReason"] as const;
  for (const k of keys) {
    if (k in input) (patch as Record<string, unknown>)[k] = (input as Record<string, unknown>)[k] === "" ? null : (input as Record<string, unknown>)[k];
  }
  if (patch.title !== undefined && !String(patch.title).trim()) throw new ValidationError("Task title is required.");
  const [after] = await tx.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
  const changes = diff(before, after, ["title", "priority", "ownerId", "dueDate", "estimateHours"]);
  if (Object.keys(changes).length) await audit(tx, actor, { action: changes.ownerId ? "task.reassigned" : "task.updated", entityType: "task", entityId: id, summary: `Updated task ${after.title}`, changes });
  return after;
}

export async function changeTaskStatus(tx: Tx, actor: Actor, id: string, to: TaskStatus, opts: { blockedReason?: string | null } = {}) {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, id)).for("update");
  if (!task) throw new NotFoundError("Task");
  assertTaskWrite(actor, task);
  if (task.status === to) return task;
  if (!TASK_TRANSITIONS[task.status].includes(to)) throw new ValidationError(`A task in "${task.status.replace("_", " ")}" cannot move to "${to.replace("_", " ")}".`);
  if (to === "blocked" && !opts.blockedReason?.trim()) throw new ValidationError("Say what is blocking this task.", { blockedReason: "Required" });
  if (to === "completed" || to === "in_progress") {
    const open = await tx
      .select({ id: tasks.id, title: tasks.title })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
      .where(and(eq(taskDependencies.taskId, id), ne(tasks.status, "completed"), ne(tasks.status, "cancelled")));
    if (open.length) throw new ValidationError(`Waiting on: ${open.map((o) => o.title).join(", ")}.`);
  }
  const [after] = await tx
    .update(tasks)
    .set({
      status: to,
      blockedReason: to === "blocked" ? opts.blockedReason! : null,
      completedAt: to === "completed" ? new Date() : null,
      completedBy: to === "completed" && !isSystem(actor) ? actor.userId : null,
    })
    .where(eq(tasks.id, id))
    .returning();
  await audit(tx, actor, { action: "task.status_changed", entityType: "task", entityId: id, summary: `${task.title}: ${task.status} → ${to}`, changes: { status: { from: task.status, to } } });
  if (to === "completed" && task.recurrence !== "none") await spawnNextRecurrence(tx, actor, after);
  return after;
}

/** Next occurrence of a recurring task; idempotent via generationKey. */
export async function spawnNextRecurrence(tx: Tx, actor: Actor, task: typeof tasks.$inferSelect) {
  if (!task.dueDate || task.recurrence === "none") return null;
  const next = task.recurrence === "daily" ? addDaysISO(task.dueDate, 1) : task.recurrence === "weekly" ? addDaysISO(task.dueDate, 7) : addMonthsISO(task.dueDate, 1);
  const root = task.recurrenceParentId ?? task.id;
  const { id: _id, createdAt: _c, updatedAt: _u, completedAt: _ca, completedBy: _cb, generationKey: _g, status: _s, ...rest } = task;
  const [row] = await tx
    .insert(tasks)
    .values({ ...rest, status: "ready", dueDate: next, recurrenceParentId: root, generationKey: `recur:${root}:${next}` })
    .onConflictDoNothing({ target: tasks.generationKey })
    .returning();
  return row ?? null;
}

export async function addTaskComment(tx: Tx, actor: Actor, taskId: string, body: string) {
  if (!body.trim()) throw new ValidationError("Comment is empty.");
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new NotFoundError("Task");
  if (task.engagementId && !isSystem(actor)) await assertEngagementAccess(tx, actor, task.engagementId, "delivery.read");
  const [row] = await tx.insert(taskComments).values({ taskId, authorId: actor.userId || null, body: body.trim() }).returning();
  await audit(tx, actor, { action: "task.commented", entityType: "task", entityId: taskId, summary: `Comment on ${task.title}` });
  return row;
}

export async function addChecklistItem(tx: Tx, actor: Actor, parentType: "task" | "person_checklist", parentId: string, label: string) {
  if (!label.trim()) throw new ValidationError("Checklist item is empty.");
  const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(checklistItems).where(and(eq(checklistItems.parentType, parentType), eq(checklistItems.parentId, parentId)));
  const [row] = await tx.insert(checklistItems).values({ parentType, parentId, label: label.trim(), sortOrder: String(Number(n)) }).returning();
  return row;
}

export async function toggleChecklistItem(tx: Tx, actor: Actor, itemId: string, done: boolean) {
  const [row] = await tx
    .update(checklistItems)
    .set({ done, doneAt: done ? new Date() : null, doneBy: done && !isSystem(actor) ? actor.userId : null })
    .where(eq(checklistItems.id, itemId))
    .returning();
  if (!row) throw new NotFoundError("Checklist item");
  return row;
}

/** Add a dependency, rejecting cycles. */
export async function addTaskDependency(tx: Tx, actor: Actor, taskId: string, dependsOnTaskId: string) {
  if (taskId === dependsOnTaskId) throw new ValidationError("A task cannot depend on itself.");
  const [t] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  if (!t) throw new NotFoundError("Task");
  assertTaskWrite(actor, t);
  const res = await tx.execute<{ id: string }>(sql`
    with recursive chain(id) as (
      select depends_on_task_id from task_dependencies where task_id = ${dependsOnTaskId}
      union select d.depends_on_task_id from task_dependencies d join chain c on d.task_id = c.id
    ) select id from chain where id = ${taskId} limit 1`);
  if (res.rows.length) throw new ValidationError("That dependency would create a cycle.");
  await tx.insert(taskDependencies).values({ taskId, dependsOnTaskId }).onConflictDoNothing();
  await audit(tx, actor, { action: "task.dependency_added", entityType: "task", entityId: taskId, summary: `Dependency added`, changes: { dependsOnTaskId } });
}

export async function removeTaskDependency(tx: Tx, actor: Actor, taskId: string, dependsOnTaskId: string) {
  await tx.delete(taskDependencies).where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)));
  await audit(tx, actor, { action: "task.dependency_removed", entityType: "task", entityId: taskId, summary: `Dependency removed` });
}

export async function bulkUpdateTaskStatus(tx: Tx, actor: Actor, ids: string[], to: TaskStatus) {
  const rows = await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids));
  for (const r of rows) await changeTaskStatus(tx, actor, r.id, to);
  return rows.length;
}

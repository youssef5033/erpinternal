import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { checklistItems, leaveRequests, people, personChecklists } from "@/db/schema";
import { toFixed4 } from "@/lib/money";
import { daysBetween } from "@/lib/dates";
import { assertCan, can, type Actor } from "../auth/actor";
import { audit, diff } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { notify } from "../notifications";

export type PersonInput = {
  type: "employee" | "contractor";
  fullName: string;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  departmentId?: string | null;
  managerId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  timeZone: string;
  weeklyCapacityHours: string;
  status: "active" | "onboarding" | "offboarding" | "inactive";
  userId?: string | null;
  notes?: string | null;
};

export async function savePerson(tx: Tx, actor: Actor, input: PersonInput, id?: string) {
  assertCan(actor, "people.write");
  if (!input.fullName.trim()) throw new ValidationError("Name is required.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    throw new ValidationError(`Unknown time zone "${input.timeZone}".`, { timeZone: "Use an IANA name such as Europe/London" });
  }
  const cap = Number(input.weeklyCapacityHours);
  if (!(cap >= 0 && cap <= 80)) throw new ValidationError("Weekly capacity must be between 0 and 80 hours.");
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new ValidationError("End date is before start date.");
  if (id && input.managerId === id) throw new ValidationError("A person cannot manage themselves.");
  const values = {
    type: input.type,
    fullName: input.fullName.trim(),
    email: input.email?.trim().toLowerCase() || null,
    phone: input.phone || null,
    jobTitle: input.jobTitle || null,
    departmentId: input.departmentId || null,
    managerId: input.managerId || null,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    timeZone: input.timeZone,
    weeklyCapacityHours: toFixed4(input.weeklyCapacityHours),
    status: input.status,
    userId: input.userId || null,
    notes: input.notes || null,
  };
  if (values.userId) {
    const [linked] = await tx.select({ id: people.id }).from(people).where(and(eq(people.userId, values.userId), id ? ne(people.id, id) : undefined));
    if (linked) throw new ConflictError("That user is already linked to another person.");
  }
  if (id) {
    const [before] = await tx.select().from(people).where(eq(people.id, id)).for("update");
    if (!before) throw new NotFoundError("Person");
    const [row] = await tx.update(people).set(values).where(eq(people.id, id)).returning();
    await audit(tx, actor, { action: "person.updated", entityType: "person", entityId: id, summary: `Updated ${row.fullName}`, changes: diff(before, row) });
    return row;
  }
  const [row] = await tx.insert(people).values(values).returning();
  await audit(tx, actor, { action: "person.created", entityType: "person", entityId: row.id, summary: `Added ${row.fullName} (${row.type})` });
  return row;
}

const DEFAULT_CHECKLISTS: Record<"onboarding" | "offboarding", string[]> = {
  onboarding: ["Signed agreement on file", "Accounts created and roles assigned", "Equipment issued", "Cost rate recorded", "Introduced to active engagements", "Time tracking walkthrough"],
  offboarding: ["Final timesheet approved", "Engagement responsibilities reassigned", "Access removed (user deactivated)", "Equipment returned", "Final expenses reimbursed", "Knowledge handover documented"],
};

export async function startChecklist(tx: Tx, actor: Actor, personId: string, kind: "onboarding" | "offboarding") {
  assertCan(actor, "people.write");
  const [p] = await tx.select().from(people).where(eq(people.id, personId));
  if (!p) throw new NotFoundError("Person");
  const open = await tx.select().from(personChecklists).where(and(eq(personChecklists.personId, personId), eq(personChecklists.kind, kind)));
  if (open.some((c) => !c.completedAt)) throw new ConflictError(`An ${kind} checklist is already open.`);
  const [cl] = await tx.insert(personChecklists).values({ personId, kind, title: `${kind === "onboarding" ? "Onboarding" : "Offboarding"} — ${p.fullName}` }).returning();
  await tx.insert(checklistItems).values(DEFAULT_CHECKLISTS[kind].map((label, i) => ({ parentType: "person_checklist" as const, parentId: cl.id, label, sortOrder: String(i) })));
  if (kind === "offboarding" && p.status === "active") await tx.update(people).set({ status: "offboarding" }).where(eq(people.id, personId));
  await audit(tx, actor, { action: `person.${kind}_started`, entityType: "person", entityId: personId, summary: cl.title });
  return cl;
}

export async function completeChecklistIfDone(tx: Tx, checklistId: string) {
  const items = await tx.select().from(checklistItems).where(and(eq(checklistItems.parentType, "person_checklist"), eq(checklistItems.parentId, checklistId)));
  const done = items.length > 0 && items.every((i) => i.done);
  await tx.update(personChecklists).set({ completedAt: done ? new Date() : null }).where(eq(personChecklists.id, checklistId));
  return done;
}

/** Working days (Mon–Fri) in an inclusive range, used to estimate leave hours. */
export function workingDays(from: string, to: string) {
  let n = 0;
  const start = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i <= daysBetween(from, to); i++) {
    const dow = new Date(start.getTime() + i * 86400000).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

export async function requestLeave(tx: Tx, actor: Actor, input: { personId: string; leaveType: "annual" | "sick" | "unpaid" | "parental" | "other"; startDate: string; endDate: string; reason?: string | null }) {
  const [p] = await tx.select().from(people).where(eq(people.id, input.personId));
  if (!p) throw new NotFoundError("Person");
  const self = p.userId === actor.userId;
  if (!self && !can(actor, "people.write")) throw new ForbiddenError("You can only request leave for yourself.");
  if (input.endDate < input.startDate) throw new ValidationError("End date is before start date.");
  const overlap = await tx.select({ id: leaveRequests.id }).from(leaveRequests).where(and(eq(leaveRequests.personId, input.personId), inArray(leaveRequests.status, ["requested", "approved"]), lte(leaveRequests.startDate, input.endDate), gte(leaveRequests.endDate, input.startDate))).limit(1);
  if (overlap.length) throw new ConflictError("This overlaps another leave request.");
  const days = workingDays(input.startDate, input.endDate);
  const hours = (Number(p.weeklyCapacityHours) / 5) * days;
  const [row] = await tx.insert(leaveRequests).values({ ...input, reason: input.reason || null, hours: toFixed4(hours), status: "requested" }).returning();
  await audit(tx, actor, { action: "leave.requested", entityType: "leave_request", entityId: row.id, summary: `${p.fullName}: ${input.leaveType} ${input.startDate}–${input.endDate} (${days} working days)` });
  if (p.managerId) {
    const [m] = await tx.select({ userId: people.userId }).from(people).where(eq(people.id, p.managerId));
    if (m?.userId) await notify(tx, { userId: m.userId, kind: "approval", title: `Leave request from ${p.fullName}`, body: `${input.startDate} → ${input.endDate}`, href: "/people/leave" });
  }
  return row;
}

export async function decideLeave(tx: Tx, actor: Actor, id: string, decision: "approved" | "rejected" | "cancelled", note?: string | null) {
  const [l] = await tx.select({ l: leaveRequests, userId: people.userId, name: people.fullName }).from(leaveRequests).innerJoin(people, eq(people.id, leaveRequests.personId)).where(eq(leaveRequests.id, id)).for("update");
  if (!l) throw new NotFoundError("Leave request");
  const self = l.userId === actor.userId;
  if (decision === "cancelled") {
    if (!self && !can(actor, "people.write")) throw new ForbiddenError();
    if (!["requested", "approved"].includes(l.l.status)) throw new ValidationError("Only open or approved requests can be cancelled.");
  } else {
    assertCan(actor, "people.write");
    if (self) throw new ForbiddenError("You cannot approve or reject your own leave.");
    if (l.l.status !== "requested") throw new ValidationError("This request has already been decided.");
    if (decision === "rejected" && !note?.trim()) throw new ValidationError("Give a reason for rejecting.", { note: "Required" });
  }
  await tx.update(leaveRequests).set({ status: decision, approverId: decision === "cancelled" ? l.l.approverId : actor.userId, decidedAt: new Date(), decisionNote: note || null }).where(eq(leaveRequests.id, id));
  await audit(tx, actor, { action: `leave.${decision}`, entityType: "leave_request", entityId: id, summary: `${l.name}: ${l.l.startDate}–${l.l.endDate} ${decision}` });
  if (l.userId && !self) await notify(tx, { userId: l.userId, kind: "info", title: `Leave ${decision}`, body: `${l.l.startDate} → ${l.l.endDate}${note ? ` — ${note}` : ""}`, href: "/people/leave" });
}

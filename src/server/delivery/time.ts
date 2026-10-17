import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { costRates, engagements, people, timeEntries } from "@/db/schema";
import { d, toFixed4, toMoney } from "@/lib/money";
import { assertCan, can, canAll, type Actor } from "../auth/actor";
import { assertEngagementAccess } from "../auth/scope";
import { audit } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";

/** Cost rate in force for a person on a given date (historical; effective-dated). */
export async function costRateOn(tx: Tx, personId: string, onDate: string) {
  const [r] = await tx
    .select()
    .from(costRates)
    .where(and(eq(costRates.personId, personId), lte(costRates.effectiveFrom, onDate)))
    .orderBy(desc(costRates.effectiveFrom))
    .limit(1);
  return r ?? null;
}

export async function setCostRate(tx: Tx, actor: Actor, personId: string, input: { effectiveFrom: string; hourlyCost: string; currency: string; note?: string | null }) {
  assertCan(actor, "costrates.write");
  if (d(input.hourlyCost).isNegative()) throw new ValidationError("Cost rate cannot be negative.");
  const [row] = await tx
    .insert(costRates)
    .values({ personId, effectiveFrom: input.effectiveFrom, hourlyCost: toMoney(input.hourlyCost), currency: input.currency.toUpperCase(), note: input.note || null, createdBy: actor.userId || null })
    .onConflictDoUpdate({ target: [costRates.personId, costRates.effectiveFrom], set: { hourlyCost: toMoney(input.hourlyCost), currency: input.currency.toUpperCase(), note: input.note || null } })
    .returning();
  // Never log the amount itself in the general audit summary.
  await audit(tx, actor, { action: "costrate.set", entityType: "person", entityId: personId, summary: `Cost rate effective ${input.effectiveFrom} updated` });
  return row;
}

export type TimeEntryInput = {
  personId?: string | null;
  workDate: string;
  hours: string;
  engagementId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  description?: string | null;
  billable?: boolean;
};

export async function logTime(tx: Tx, actor: Actor, input: TimeEntryInput) {
  assertCan(actor, "time.write");
  const personId = input.personId || actor.personId;
  if (!personId) throw new ValidationError("Your user is not linked to a person record; ask an administrator.");
  if (personId !== actor.personId && !canAll(actor, "time.approve")) throw new ForbiddenError("You can only log your own time.");
  const hours = d(input.hours);
  if (hours.lessThanOrEqualTo(0) || hours.greaterThan(24)) throw new ValidationError("Hours must be between 0 and 24.", { hours: "Invalid" });
  if (input.engagementId) await assertEngagementAccess(tx, actor, input.engagementId, "delivery.read");
  const [row] = await tx
    .insert(timeEntries)
    .values({
      personId,
      userId: actor.userId || null,
      workDate: input.workDate,
      hours: toFixed4(hours),
      engagementId: input.engagementId || null,
      taskId: input.taskId || null,
      projectId: input.projectId || null,
      description: input.description || null,
      billable: input.billable ?? true,
      status: "submitted",
    })
    .returning();
  await audit(tx, actor, { action: "time.logged", entityType: "time_entry", entityId: row.id, summary: `${row.hours}h on ${row.workDate}` });
  return row;
}

export async function updateTimeEntry(tx: Tx, actor: Actor, id: string, input: TimeEntryInput) {
  const [e] = await tx.select().from(timeEntries).where(eq(timeEntries.id, id)).for("update");
  if (!e) throw new NotFoundError("Time entry");
  if (e.status === "approved") throw new ValidationError("Approved time cannot be edited. Ask an approver to reject it first.");
  if (e.personId !== actor.personId && !canAll(actor, "time.approve")) throw new ForbiddenError();
  await tx
    .update(timeEntries)
    .set({ workDate: input.workDate, hours: toFixed4(input.hours), description: input.description || null, billable: input.billable ?? e.billable, engagementId: input.engagementId || null, taskId: input.taskId || null, status: "submitted" })
    .where(eq(timeEntries.id, id));
  await audit(tx, actor, { action: "time.updated", entityType: "time_entry", entityId: id, summary: `Time entry updated` });
}

/** Time you entered, or time recorded against your own person record (even if someone else entered it). */
function ownEntry(actor: Actor, e: { userId: string | null; personId: string }) {
  return (!!e.userId && e.userId === actor.userId) || (!!actor.personId && e.personId === actor.personId);
}

/**
 * Approve time. The cost rate in force on the work date is snapshotted so
 * later rate changes never alter historical profitability.
 */
export async function approveTimeEntries(tx: Tx, actor: Actor, ids: string[]) {
  assertCan(actor, "time.approve");
  const rows = await tx.select().from(timeEntries).where(inArray(timeEntries.id, ids)).for("update");
  let approved = 0;
  const missingRate: string[] = [];
  for (const e of rows) {
    if (e.status === "approved") continue;
    if (ownEntry(actor, e)) throw new ForbiddenError("You cannot approve your own time.");
    if (e.engagementId && !canAll(actor, "time.approve")) await assertEngagementAccess(tx, actor, e.engagementId, "time.approve");
    const rate = await costRateOn(tx, e.personId, e.workDate);
    if (!rate) missingRate.push(e.id);
    let billRate: string | null = null;
    if (e.engagementId) {
      const [eng] = await tx.select({ hourlyRate: engagements.hourlyRate }).from(engagements).where(eq(engagements.id, e.engagementId));
      billRate = e.billable ? eng?.hourlyRate ?? null : null;
    }
    await tx
      .update(timeEntries)
      .set({
        status: "approved",
        approvedBy: actor.userId || null,
        approvedAt: new Date(),
        costRate: rate?.hourlyCost ?? null,
        costCurrency: rate?.currency ?? null,
        costAmount: rate ? toMoney(d(e.hours).times(d(rate.hourlyCost))) : null,
        billRate,
        rejectionReason: null,
      })
      .where(eq(timeEntries.id, e.id));
    approved++;
  }
  await audit(tx, actor, { action: "time.approved", entityType: "time_entry", summary: `Approved ${approved} time entries`, changes: { ids, missingCostRate: missingRate.length } });
  return { approved, missingRate };
}

export async function rejectTimeEntries(tx: Tx, actor: Actor, ids: string[], reason: string) {
  assertCan(actor, "time.approve");
  if (!reason.trim()) throw new ValidationError("Give a reason.");
  const existing = await tx.select().from(timeEntries).where(inArray(timeEntries.id, ids)).for("update");
  for (const e of existing) {
    if (ownEntry(actor, e)) throw new ForbiddenError("You cannot review your own time.");
    if (e.status === "approved" && !canAll(actor, "time.approve")) throw new ForbiddenError("Only full approvers can reopen approved time.");
    if (e.engagementId && !canAll(actor, "time.approve")) await assertEngagementAccess(tx, actor, e.engagementId, "time.approve");
  }
  const rows = await tx
    .update(timeEntries)
    .set({ status: "rejected", rejectionReason: reason, approvedBy: null, approvedAt: null, costRate: null, costAmount: null, costCurrency: null })
    .where(inArray(timeEntries.id, ids))
    .returning({ id: timeEntries.id });
  await audit(tx, actor, { action: "time.rejected", entityType: "time_entry", summary: `Rejected ${rows.length} time entries: ${reason}` });
  return rows.length;
}

export async function personForUser(tx: Tx, userId: string) {
  const [p] = await tx.select().from(people).where(eq(people.userId, userId));
  return p ?? null;
}

export function canSeeCost(actor: Actor) {
  return can(actor, "costrates.read");
}

"use server";

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { f } from "@/lib/formdata";
import { checklistItems, personChecklists } from "@/db/schema";
import { runAction, type ActionState } from "./run";
import { completeChecklistIfDone, decideLeave, requestLeave, savePerson, startChecklist } from "../people/people";
import { setCostRate } from "../delivery/time";
import { assertCan } from "../auth/actor";
import { audit } from "../audit";
import { NotFoundError } from "../errors";

const personSchema = z.object({
  type: f.enumOf(["employee", "contractor"] as const),
  fullName: f.str(200),
  email: f.optStr(300),
  phone: f.optStr(100),
  jobTitle: f.optStr(200),
  departmentId: f.optId(),
  managerId: f.optId(),
  startDate: f.optDate(),
  endDate: f.optDate(),
  timeZone: f.str(64),
  weeklyCapacityHours: f.decimal(),
  status: f.enumOf(["active", "onboarding", "offboarding", "inactive"] as const),
  userId: f.userId(),
  notes: f.text(),
});

export async function savePersonAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "people.write", action: "person.save", schema: personSchema.extend({ id: f.optId() }), run: async ({ actor, tx, data }) => {
    const { id, ...input } = data;
    const p = await savePerson(tx, actor, input, id ?? undefined);
    return { ref: p.id, redirectTo: `/people/${p.id}` };
  } });
}

export async function costRateAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "costrates.write", action: "cost_rate.set", schema: z.object({ personId: f.id(), effectiveFrom: f.date(), hourlyCost: f.money(), currency: f.currency(), note: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    await setCostRate(tx, actor, data.personId, data);
    return "Cost rate recorded. It applies to time worked from that date; earlier entries keep their snapshot.";
  } });
}

export async function checklistAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "people.write", action: "person.checklist", schema: z.object({ personId: f.optId(), kind: f.enumOf(["onboarding", "offboarding"] as const).optional(), itemId: f.optId(), done: f.bool().optional() }), run: async ({ actor, tx, data }) => {
    if (data.itemId) {
      assertCan(actor, "people.write");
      const [item] = await tx.select().from(checklistItems).where(and(eq(checklistItems.id, data.itemId), eq(checklistItems.parentType, "person_checklist")));
      if (!item) throw new NotFoundError("Checklist item");
      const done = data.done ?? !item.done;
      await tx.update(checklistItems).set({ done, doneAt: done ? new Date() : null, doneBy: done ? actor.userId : null }).where(eq(checklistItems.id, item.id));
      const complete = await completeChecklistIfDone(tx, item.parentId);
      const [cl] = await tx.select().from(personChecklists).where(eq(personChecklists.id, item.parentId));
      await audit(tx, actor, { action: "person.checklist_item", entityType: "person", entityId: cl.personId, summary: `${done ? "Done" : "Reopened"}: ${item.label}` });
      return complete ? "Checklist complete." : "Updated.";
    }
    if (!data.personId || !data.kind) throw new NotFoundError("Person");
    await startChecklist(tx, actor, data.personId, data.kind);
    return `${data.kind === "onboarding" ? "Onboarding" : "Offboarding"} checklist started.`;
  } });
}

export async function requestLeaveAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { schema: z.object({ personId: f.id(), leaveType: f.enumOf(["annual", "sick", "unpaid", "parental", "other"] as const), startDate: f.date(), endDate: f.date(), reason: f.optStr(1000) }), action: "leave.request", run: async ({ actor, tx, data }) => {
    await requestLeave(tx, actor, data);
    return "Leave requested. Your manager has been notified in the app.";
  } });
}

export async function decideLeaveAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { schema: z.object({ id: f.id(), decision: f.enumOf(["approved", "rejected", "cancelled"] as const), note: f.optStr(1000) }), action: "leave.decide", run: async ({ actor, tx, data }) => {
    await decideLeave(tx, actor, data.id, data.decision, data.note);
    return `Leave ${data.decision}.`;
  } });
}

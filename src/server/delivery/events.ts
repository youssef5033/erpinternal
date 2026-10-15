import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { eventAttendees, events, opportunities, pipelineStages } from "@/db/schema";
import { can, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { logActivity } from "../crm/activities";
import { moveOpportunityStage } from "../crm/opportunities";
import { createTask } from "./tasks";

export type EventInput = {
  kind: "meeting" | "call" | "discovery" | "account_review" | "internal" | "workshop";
  title: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  location?: string | null;
  agenda?: string | null;
  organizerId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  opportunityId?: string | null;
  engagementId?: string | null;
  reminderMinutes?: number | null;
  attendeeUserIds?: string[];
  attendeeContactIds?: string[];
};

function validate(input: EventInput) {
  if (!input.title.trim()) throw new ValidationError("Title is required.");
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) throw new ValidationError("Start time is invalid.");
  if (input.endsAt <= input.startsAt) throw new ValidationError("End time must be after the start time.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
  } catch {
    throw new ValidationError(`Unknown time zone "${input.timeZone}".`);
  }
}

/** Book a meeting/call. Discovery calls advance the opportunity to "Discovery scheduled". */
export async function scheduleEvent(tx: Tx, actor: Actor, input: EventInput) {
  if (!can(actor, "crm.write") && !can(actor, "delivery.write")) throw new ForbiddenError();
  validate(input);
  const [ev] = await tx
    .insert(events)
    .values({
      kind: input.kind,
      title: input.title.trim(),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      timeZone: input.timeZone,
      location: input.location || null,
      agenda: input.agenda || null,
      organizerId: input.organizerId || actor.userId || null,
      accountId: input.accountId || null,
      contactId: input.contactId || null,
      leadId: input.leadId || null,
      opportunityId: input.opportunityId || null,
      engagementId: input.engagementId || null,
      reminderMinutes: input.reminderMinutes ?? 15,
    })
    .returning();
  const attendees = [
    ...(input.attendeeUserIds ?? []).map((userId) => ({ eventId: ev.id, userId })),
    ...(input.attendeeContactIds ?? []).map((contactId) => ({ eventId: ev.id, contactId })),
  ];
  if (attendees.length) await tx.insert(eventAttendees).values(attendees);
  if (input.kind === "discovery" && input.opportunityId) await advanceTo(tx, actor, input.opportunityId, "discovery_scheduled");
  await logActivity(tx, actor, {
    type: "meeting",
    direction: "internal",
    subject: `${input.kind === "discovery" ? "Discovery call" : input.kind === "call" ? "Call" : "Meeting"} booked: ${ev.title}`,
    body: input.agenda ?? null,
    occurredAt: new Date(),
    accountId: ev.accountId,
    contactId: ev.contactId,
    leadId: ev.leadId,
    opportunityId: ev.opportunityId,
    engagementId: ev.engagementId,
    relatedType: "event",
    relatedId: ev.id,
  });
  await audit(tx, actor, { action: "event.scheduled", entityType: "event", entityId: ev.id, summary: `Scheduled ${ev.kind}: ${ev.title}` });
  return ev;
}

export async function updateEvent(tx: Tx, actor: Actor, id: string, input: EventInput) {
  validate(input);
  const [ev] = await tx.select().from(events).where(eq(events.id, id));
  if (!ev) throw new NotFoundError("Event");
  await tx
    .update(events)
    .set({ title: input.title, startsAt: input.startsAt, endsAt: input.endsAt, timeZone: input.timeZone, location: input.location || null, agenda: input.agenda || null, reminderMinutes: input.reminderMinutes ?? ev.reminderMinutes })
    .where(eq(events.id, id));
  await audit(tx, actor, { action: "event.updated", entityType: "event", entityId: id, summary: `Updated ${ev.title}` });
}

/** Record notes, decisions and outcome; create follow-up tasks with owners and deadlines. */
export async function completeEvent(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { status: "completed" | "cancelled" | "no_show"; notes?: string | null; decisions?: string | null; outcome?: string | null; followUps?: { title: string; ownerId?: string | null; dueDate?: string | null }[] },
) {
  const [ev] = await tx.select().from(events).where(eq(events.id, id)).for("update");
  if (!ev) throw new NotFoundError("Event");
  await tx.update(events).set({ status: input.status, notes: input.notes || null, decisions: input.decisions || null, outcome: input.outcome || null }).where(eq(events.id, id));
  const activity = await logActivity(tx, actor, {
    type: ev.kind === "call" ? "call" : "meeting",
    direction: "internal",
    subject: `${ev.title} — ${input.status.replace("_", " ")}`,
    body: [input.notes && `Notes: ${input.notes}`, input.decisions && `Decisions: ${input.decisions}`].filter(Boolean).join("\n\n") || null,
    outcome: input.outcome ?? input.status,
    occurredAt: ev.startsAt,
    accountId: ev.accountId,
    contactId: ev.contactId,
    leadId: ev.leadId,
    opportunityId: ev.opportunityId,
    engagementId: ev.engagementId,
    relatedType: "event",
    relatedId: ev.id,
  });
  await tx.update(events).set({ activityId: activity.id }).where(eq(events.id, id));
  for (const f of input.followUps ?? []) {
    if (!f.title.trim()) continue;
    await createTask(tx, actor, {
      title: f.title,
      kind: "follow_up",
      ownerId: f.ownerId || actor.userId,
      dueDate: f.dueDate || null,
      accountId: ev.accountId,
      contactId: ev.contactId,
      leadId: ev.leadId,
      opportunityId: ev.opportunityId,
      engagementId: ev.engagementId,
      eventId: ev.id,
    });
  }
  if (input.status === "completed" && ev.kind === "discovery" && ev.opportunityId) await advanceTo(tx, actor, ev.opportunityId, "discovery_completed");
  await audit(tx, actor, { action: "event.completed", entityType: "event", entityId: id, summary: `${ev.title}: ${input.status}` });
}

async function advanceTo(tx: Tx, actor: Actor, opportunityId: string, key: string) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp || opp.status !== "open") return;
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, opp.pipelineId));
  const target = stages.find((s) => s.key === key);
  const current = stages.find((s) => s.id === opp.stageId);
  if (target && current && target.sortOrder > current.sortOrder) await moveOpportunityStage(tx, actor, opportunityId, target.id, "Advanced by meeting workflow");
}

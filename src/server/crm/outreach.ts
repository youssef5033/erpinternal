import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  contacts,
  integrations,
  leadContacts,
  leads,
  outreachMessages,
  outreachTemplates,
  sequenceEnrollments,
  sequenceSteps,
  sequences,
  services,
  suppressions,
  user,
} from "@/db/schema";
import { addDaysISO } from "@/lib/dates";
import { normalizeDomain, normalizeEmail } from "@/lib/normalize";
import { assertCan, type Actor } from "../auth/actor";
import { assertCrmWrite } from "../auth/scope";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { agencyToday } from "../system/settings";
import { logActivity } from "./activities";

/* ------------------------------------------------------------------ */
/* Suppression                                                         */
/* ------------------------------------------------------------------ */

export type Recipient = { contactId?: string | null; leadContactId?: string | null; email?: string | null };

/** Is outreach to this recipient suppressed on this channel? Returns the reason or null. */
export async function suppressionFor(tx: Tx, r: Recipient, channel = "all"): Promise<string | null> {
  const email = normalizeEmail(r.email);
  const domain = email ? normalizeDomain(email) : null;
  const conds = [
    r.contactId ? eq(suppressions.contactId, r.contactId) : undefined,
    r.leadContactId ? eq(suppressions.leadContactId, r.leadContactId) : undefined,
    email ? eq(suppressions.normalizedEmail, email) : undefined,
    domain ? eq(suppressions.domain, domain) : undefined,
  ].filter(Boolean);
  if (r.contactId) {
    const [c] = await tx.select({ dnc: contacts.doNotContact }).from(contacts).where(eq(contacts.id, r.contactId));
    if (c?.dnc) return "Contact is marked do-not-contact";
  }
  if (!conds.length) return null;
  const [s] = await tx
    .select()
    .from(suppressions)
    .where(and(isNull(suppressions.liftedAt), or(...conds), or(eq(suppressions.channel, "all"), eq(suppressions.channel, channel))))
    .limit(1);
  return s ? `Suppressed (${s.reason.replace("_", " ")}${s.note ? `: ${s.note}` : ""})` : null;
}

/**
 * Record an opt-out: marks the contact do-not-contact, adds a suppression
 * record (by contact AND email), stops every active sequence enrollment and
 * cancels unsent drafts. Future outreach is blocked by `suppressionFor`.
 */
export async function recordOptOut(tx: Tx, actor: Actor, r: Recipient & { reason?: "opt_out" | "bounce" | "complaint" | "manual" | "legal"; note?: string | null; channel?: string; source?: "manual" | "reply" | "import" | "integration" }) {
  let email = normalizeEmail(r.email);
  let contactId = r.contactId ?? null;
  let accountId: string | null = null;
  let leadId: string | null = null;
  if (contactId) {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!c) throw new NotFoundError("Contact");
    email = email ?? c.normalizedEmail;
    accountId = c.primaryAccountId;
    await tx.update(contacts).set({ doNotContact: true, optedOutAt: new Date() }).where(eq(contacts.id, contactId));
  }
  if (r.leadContactId) {
    const [lc] = await tx.select().from(leadContacts).where(eq(leadContacts.id, r.leadContactId));
    if (lc) {
      email = email ?? lc.normalizedEmail;
      leadId = lc.leadId;
      contactId = contactId ?? lc.convertedContactId;
    }
  }
  if (!contactId && !email && !r.leadContactId) throw new ValidationError("An opt-out needs a contact or an email address.");
  const [sup] = await tx
    .insert(suppressions)
    .values({
      contactId,
      leadContactId: r.leadContactId ?? null,
      normalizedEmail: email,
      channel: r.channel ?? "all",
      reason: r.reason ?? "opt_out",
      note: r.note || null,
      source: r.source ?? "manual",
      createdBy: actor.userId || null,
    })
    .returning();
  const stopped = await stopEnrollmentsFor(tx, actor, { contactId, leadContactId: r.leadContactId ?? null, email }, "opted_out");
  await logActivity(tx, actor, {
    type: "system",
    subject: `Opted out of outreach (${sup.channel})`,
    body: r.note ?? null,
    contactId,
    accountId,
    leadId,
    source: "system",
  });
  await audit(tx, actor, { action: "outreach.opt_out", entityType: contactId ? "contact" : "suppression", entityId: contactId ?? sup.id, summary: `Opt-out recorded; ${stopped} sequence(s) stopped`, changes: { channel: sup.channel, reason: sup.reason } });
  return { suppression: sup, stoppedEnrollments: stopped };
}

export async function liftSuppression(tx: Tx, actor: Actor, suppressionId: string, note: string) {
  assertCan(actor, "outreach.send");
  if (!note.trim()) throw new ValidationError("Explain why the suppression is lifted (e.g. written consent).");
  const [s] = await tx.update(suppressions).set({ liftedAt: new Date(), liftedBy: actor.userId || null }).where(eq(suppressions.id, suppressionId)).returning();
  if (!s) throw new NotFoundError("Suppression");
  if (s.contactId) await tx.update(contacts).set({ doNotContact: false }).where(eq(contacts.id, s.contactId));
  await audit(tx, actor, { action: "outreach.suppression_lifted", entityType: "suppression", entityId: s.id, summary: `Suppression lifted: ${note}` });
}

async function stopEnrollmentsFor(tx: Tx, actor: Actor, r: { contactId: string | null; leadContactId: string | null; email: string | null }, reason: "opted_out" | "replied" | "bounced" | "manual" | "suppressed") {
  const leadContactIds = r.email ? (await tx.select({ id: leadContacts.id }).from(leadContacts).where(eq(leadContacts.normalizedEmail, r.email))).map((x) => x.id) : [];
  if (r.leadContactId) leadContactIds.push(r.leadContactId);
  const contactIds = r.email ? (await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.normalizedEmail, r.email))).map((x) => x.id) : [];
  if (r.contactId) contactIds.push(r.contactId);
  const conds = [contactIds.length ? inArray(sequenceEnrollments.contactId, contactIds) : undefined, leadContactIds.length ? inArray(sequenceEnrollments.leadContactId, leadContactIds) : undefined].filter(Boolean);
  if (!conds.length) return 0;
  const stopped = await tx
    .update(sequenceEnrollments)
    .set({ status: "stopped", stoppedReason: reason, stoppedAt: new Date(), nextDueAt: null })
    .where(and(inArray(sequenceEnrollments.status, ["active", "paused"]), or(...conds)))
    .returning({ id: sequenceEnrollments.id });
  if (stopped.length) {
    await tx
      .update(outreachMessages)
      .set({ status: "cancelled", blockedReason: `Sequence stopped: ${reason.replace("_", " ")}` })
      .where(and(inArray(outreachMessages.enrollmentId, stopped.map((s) => s.id)), inArray(outreachMessages.status, ["draft", "approved"])));
    void actor;
  }
  return stopped.length;
}

/* ------------------------------------------------------------------ */
/* Templates & sequences                                               */
/* ------------------------------------------------------------------ */

export async function saveTemplate(tx: Tx, actor: Actor, input: { id?: string; name: string; serviceId?: string | null; segment?: string | null; channel: string; subject?: string | null; body: string; active?: boolean }) {
  assertCrmWrite(actor, null);
  if (!input.name.trim() || !input.body.trim()) throw new ValidationError("Name and body are required.");
  const values = { name: input.name.trim(), serviceId: input.serviceId || null, segment: input.segment || null, channel: input.channel, subject: input.subject || null, body: input.body, active: input.active ?? true };
  const [row] = input.id
    ? await tx.update(outreachTemplates).set(values).where(eq(outreachTemplates.id, input.id)).returning()
    : await tx.insert(outreachTemplates).values({ ...values, createdBy: actor.userId || null }).returning();
  await audit(tx, actor, { action: input.id ? "outreach.template_updated" : "outreach.template_created", entityType: "outreach_template", entityId: row.id, summary: `Template ${row.name}` });
  return row;
}

export async function saveSequence(tx: Tx, actor: Actor, input: { id?: string; name: string; serviceId?: string | null; segment?: string | null; description?: string | null; steps: { dayOffset: number; channel: string; templateId?: string | null; instructions?: string | null }[] }) {
  assertCrmWrite(actor, null);
  if (!input.name.trim()) throw new ValidationError("Name is required.");
  if (!input.steps.length) throw new ValidationError("Add at least one step.");
  const values = { name: input.name.trim(), serviceId: input.serviceId || null, segment: input.segment || null, description: input.description || null };
  let seqId = input.id;
  if (seqId) {
    const [{ n }] = await tx.select({ n: sql<number>`count(*)` }).from(sequenceEnrollments).where(eq(sequenceEnrollments.sequenceId, seqId));
    if (Number(n) > 0) throw new ValidationError("This sequence has enrollments; create a new sequence instead of changing its steps.");
    await tx.update(sequences).set(values).where(eq(sequences.id, seqId));
    await tx.delete(sequenceSteps).where(eq(sequenceSteps.sequenceId, seqId));
  } else {
    const [row] = await tx.insert(sequences).values({ ...values, ownerId: actor.userId || null }).returning();
    seqId = row.id;
  }
  await tx.insert(sequenceSteps).values(input.steps.map((s, i) => ({ sequenceId: seqId!, stepNumber: i + 1, dayOffset: s.dayOffset, channel: s.channel, templateId: s.templateId || null, instructions: s.instructions || null })));
  await audit(tx, actor, { action: "outreach.sequence_saved", entityType: "sequence", entityId: seqId, summary: `Sequence ${input.name} (${input.steps.length} steps)` });
  return seqId!;
}

export async function setSequenceStatus(tx: Tx, actor: Actor, sequenceId: string, status: "active" | "paused" | "archived") {
  assertCrmWrite(actor, null);
  await tx.update(sequences).set({ status }).where(eq(sequences.id, sequenceId));
  if (status !== "active") {
    await tx.update(sequenceEnrollments).set({ status: "paused" }).where(and(eq(sequenceEnrollments.sequenceId, sequenceId), eq(sequenceEnrollments.status, "active")));
  }
  await audit(tx, actor, { action: `outreach.sequence_${status}`, entityType: "sequence", entityId: sequenceId, summary: `Sequence ${status}` });
}

/* ------------------------------------------------------------------ */
/* Enrollment & drafts                                                 */
/* ------------------------------------------------------------------ */

export async function enroll(tx: Tx, actor: Actor, sequenceId: string, r: { contactId?: string | null; leadContactId?: string | null }) {
  assertCrmWrite(actor, null);
  const [seq] = await tx.select().from(sequences).where(eq(sequences.id, sequenceId));
  if (!seq) throw new NotFoundError("Sequence");
  if (seq.status !== "active") throw new ValidationError("This sequence is not active.");
  let email: string | null = null;
  let leadId: string | null = null;
  if (r.contactId) {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, r.contactId));
    if (!c) throw new NotFoundError("Contact");
    email = c.normalizedEmail;
  } else if (r.leadContactId) {
    const [lc] = await tx.select().from(leadContacts).where(eq(leadContacts.id, r.leadContactId));
    if (!lc) throw new NotFoundError("Lead contact");
    email = lc.normalizedEmail;
    leadId = lc.leadId;
  } else throw new ValidationError("Choose who to enroll.");
  const blocked = await suppressionFor(tx, { contactId: r.contactId, leadContactId: r.leadContactId, email });
  if (blocked) throw new ValidationError(`Cannot enroll: ${blocked}.`);
  const today = await agencyToday(tx);
  const [first] = await tx.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, sequenceId)).orderBy(asc(sequenceSteps.stepNumber)).limit(1);
  const inserted = await tx
    .insert(sequenceEnrollments)
    .values({
      sequenceId,
      contactId: r.contactId ?? null,
      leadContactId: r.leadContactId ?? null,
      leadId,
      status: "active",
      currentStep: 1,
      nextDueAt: new Date(`${addDaysISO(today, first?.dayOffset ?? 0)}T09:00:00Z`),
      enrolledBy: actor.userId || null,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) throw new ConflictError("Already enrolled in this sequence.");
  await audit(tx, actor, { action: "outreach.enrolled", entityType: "sequence", entityId: sequenceId, summary: `Enrolled recipient in ${seq.name}` });
  return inserted[0];
}

export async function setEnrollmentStatus(tx: Tx, actor: Actor, enrollmentId: string, status: "active" | "paused" | "stopped") {
  assertCrmWrite(actor, null);
  const [e] = await tx.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enrollmentId)).for("update");
  if (!e) throw new NotFoundError("Enrollment");
  if (e.status === "stopped" || e.status === "completed") throw new ValidationError("This enrollment has ended.");
  await tx
    .update(sequenceEnrollments)
    .set({ status, stoppedReason: status === "stopped" ? "manual" : null, stoppedAt: status === "stopped" ? new Date() : null })
    .where(eq(sequenceEnrollments.id, enrollmentId));
  if (status === "stopped") {
    await tx.update(outreachMessages).set({ status: "cancelled", blockedReason: "Sequence stopped manually" }).where(and(eq(outreachMessages.enrollmentId, enrollmentId), inArray(outreachMessages.status, ["draft", "approved"])));
  }
  await audit(tx, actor, { action: `outreach.enrollment_${status}`, entityType: "enrollment", entityId: enrollmentId, summary: `Enrollment ${status}` });
}

/** Render a template. Missing data is shown as [missing: field] — never invented. */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => {
    const v = vars[key.toLowerCase()];
    return v && v.trim() ? v : `[missing: ${key}]`;
  });
}

async function recipientVars(tx: Tx, e: typeof sequenceEnrollments.$inferSelect, senderId: string | null) {
  let firstName: string | null = null;
  let fullName: string | null = null;
  let company: string | null = null;
  let email: string | null = null;
  let contactId: string | null = e.contactId;
  if (e.contactId) {
    const [c] = await tx.select({ c: contacts, a: accounts }).from(contacts).leftJoin(accounts, eq(accounts.id, contacts.primaryAccountId)).where(eq(contacts.id, e.contactId));
    firstName = c?.c.firstName ?? null;
    fullName = c?.c.fullName ?? null;
    email = c?.c.email ?? null;
    company = c?.a?.name ?? null;
  } else if (e.leadContactId) {
    const [lc] = await tx.select({ lc: leadContacts, l: leads }).from(leadContacts).innerJoin(leads, eq(leads.id, leadContacts.leadId)).where(eq(leadContacts.id, e.leadContactId));
    fullName = lc?.lc.fullName ?? null;
    firstName = fullName?.split(" ")[0] ?? null;
    email = lc?.lc.email ?? null;
    company = lc?.l.companyName ?? null;
    contactId = lc?.lc.convertedContactId ?? null;
  }
  const [sender] = senderId ? await tx.select({ name: user.name }).from(user).where(eq(user.id, senderId)) : [];
  return { vars: { first_name: firstName, full_name: fullName, company, sender_name: sender?.name ?? null }, email, contactId };
}

/**
 * Create drafts for enrollment steps that are due. Idempotent: the dedupe key
 * `<enrollment>:<step>` means re-running never creates a second draft.
 * Suppressed recipients are stopped instead of drafted.
 */
export async function generateDueDrafts(tx: Tx, actor: Actor, now = new Date()) {
  const due = await tx
    .select({ e: sequenceEnrollments, seq: sequences })
    .from(sequenceEnrollments)
    .innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
    .where(and(eq(sequenceEnrollments.status, "active"), eq(sequences.status, "active"), lte(sequenceEnrollments.nextDueAt, now)));
  let created = 0;
  for (const { e, seq } of due) {
    const [step] = await tx.select().from(sequenceSteps).where(and(eq(sequenceSteps.sequenceId, e.sequenceId), eq(sequenceSteps.stepNumber, e.currentStep)));
    if (!step) {
      await tx.update(sequenceEnrollments).set({ status: "completed", nextDueAt: null }).where(eq(sequenceEnrollments.id, e.id));
      continue;
    }
    const { vars, email, contactId } = await recipientVars(tx, e, seq.ownerId);
    const blocked = await suppressionFor(tx, { contactId: e.contactId ?? contactId, leadContactId: e.leadContactId, email }, step.channel);
    if (blocked) {
      await tx.update(sequenceEnrollments).set({ status: "stopped", stoppedReason: "suppressed", stoppedAt: new Date(), nextDueAt: null }).where(eq(sequenceEnrollments.id, e.id));
      continue;
    }
    const [tpl] = step.templateId ? await tx.select().from(outreachTemplates).where(eq(outreachTemplates.id, step.templateId)) : [];
    const res = await tx
      .insert(outreachMessages)
      .values({
        enrollmentId: e.id,
        stepId: step.id,
        contactId: e.contactId,
        leadId: e.leadId,
        leadContactId: e.leadContactId,
        channel: step.channel,
        toAddress: step.channel === "email" ? email : null,
        subject: tpl?.subject ? renderTemplate(tpl.subject, vars) : null,
        body: tpl ? renderTemplate(tpl.body, vars) : step.instructions ?? `Step ${step.stepNumber}: ${step.channel} touch`,
        status: "draft",
        dedupeKey: `${e.id}:${step.stepNumber}`,
        createdBy: seq.ownerId,
      })
      .onConflictDoNothing()
      .returning({ id: outreachMessages.id });
    created += res.length;
    // Pause the clock until the draft is sent; next due is set on send.
    await tx.update(sequenceEnrollments).set({ nextDueAt: null }).where(eq(sequenceEnrollments.id, e.id));
  }
  void actor;
  return created;
}

export async function updateDraft(tx: Tx, actor: Actor, messageId: string, input: { subject?: string | null; body: string }) {
  assertCrmWrite(actor, null);
  const [m] = await tx.select().from(outreachMessages).where(eq(outreachMessages.id, messageId)).for("update");
  if (!m) throw new NotFoundError("Message");
  if (m.status !== "draft") throw new ValidationError("Only drafts can be edited.");
  await tx.update(outreachMessages).set({ subject: input.subject ?? m.subject, body: input.body }).where(eq(outreachMessages.id, messageId));
}

/** Is there a verified, authorised sending integration for the channel? */
export async function sendingIntegration(tx: Tx, channel: string) {
  if (channel !== "email") return null;
  const [i] = await tx.select().from(integrations).where(and(eq(integrations.kind, "email"), eq(integrations.status, "connected"), eq(integrations.sendingAuthorized, true))).limit(1);
  return i ?? null;
}

/**
 * Record that a person sent the message themselves (manual mode). Requires
 * outreach.send. Re-checks suppression at send time. The dedupe key and
 * status check prevent a message being recorded as sent twice.
 */
export async function markMessageSent(tx: Tx, actor: Actor, messageId: string, input: { sentAt?: Date; note?: string | null } = {}) {
  assertCan(actor, "outreach.send");
  const [m] = await tx.select().from(outreachMessages).where(eq(outreachMessages.id, messageId)).for("update");
  if (!m) throw new NotFoundError("Message");
  if (m.status === "sent" || m.status === "sent_manually") throw new ConflictError("This message is already recorded as sent.");
  if (m.status === "cancelled" || m.status === "blocked") throw new ValidationError(`This message is ${m.status}.`);
  const blocked = await suppressionFor(tx, { contactId: m.contactId, leadContactId: m.leadContactId, email: m.toAddress }, m.channel);
  if (blocked) {
    await tx.update(outreachMessages).set({ status: "blocked", blockedReason: blocked }).where(eq(outreachMessages.id, messageId));
    throw new ValidationError(`Not sent: ${blocked}.`);
  }
  const sentAt = input.sentAt ?? new Date();
  let accountId: string | null = null;
  if (m.contactId) accountId = (await tx.select({ a: contacts.primaryAccountId }).from(contacts).where(eq(contacts.id, m.contactId)))[0]?.a ?? null;
  const activity = await logActivity(tx, actor, {
    type: m.channel === "linkedin" ? "linkedin" : m.channel === "email" ? "email" : m.channel === "call" ? "call" : "message",
    direction: "outbound",
    channel: m.channel,
    subject: m.subject ?? `${m.channel} message`,
    body: m.body + (input.note ? `\n\n— ${input.note}` : ""),
    occurredAt: sentAt,
    source: "manual",
    contactId: m.contactId,
    leadId: m.leadId,
    accountId,
    enrollmentId: m.enrollmentId,
    relatedType: "outreach_message",
    relatedId: m.id,
  });
  await tx.update(outreachMessages).set({ status: "sent_manually", sentAt, approvedBy: actor.userId || null, approvedAt: new Date(), activityId: activity.id }).where(eq(outreachMessages.id, messageId));
  if (m.leadId) await tx.update(leads).set({ lastInteractionAt: sentAt }).where(eq(leads.id, m.leadId));
  if (m.enrollmentId) await advanceEnrollment(tx, m.enrollmentId);
  await audit(tx, actor, { action: "outreach.sent_manually", entityType: "outreach_message", entityId: m.id, summary: `Recorded manual ${m.channel} send` });
}

async function advanceEnrollment(tx: Tx, enrollmentId: string) {
  const [e] = await tx.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, enrollmentId)).for("update");
  if (!e || e.status !== "active") return;
  const steps = await tx.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId, e.sequenceId)).orderBy(asc(sequenceSteps.stepNumber));
  const current = steps.find((s) => s.stepNumber === e.currentStep);
  const next = steps.find((s) => s.stepNumber === e.currentStep + 1);
  if (!next) {
    await tx.update(sequenceEnrollments).set({ status: "completed", nextDueAt: null }).where(eq(sequenceEnrollments.id, enrollmentId));
    return;
  }
  const gap = next.dayOffset - (current?.dayOffset ?? 0);
  await tx
    .update(sequenceEnrollments)
    .set({ currentStep: next.stepNumber, nextDueAt: new Date(Date.now() + Math.max(gap, 0) * 86400000) })
    .where(eq(sequenceEnrollments.id, enrollmentId));
}

export async function cancelDraft(tx: Tx, actor: Actor, messageId: string) {
  assertCrmWrite(actor, null);
  await tx.update(outreachMessages).set({ status: "cancelled" }).where(and(eq(outreachMessages.id, messageId), inArray(outreachMessages.status, ["draft", "approved"])));
}

/**
 * Log an inbound reply manually (or from an integration). Replies stop the
 * recipient's active sequences. Positive replies can book a discovery call.
 */
export async function logReply(
  tx: Tx,
  actor: Actor,
  input: { contactId?: string | null; leadId?: string | null; leadContactId?: string | null; channel: string; subject?: string | null; body?: string | null; sentiment: "positive" | "neutral" | "negative" | "not_interested" | "opt_out"; occurredAt?: Date },
) {
  assertCrmWrite(actor, null);
  let email: string | null = null;
  let accountId: string | null = null;
  if (input.contactId) {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, input.contactId));
    email = c?.normalizedEmail ?? null;
    accountId = c?.primaryAccountId ?? null;
  } else if (input.leadContactId) {
    const [lc] = await tx.select().from(leadContacts).where(eq(leadContacts.id, input.leadContactId));
    email = lc?.normalizedEmail ?? null;
  }
  const at = input.occurredAt ?? new Date();
  const activity = await logActivity(tx, actor, {
    type: input.channel === "linkedin" ? "linkedin" : input.channel === "call" ? "call" : input.channel === "email" ? "email" : "message",
    direction: "inbound",
    channel: input.channel,
    subject: input.subject || `Reply (${input.sentiment.replace("_", " ")})`,
    body: input.body ?? null,
    outcome: `replied_${input.sentiment}`,
    occurredAt: at,
    source: "manual",
    contactId: input.contactId ?? null,
    leadId: input.leadId ?? null,
    accountId,
  });
  const stopped = await stopEnrollmentsFor(tx, actor, { contactId: input.contactId ?? null, leadContactId: input.leadContactId ?? null, email }, "replied");
  if (input.leadId) await tx.update(leads).set({ lastInteractionAt: at }).where(eq(leads.id, input.leadId));
  if (input.sentiment === "opt_out") {
    await recordOptOut(tx, actor, { contactId: input.contactId, leadContactId: input.leadContactId, email, reason: "opt_out", source: "reply", note: "Requested in reply" });
  }
  await audit(tx, actor, { action: "outreach.reply_logged", entityType: "activity", entityId: activity.id, summary: `Reply logged (${input.sentiment}); ${stopped} sequence(s) stopped` });
  return { activity, stoppedEnrollments: stopped };
}

export async function serviceName(tx: Tx, id: string | null) {
  if (!id) return null;
  return (await tx.select({ n: services.name }).from(services).where(eq(services.id, id)))[0]?.n ?? null;
}

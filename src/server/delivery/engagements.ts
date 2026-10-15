import { and, asc, desc, eq, inArray, max, ne } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  billingScheduleItems,
  changeRequests,
  deliverableReviews,
  deliverableVersions,
  deliverables,
  engagementMembers,
  engagements,
  milestones,
  scopeVersions,
  servicePeriods,
  services,
  type EngagementStatus,
  type PricingModel,
  type RecognitionMethod,
} from "@/db/schema";
import { addDaysISO, addMonthsISO } from "@/lib/dates";
import { d, toFixed4, toMoney } from "@/lib/money";
import { assertCan, can, type Actor } from "../auth/actor";
import { assertEngagementAccess } from "../auth/scope";
import { audit, diff } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { logActivity } from "../crm/activities";
import { setAccountLifecycle } from "../crm/accounts";

export function defaultRecognitionMethod(model: PricingModel, hasBudgetHours: boolean): RecognitionMethod {
  switch (model) {
    case "retainer":
      return "straight_line";
    case "milestone":
      return "milestone";
    case "hourly":
      return "time_and_materials";
    default:
      return hasBudgetHours ? "percent_complete" : "on_completion";
  }
}

export const ENGAGEMENT_TRANSITIONS: Record<EngagementStatus, EngagementStatus[]> = {
  onboarding: ["active", "on_hold", "cancelled"],
  active: ["on_hold", "completed", "cancelled"],
  on_hold: ["active", "cancelled"],
  completed: ["active"],
  cancelled: [],
};

export type EngagementInput = {
  name: string;
  accountId: string;
  serviceId: string;
  offerId?: string | null;
  billingModel: PricingModel;
  recognitionMethod?: RecognitionMethod | null;
  ownerId?: string | null;
  primaryContactId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  currency: string;
  contractValue?: string | null;
  hourlyRate?: string | null;
  retainerAmount?: string | null;
  retainerPeriodMonths?: number | null;
  budgetHours?: string | null;
  budgetCost?: string | null;
  includedRevisions?: number | null;
  renewalDate?: string | null;
  noticePeriodDays?: number | null;
  autoRenew?: boolean;
  objectives?: string | null;
  discoveryNotes?: string | null;
};

function engagementValues(input: EngagementInput) {
  if (!input.name?.trim()) throw new ValidationError("Engagement name is required.");
  if (input.billingModel === "hourly" && !input.hourlyRate) throw new ValidationError("Hourly engagements need an hourly rate.", { hourlyRate: "Required" });
  if (input.billingModel === "retainer" && !input.retainerAmount) throw new ValidationError("Retainers need a periodic fee.", { retainerAmount: "Required" });
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new ValidationError("End date is before start date.");
  return {
    name: input.name.trim(),
    accountId: input.accountId,
    serviceId: input.serviceId,
    offerId: input.offerId || null,
    billingModel: input.billingModel,
    recognitionMethod: input.recognitionMethod || defaultRecognitionMethod(input.billingModel, !!input.budgetHours),
    ownerId: input.ownerId || null,
    primaryContactId: input.primaryContactId || null,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    currency: input.currency.toUpperCase(),
    contractValue: toMoney(input.contractValue || "0"),
    hourlyRate: input.hourlyRate ? toMoney(input.hourlyRate) : null,
    retainerAmount: input.retainerAmount ? toMoney(input.retainerAmount) : null,
    retainerPeriodMonths: input.retainerPeriodMonths ?? 1,
    budgetHours: input.budgetHours ? toFixed4(input.budgetHours) : null,
    budgetCost: input.budgetCost ? toMoney(input.budgetCost) : null,
    includedRevisions: input.includedRevisions ?? null,
    renewalDate: input.renewalDate || null,
    noticePeriodDays: input.noticePeriodDays ?? null,
    autoRenew: input.autoRenew ?? false,
    objectives: input.objectives || null,
    discoveryNotes: input.discoveryNotes || null,
  };
}

export async function createEngagement(tx: Tx, actor: Actor, input: EngagementInput, opts: { opportunityId?: string | null; acceptedProposalVersionId?: string | null; createRetainerBilling?: boolean } = {}) {
  assertCan(actor, "delivery.write");
  const [svc] = await tx.select().from(services).where(eq(services.id, input.serviceId));
  if (!svc) throw new ValidationError("Choose a service stream.");
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!acc) throw new NotFoundError("Account");
  if (opts.opportunityId) {
    const [existing] = await tx.select({ id: engagements.id, number: engagements.number }).from(engagements).where(eq(engagements.opportunityId, opts.opportunityId));
    if (existing) throw new ConflictError(`This opportunity was already handed over to ${existing.number}.`);
  }
  const number = await nextNumber(tx, "engagement");
  const [eng] = await tx
    .insert(engagements)
    .values({
      ...engagementValues(input),
      number,
      templateKind: svc.templateKind,
      ownerId: input.ownerId || actor.userId || null,
      opportunityId: opts.opportunityId ?? null,
      acceptedProposalVersionId: opts.acceptedProposalVersionId ?? null,
    })
    .returning();
  if (eng.ownerId) await tx.insert(engagementMembers).values({ engagementId: eng.id, userId: eng.ownerId, role: "lead" }).onConflictDoNothing();
  if (eng.billingModel === "retainer" && eng.startDate) {
    const months = eng.retainerPeriodMonths ?? 1;
    const [period] = await tx
      .insert(servicePeriods)
      .values({
        engagementId: eng.id,
        periodNumber: 1,
        startDate: eng.startDate,
        endDate: addDaysISO(addMonthsISO(eng.startDate, months), -1),
        fee: toMoney(d(eng.retainerAmount).times(months)),
        currency: eng.currency,
        status: "active",
      })
      .returning();
    if (opts.createRetainerBilling !== false) await createRetainerBillingItems(tx, eng, period, "handover");
    if (!eng.endDate || !eng.renewalDate) {
      await tx.update(engagements).set({ endDate: eng.endDate ?? period.endDate, renewalDate: eng.renewalDate ?? period.endDate }).where(eq(engagements.id, eng.id));
    }
  }
  await logActivity(tx, actor, { type: "handover", subject: `Engagement ${number} created`, engagementId: eng.id, accountId: eng.accountId, opportunityId: opts.opportunityId ?? null, source: "system" });
  await audit(tx, actor, { action: "engagement.created", entityType: "engagement", entityId: eng.id, summary: `Created ${number} ${eng.name}` });
  if (acc.lifecycleStatus === "prospect" || acc.lifecycleStatus === "former") await setAccountLifecycle(tx, actor, acc.id, "onboarding", `${number} created`);
  return eng;
}

export async function updateEngagement(tx: Tx, actor: Actor, id: string, input: EngagementInput) {
  await assertEngagementAccess(tx, actor, id, "delivery.write");
  const [before] = await tx.select().from(engagements).where(eq(engagements.id, id)).for("update");
  const values = engagementValues({ ...input, accountId: before.accountId });
  const [after] = await tx.update(engagements).set(values).where(eq(engagements.id, id)).returning();
  if (after.ownerId) await tx.insert(engagementMembers).values({ engagementId: id, userId: after.ownerId, role: "lead" }).onConflictDoNothing();
  const changes = diff(before, after, ["name", "ownerId", "startDate", "endDate", "contractValue", "budgetHours", "budgetCost", "hourlyRate", "retainerAmount", "recognitionMethod", "renewalDate", "billingModel"]);
  if (Object.keys(changes).length) {
    await audit(tx, actor, { action: "engagement.updated", entityType: "engagement", entityId: id, summary: `Updated ${after.number}`, changes });
    if (changes.ownerId) await logActivity(tx, actor, { type: "system", subject: "Engagement owner changed", engagementId: id, accountId: after.accountId, source: "system" });
  }
  return after;
}

export async function changeEngagementStatus(tx: Tx, actor: Actor, id: string, to: EngagementStatus, note?: string | null) {
  await assertEngagementAccess(tx, actor, id, "delivery.write");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, id)).for("update");
  if (eng.status === to) return eng;
  if (!ENGAGEMENT_TRANSITIONS[eng.status].includes(to)) throw new ValidationError(`An ${eng.status} engagement cannot move to ${to}.`);
  const [after] = await tx.update(engagements).set({ status: to, completedAt: to === "completed" ? new Date() : null }).where(eq(engagements.id, id)).returning();
  await logActivity(tx, actor, { type: "status_change", subject: `Engagement ${eng.status} → ${to}`, body: note ?? null, engagementId: id, accountId: eng.accountId, source: "system" });
  await audit(tx, actor, { action: "engagement.status_changed", entityType: "engagement", entityId: id, summary: `${eng.number}: ${eng.status} → ${to}`, changes: { status: { from: eng.status, to } } });
  // Account lifecycle follows delivery: active when any engagement is active; former when none remain.
  const others = await tx.select({ s: engagements.status }).from(engagements).where(and(eq(engagements.accountId, eng.accountId), ne(engagements.id, id)));
  const statuses = [...others.map((o) => o.s), to];
  if (statuses.some((s) => s === "active")) await setAccountLifecycle(tx, actor, eng.accountId, "active");
  else if (statuses.every((s) => s === "completed" || s === "cancelled")) await setAccountLifecycle(tx, actor, eng.accountId, "former", "No active engagements");
  return after;
}

export async function setEngagementMembers(tx: Tx, actor: Actor, engagementId: string, members: { userId: string; role?: string; allocationHoursPerWeek?: string | null }[]) {
  await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  const before = await tx.select().from(engagementMembers).where(eq(engagementMembers.engagementId, engagementId));
  await tx.delete(engagementMembers).where(eq(engagementMembers.engagementId, engagementId));
  if (members.length) {
    await tx.insert(engagementMembers).values(
      members.map((m) => ({ engagementId, userId: m.userId, role: m.role || "contributor", allocationHoursPerWeek: m.allocationHoursPerWeek ? toFixed4(m.allocationHoursPerWeek) : null })),
    );
  }
  await audit(tx, actor, {
    action: "engagement.members_changed",
    entityType: "engagement",
    entityId: engagementId,
    summary: `Team updated (${members.length} members)`,
    changes: { before: before.map((b) => b.userId), after: members.map((m) => m.userId) },
  });
}

/* ------------------------------------------------------------------ */
/* Scope                                                               */
/* ------------------------------------------------------------------ */

export async function currentScope(tx: Tx, engagementId: string) {
  const [s] = await tx.select().from(scopeVersions).where(and(eq(scopeVersions.engagementId, engagementId), eq(scopeVersions.isCurrent, true)));
  return s ?? null;
}

export async function defineScope(
  tx: Tx,
  actor: Actor,
  engagementId: string,
  input: { summary?: string | null; inScope?: string | null; exclusions?: string | null; assumptions?: string | null; deliverables?: { name: string; description?: string }[]; feeAmount?: string | null; budgetHours?: string | null; budgetCost?: string | null; endDate?: string | null },
  source: { type: "proposal" | "change_request" | "manual"; id?: string | null } = { type: "manual" },
) {
  await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  const prev = await currentScope(tx, engagementId);
  if (prev && source.type === "manual") {
    const approved = await tx.select({ id: changeRequests.id }).from(changeRequests).where(and(eq(changeRequests.engagementId, engagementId), eq(changeRequests.status, "approved"))).limit(1);
    if (approved.length) throw new ValidationError("Scope has approved change requests; further changes must go through a change request.");
  }
  if (prev) await tx.update(scopeVersions).set({ isCurrent: false }).where(eq(scopeVersions.id, prev.id));
  const [row] = await tx
    .insert(scopeVersions)
    .values({
      engagementId,
      versionNumber: (prev?.versionNumber ?? 0) + 1,
      summary: input.summary || null,
      inScope: input.inScope || null,
      exclusions: input.exclusions || null,
      assumptions: input.assumptions || null,
      deliverables: input.deliverables ?? [],
      feeAmount: input.feeAmount ? toMoney(input.feeAmount) : eng.contractValue,
      budgetHours: input.budgetHours ? toFixed4(input.budgetHours) : eng.budgetHours,
      budgetCost: input.budgetCost ? toMoney(input.budgetCost) : eng.budgetCost,
      endDate: input.endDate || eng.endDate,
      currency: eng.currency,
      sourceType: source.type,
      sourceId: source.id ?? null,
      isCurrent: true,
      createdBy: actor.userId || null,
    })
    .returning();
  await audit(tx, actor, { action: "engagement.scope_defined", entityType: "engagement", entityId: engagementId, summary: `Scope v${row.versionNumber} (${source.type})` });
  return row;
}

/* ------------------------------------------------------------------ */
/* Change requests                                                     */
/* ------------------------------------------------------------------ */

export type ChangeRequestInput = {
  title: string;
  description?: string | null;
  proposedChanges: string;
  feeImpact?: string | null;
  hoursImpact?: string | null;
  costImpact?: string | null;
  deadlineImpactDays?: number | null;
  newEndDate?: string | null;
  requestedByContactId?: string | null;
};

export async function createChangeRequest(tx: Tx, actor: Actor, engagementId: string, input: ChangeRequestInput) {
  await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  if (!input.title.trim() || !input.proposedChanges.trim()) throw new ValidationError("Title and proposed changes are required.");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  const prior = await currentScope(tx, engagementId);
  const number = await nextNumber(tx, "change_request");
  const [cr] = await tx
    .insert(changeRequests)
    .values({
      number,
      engagementId,
      title: input.title.trim(),
      description: input.description || null,
      proposedChanges: input.proposedChanges.trim(),
      feeImpact: toMoney(input.feeImpact || "0"),
      currency: eng.currency,
      hoursImpact: toFixed4(input.hoursImpact || "0"),
      costImpact: toMoney(input.costImpact || "0"),
      deadlineImpactDays: input.deadlineImpactDays ?? 0,
      newEndDate: input.newEndDate || null,
      status: "submitted",
      requestedBy: actor.userId || null,
      requestedByContactId: input.requestedByContactId || null,
      priorScopeVersionId: prior?.id ?? null,
    })
    .returning();
  await logActivity(tx, actor, { type: "system", subject: `Change request ${number} submitted: ${cr.title}`, body: `Fee impact ${cr.currency} ${cr.feeImpact}; ${cr.deadlineImpactDays} days`, engagementId, accountId: eng.accountId, relatedType: "change_request", relatedId: cr.id, source: "system" });
  await audit(tx, actor, { action: "change_request.submitted", entityType: "change_request", entityId: cr.id, summary: `${number} submitted for ${eng.number}` });
  return cr;
}

/**
 * Approve a scope change: requires client approval evidence. Creates a new
 * scope version (the prior version is preserved), updates the engagement's
 * fee, budget and end date, and drafts a billing schedule item for any fee.
 */
export async function approveChangeRequest(tx: Tx, actor: Actor, crId: string, input: { clientApprovalEvidence: string; clientApprovedByContactId?: string | null; decisionNote?: string | null }) {
  const [cr] = await tx.select().from(changeRequests).where(eq(changeRequests.id, crId)).for("update");
  if (!cr) throw new NotFoundError("Change request");
  await assertEngagementAccess(tx, actor, cr.engagementId, "delivery.approve");
  if (cr.status === "approved") throw new ConflictError("This change request is already approved.");
  if (cr.status !== "submitted") throw new ValidationError(`A ${cr.status} change request cannot be approved.`);
  if (!input.clientApprovalEvidence?.trim()) throw new ValidationError("Record the client's approval evidence.", { clientApprovalEvidence: "Required" });
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, cr.engagementId)).for("update");
  const prior = await currentScope(tx, cr.engagementId);
  const newEnd = cr.newEndDate ?? (eng.endDate && cr.deadlineImpactDays ? addDaysISO(eng.endDate, cr.deadlineImpactDays) : eng.endDate);
  const newFee = d(prior?.feeAmount ?? eng.contractValue).plus(d(cr.feeImpact));
  const newHours = eng.budgetHours || prior?.budgetHours ? d(prior?.budgetHours ?? eng.budgetHours).plus(d(cr.hoursImpact)) : null;
  const newCost = eng.budgetCost || prior?.budgetCost ? d(prior?.budgetCost ?? eng.budgetCost).plus(d(cr.costImpact)) : null;
  if (prior) await tx.update(scopeVersions).set({ isCurrent: false }).where(eq(scopeVersions.id, prior.id));
  const [scope] = await tx
    .insert(scopeVersions)
    .values({
      engagementId: cr.engagementId,
      versionNumber: (prior?.versionNumber ?? 0) + 1,
      summary: prior?.summary ?? null,
      inScope: [prior?.inScope, `Change ${cr.number}: ${cr.proposedChanges}`].filter(Boolean).join("\n\n"),
      deliverables: prior?.deliverables ?? [],
      exclusions: prior?.exclusions ?? null,
      assumptions: prior?.assumptions ?? null,
      feeAmount: toMoney(newFee),
      budgetHours: newHours ? toFixed4(newHours) : null,
      budgetCost: newCost ? toMoney(newCost) : null,
      endDate: newEnd,
      currency: eng.currency,
      sourceType: "change_request",
      sourceId: cr.id,
      isCurrent: true,
      createdBy: actor.userId || null,
    })
    .returning();
  await tx
    .update(engagements)
    .set({
      contractValue: toMoney(d(eng.contractValue).plus(d(cr.feeImpact))),
      budgetHours: newHours ? toFixed4(newHours) : eng.budgetHours,
      budgetCost: newCost ? toMoney(newCost) : eng.budgetCost,
      endDate: newEnd,
    })
    .where(eq(engagements.id, eng.id));
  await tx
    .update(changeRequests)
    .set({
      status: "approved",
      clientApprovalEvidence: input.clientApprovalEvidence.trim(),
      clientApprovedByContactId: input.clientApprovedByContactId || null,
      decidedBy: actor.userId || null,
      decidedAt: new Date(),
      decisionNote: input.decisionNote || null,
      priorScopeVersionId: prior?.id ?? null,
      resultingScopeVersionId: scope.id,
    })
    .where(eq(changeRequests.id, cr.id));
  if (d(cr.feeImpact).greaterThan(0)) {
    await tx
      .insert(billingScheduleItems)
      .values({ engagementId: eng.id, label: `Change request ${cr.number}: ${cr.title}`, plannedDate: newEnd ?? null, amount: cr.feeImpact, currency: cr.currency, status: "draft", source: "change_request", sourceId: cr.id, generationKey: `cr:${cr.id}` })
      .onConflictDoNothing();
  }
  await logActivity(tx, actor, { type: "contract", subject: `Change request ${cr.number} approved — scope v${scope.versionNumber}`, body: input.clientApprovalEvidence, engagementId: eng.id, accountId: eng.accountId, relatedType: "change_request", relatedId: cr.id, source: "system" });
  await audit(tx, actor, {
    action: "change_request.approved",
    entityType: "change_request",
    entityId: cr.id,
    summary: `${cr.number} approved; ${eng.number} fee ${eng.contractValue} → ${toMoney(d(eng.contractValue).plus(d(cr.feeImpact)))}`,
    changes: {
      contractValue: { from: eng.contractValue, to: toMoney(d(eng.contractValue).plus(d(cr.feeImpact))) },
      endDate: { from: eng.endDate, to: newEnd },
      budgetHours: { from: eng.budgetHours, to: newHours?.toString() ?? null },
      priorScopeVersionId: prior?.id ?? null,
      resultingScopeVersionId: scope.id,
    },
  });
  return scope;
}

export async function rejectChangeRequest(tx: Tx, actor: Actor, crId: string, decision: "rejected" | "withdrawn", note: string) {
  const [cr] = await tx.select().from(changeRequests).where(eq(changeRequests.id, crId)).for("update");
  if (!cr) throw new NotFoundError("Change request");
  await assertEngagementAccess(tx, actor, cr.engagementId, decision === "rejected" ? "delivery.approve" : "delivery.write");
  if (cr.status !== "submitted" && cr.status !== "draft") throw new ValidationError(`A ${cr.status} change request cannot be ${decision}.`);
  await tx.update(changeRequests).set({ status: decision, decidedBy: actor.userId || null, decidedAt: new Date(), decisionNote: note || null }).where(eq(changeRequests.id, crId));
  await audit(tx, actor, { action: `change_request.${decision}`, entityType: "change_request", entityId: crId, summary: `${cr.number} ${decision}: ${note}` });
}

/* ------------------------------------------------------------------ */
/* Milestones & deliverables                                           */
/* ------------------------------------------------------------------ */

export async function createMilestone(tx: Tx, actor: Actor, engagementId: string, input: { name: string; dueDate?: string | null; description?: string | null; billable?: boolean; billingAmount?: string | null; projectId?: string | null }) {
  await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  if (input.billable && !input.billingAmount) throw new ValidationError("Billable milestones need an amount.");
  const [{ n }] = await tx.select({ n: max(milestones.sortOrder) }).from(milestones).where(eq(milestones.engagementId, engagementId));
  const [m] = await tx
    .insert(milestones)
    .values({
      engagementId,
      projectId: input.projectId || null,
      name: input.name.trim(),
      description: input.description || null,
      dueDate: input.dueDate || null,
      billable: !!input.billable,
      billingAmount: input.billingAmount ? toMoney(input.billingAmount) : null,
      currency: eng.currency,
      sortOrder: (n ?? 0) + 1,
    })
    .returning();
  await audit(tx, actor, { action: "milestone.created", entityType: "milestone", entityId: m.id, summary: `Milestone ${m.name} on ${eng.number}` });
  return m;
}

/** Milestone acceptance requires every linked deliverable to be client-approved. */
export async function acceptMilestone(tx: Tx, actor: Actor, milestoneId: string, input: { acceptedAt: string; acceptanceEvidence: string; acceptedByContactId?: string | null }) {
  const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update");
  if (!m) throw new NotFoundError("Milestone");
  await assertEngagementAccess(tx, actor, m.engagementId, "delivery.approve");
  if (m.status === "accepted") throw new ConflictError("Milestone already accepted.");
  if (!input.acceptanceEvidence.trim()) throw new ValidationError("Record the acceptance evidence.");
  const ds = await tx.select().from(deliverables).where(eq(deliverables.milestoneId, milestoneId));
  const pending = ds.filter((x) => x.approvalStatus !== "approved");
  if (pending.length) throw new ValidationError(`Deliverables not yet approved by the client: ${pending.map((p) => p.name).join(", ")}.`);
  await tx.update(milestones).set({ status: "accepted", acceptedAt: input.acceptedAt, acceptanceEvidence: input.acceptanceEvidence, acceptedByContactId: input.acceptedByContactId || null }).where(eq(milestones.id, milestoneId));
  // Billing: the milestone's draft billing item becomes ready to invoice.
  await tx.update(billingScheduleItems).set({ status: "planned" }).where(and(eq(billingScheduleItems.milestoneId, milestoneId), eq(billingScheduleItems.status, "draft")));
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, m.engagementId));
  await logActivity(tx, actor, { type: "deliverable", subject: `Milestone accepted: ${m.name}`, body: input.acceptanceEvidence, engagementId: m.engagementId, accountId: eng.accountId, relatedType: "milestone", relatedId: m.id });
  await audit(tx, actor, { action: "milestone.accepted", entityType: "milestone", entityId: m.id, summary: `${m.name} accepted`, changes: input });
}

export async function createDeliverable(tx: Tx, actor: Actor, engagementId: string, input: { name: string; description?: string | null; dueDate?: string | null; ownerId?: string | null; milestoneId?: string | null; deliverableType?: string | null; includedRevisions?: number | null }) {
  await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  if (!input.name.trim()) throw new ValidationError("Deliverable name is required.");
  const [row] = await tx
    .insert(deliverables)
    .values({
      engagementId,
      name: input.name.trim(),
      description: input.description || null,
      dueDate: input.dueDate || null,
      ownerId: input.ownerId || eng.ownerId,
      milestoneId: input.milestoneId || null,
      deliverableType: input.deliverableType || null,
      includedRevisions: input.includedRevisions ?? eng.includedRevisions,
    })
    .returning();
  await audit(tx, actor, { action: "deliverable.created", entityType: "deliverable", entityId: row.id, summary: `Deliverable ${row.name} on ${eng.number}` });
  return row;
}

/**
 * Submit a new version of a deliverable for review. Internal-stage versions
 * go to internal review; client-stage versions await the client. Completing
 * tasks never changes deliverable approval status.
 */
export async function submitDeliverableVersion(tx: Tx, actor: Actor, deliverableId: string, input: { notes?: string | null; link?: string | null; documentId?: string | null; stage: "internal" | "client" }) {
  const [dl] = await tx.select().from(deliverables).where(eq(deliverables.id, deliverableId)).for("update");
  if (!dl) throw new NotFoundError("Deliverable");
  await assertEngagementAccess(tx, actor, dl.engagementId, "delivery.write");
  if (dl.approvalStatus === "approved") throw new ValidationError("This deliverable is already approved.");
  if (dl.approvalStatus === "internal_review" || dl.approvalStatus === "awaiting_client") throw new ValidationError("A version is already awaiting review.");
  if (input.link && !/^https?:\/\//i.test(input.link)) throw new ValidationError("Links must start with http(s)://");
  const versionNumber = dl.currentVersionNumber + 1;
  const [v] = await tx
    .insert(deliverableVersions)
    .values({ deliverableId, versionNumber, notes: input.notes || null, link: input.link || null, documentId: input.documentId || null, submittedBy: actor.userId || null, stage: input.stage })
    .returning();
  const status = input.stage === "internal" ? "internal_review" : "awaiting_client";
  await tx.update(deliverables).set({ currentVersionNumber: versionNumber, approvalStatus: status }).where(eq(deliverables.id, deliverableId));
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, dl.engagementId));
  await logActivity(tx, actor, { type: "deliverable", subject: `${dl.name} v${versionNumber} submitted for ${input.stage} review`, body: input.notes ?? null, engagementId: dl.engagementId, accountId: eng.accountId, relatedType: "deliverable", relatedId: dl.id });
  await audit(tx, actor, { action: "deliverable.submitted", entityType: "deliverable", entityId: dl.id, summary: `${dl.name} v${versionNumber} → ${status}` });
  return v;
}

export async function recordDeliverableReview(
  tx: Tx,
  actor: Actor,
  deliverableId: string,
  input: { decision: "approved" | "changes_requested" | "rejected"; feedback?: string | null; evidence?: string | null; reviewerContactId?: string | null; reviewerName?: string | null },
) {
  const [dl] = await tx.select().from(deliverables).where(eq(deliverables.id, deliverableId)).for("update");
  if (!dl) throw new NotFoundError("Deliverable");
  const [v] = await tx.select().from(deliverableVersions).where(and(eq(deliverableVersions.deliverableId, deliverableId), eq(deliverableVersions.versionNumber, dl.currentVersionNumber)));
  if (!v || v.outcome !== "pending") throw new ValidationError("There is no version awaiting review.");
  const isClient = dl.approvalStatus === "awaiting_client";
  await assertEngagementAccess(tx, actor, dl.engagementId, isClient ? "delivery.approve" : "delivery.write");
  if (isClient && input.decision === "approved" && !input.evidence?.trim()) {
    throw new ValidationError("Record how the client approved (e.g. email from …, meeting on …).", { evidence: "Required" });
  }
  if (input.decision !== "approved" && !input.feedback?.trim()) throw new ValidationError("Capture the feedback.", { feedback: "Required" });
  const countsAsRevision = isClient && input.decision === "changes_requested";
  await tx.insert(deliverableReviews).values({
    deliverableId,
    versionId: v.id,
    reviewerType: isClient ? "client" : "internal",
    reviewerUserId: isClient ? null : actor.userId || null,
    reviewerContactId: input.reviewerContactId || null,
    reviewerName: input.reviewerName || null,
    decision: input.decision,
    feedback: input.feedback || null,
    evidence: input.evidence || null,
    countsAsRevision,
    recordedBy: actor.userId || null,
  });
  let status: typeof dl.approvalStatus;
  if (input.decision === "approved") {
    if (isClient) {
      status = "approved";
      await tx.update(deliverableVersions).set({ outcome: "approved" }).where(eq(deliverableVersions.id, v.id));
    } else {
      // Internal approval promotes the same version to client review.
      status = "awaiting_client";
      await tx.update(deliverableVersions).set({ stage: "client" }).where(eq(deliverableVersions.id, v.id));
    }
  } else {
    status = input.decision === "rejected" ? "rejected" : "changes_requested";
    await tx.update(deliverableVersions).set({ outcome: input.decision }).where(eq(deliverableVersions.id, v.id));
  }
  await tx
    .update(deliverables)
    .set({ approvalStatus: status, approvedAt: status === "approved" ? new Date() : null, revisionsUsed: countsAsRevision ? dl.revisionsUsed + 1 : dl.revisionsUsed })
    .where(eq(deliverables.id, deliverableId));
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, dl.engagementId));
  const over = countsAsRevision && dl.includedRevisions != null && dl.revisionsUsed + 1 > dl.includedRevisions;
  await logActivity(tx, actor, {
    type: "deliverable",
    subject: `${dl.name} v${v.versionNumber}: ${isClient ? "client" : "internal"} ${input.decision.replace("_", " ")}${over ? " — revision limit exceeded" : ""}`,
    body: [input.feedback, input.evidence].filter(Boolean).join("\n"),
    engagementId: dl.engagementId,
    accountId: eng.accountId,
    contactId: input.reviewerContactId ?? null,
    relatedType: "deliverable",
    relatedId: dl.id,
  });
  await audit(tx, actor, { action: `deliverable.${input.decision}`, entityType: "deliverable", entityId: dl.id, summary: `${dl.name} v${v.versionNumber} ${isClient ? "client" : "internal"} ${input.decision}` });
  return { status, revisionLimitExceeded: over };
}

/* ------------------------------------------------------------------ */
/* Retainer renewal                                                    */
/* ------------------------------------------------------------------ */

/**
 * Renew a retainer: creates the NEXT service period and its billing schedule
 * item. Unique (engagement, period number) and generation keys make it safe
 * to call twice — the second call returns the existing period.
 */
export async function renewRetainer(tx: Tx, actor: Actor, engagementId: string, input: { fee?: string | null; months?: number | null; expectedPeriodNumber?: number } = {}) {
  if (!can(actor, "delivery.write") && !can(actor, "finance.write")) throw new ForbiddenError();
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId)).for("update");
  if (!eng) throw new NotFoundError("Engagement");
  if (eng.billingModel !== "retainer") throw new ValidationError("Only retainers can be renewed this way.");
  if (eng.status === "cancelled" || eng.status === "completed") throw new ValidationError(`A ${eng.status} engagement cannot be renewed.`);
  const periods = await tx.select().from(servicePeriods).where(eq(servicePeriods.engagementId, engagementId)).orderBy(desc(servicePeriods.periodNumber));
  const last = periods[0];
  if (!last) throw new ValidationError("This retainer has no service period yet.");
  // Idempotency: a retry for a period that already exists returns it.
  if (input.expectedPeriodNumber && last.periodNumber >= input.expectedPeriodNumber) {
    return { period: periods.find((p) => p.periodNumber === input.expectedPeriodNumber)!, created: false };
  }
  const months = input.months ?? eng.retainerPeriodMonths ?? 1;
  const start = addDaysISO(last.endDate, 1);
  const end = addDaysISO(addMonthsISO(start, months), -1);
  const monthly = toMoney(input.fee || eng.retainerAmount || d(last.fee).div(months));
  const fee = toMoney(d(monthly).times(months));
  const inserted = await tx
    .insert(servicePeriods)
    .values({ engagementId, periodNumber: last.periodNumber + 1, startDate: start, endDate: end, fee, currency: eng.currency, status: "upcoming", renewalOfPeriodId: last.id })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const [existing] = await tx.select().from(servicePeriods).where(and(eq(servicePeriods.engagementId, engagementId), eq(servicePeriods.periodNumber, last.periodNumber + 1)));
    return { period: existing, created: false };
  }
  const period = inserted[0];
  await createRetainerBillingItems(tx, { ...eng, retainerAmount: monthly }, period, "renewal");
  await tx.update(engagements).set({ endDate: end, renewalDate: end, retainerAmount: monthly, contractValue: toMoney(d(eng.contractValue).plus(d(fee))) }).where(eq(engagements.id, engagementId));
  await logActivity(tx, actor, { type: "renewal", subject: `Retainer renewed: period ${period.periodNumber} (${start} – ${end}), ${eng.currency} ${monthly}/month`, engagementId, accountId: eng.accountId, relatedType: "service_period", relatedId: period.id, source: "system" });
  await audit(tx, actor, { action: "engagement.renewed", entityType: "engagement", entityId: engagementId, summary: `${eng.number} renewed to ${end}`, changes: { endDate: { from: eng.endDate, to: end }, fee } });
  return { period, created: true };
}

export async function listMilestonesWithDeliverables(tx: Tx, engagementId: string) {
  const ms = await tx.select().from(milestones).where(eq(milestones.engagementId, engagementId)).orderBy(asc(milestones.sortOrder));
  const ds = await tx.select().from(deliverables).where(eq(deliverables.engagementId, engagementId)).orderBy(asc(deliverables.dueDate));
  return { milestones: ms, deliverables: ds };
}

export async function deliverableHistory(tx: Tx, deliverableIds: string[]) {
  if (!deliverableIds.length) return { versions: [], reviews: [] };
  const versions = await tx.select().from(deliverableVersions).where(inArray(deliverableVersions.deliverableId, deliverableIds)).orderBy(desc(deliverableVersions.versionNumber));
  const reviews = await tx.select().from(deliverableReviews).where(inArray(deliverableReviews.deliverableId, deliverableIds)).orderBy(desc(deliverableReviews.decidedAt));
  return { versions, reviews };
}

/**
 * One billing schedule item per month of a retainer service period.
 * generationKey makes repeated calls (retries) a no-op.
 */
export async function createRetainerBillingItems(
  tx: Tx,
  eng: { id: string; currency: string; retainerAmount: string | null },
  period: { id: string; periodNumber: number; startDate: string; endDate: string },
  source: "handover" | "renewal",
) {
  if (!eng.retainerAmount) return 0;
  let n = 0;
  for (let start = period.startDate; start <= period.endDate; start = addMonthsISO(start, 1)) {
    const monthKey = start.slice(0, 7);
    const rows = await tx
      .insert(billingScheduleItems)
      .values({
        engagementId: eng.id,
        label: `Retainer ${monthKey} (period ${period.periodNumber})`,
        plannedDate: start,
        amount: eng.retainerAmount,
        currency: eng.currency,
        servicePeriodId: period.id,
        status: "planned",
        source,
        sourceId: period.id,
        generationKey: `retainer:${eng.id}:${monthKey}`,
      })
      .onConflictDoNothing()
      .returning({ id: billingScheduleItems.id });
    n += rows.length;
  }
  return n;
}

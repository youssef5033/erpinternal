import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  opportunities,
  pipelineStages,
  proposalAcceptances,
  proposalTemplates,
  proposalVersions,
  proposals,
  taxRates,
  type PaymentScheduleItem,
  type PricingModel,
  type ProposalDeliverable,
  type ProposalLine,
} from "@/db/schema";
import { d, sum, toFixed4, toMoney } from "@/lib/money";
import { addDaysISO } from "@/lib/dates";
import { assertCan, type Actor } from "../auth/actor";
import { assertCrmWrite } from "../auth/scope";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { agencyToday } from "../system/settings";
import { logActivity } from "./activities";
import { moveOpportunityStage } from "./opportunities";

export type ProposalContent = {
  introduction?: string | null;
  scope?: string | null;
  deliverables?: ProposalDeliverable[];
  exclusions?: string | null;
  assumptions?: string | null;
  timeline?: string | null;
  terms?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  pricingModel: PricingModel;
  currency: string;
  lines: ProposalLine[];
  discountPercent?: string | null;
  taxRateId?: string | null;
  hourlyRate?: string | null;
  estimatedHours?: string | null;
  retainerMonths?: number | null;
  paymentSchedule?: PaymentScheduleItem[];
  changeSummary?: string | null;
};

/** Totals: subtotal = Σ qty×price; discount on subtotal; tax on discounted subtotal. */
export function computeProposalTotals(lines: ProposalLine[], discountPercent: string | null | undefined, taxPercent: string | null | undefined) {
  const subtotal = sum(lines.map((l) => d(l.quantity || "0").times(d(l.unitPrice || "0"))));
  const discount = subtotal.times(d(discountPercent)).div(100);
  const net = subtotal.minus(discount);
  const tax = net.times(d(taxPercent)).div(100);
  return {
    subtotal: toMoney(subtotal),
    discountAmount: toMoney(discount),
    taxAmount: toMoney(tax),
    total: toMoney(d(toMoney(net)).plus(d(toMoney(tax)))),
  };
}

export function validatePaymentSchedule(schedule: PaymentScheduleItem[], total: string) {
  if (!schedule.length) return;
  const hasPercent = schedule.some((s) => s.percent);
  const hasAmount = schedule.some((s) => s.amount);
  if (hasPercent && hasAmount) throw new ValidationError("Use either percentages or amounts in the payment schedule, not both.");
  if (schedule.every((s) => s.recurring === "monthly")) return;
  if (hasPercent) {
    const p = sum(schedule.map((s) => s.percent));
    if (!p.equals(100)) throw new ValidationError(`Payment schedule percentages add up to ${p.toString()}%, not 100%.`);
  }
  if (hasAmount) {
    const a = sum(schedule.map((s) => s.amount));
    if (!a.equals(d(total))) throw new ValidationError(`Payment schedule amounts total ${a.toFixed(2)}, not the proposal total ${total}.`);
  }
}

async function versionValues(tx: Tx, content: ProposalContent) {
  if (!content.currency || content.currency.length !== 3) throw new ValidationError("Currency is required.");
  for (const l of content.lines) {
    if (!l.description?.trim()) throw new ValidationError("Every price line needs a description.");
    if (d(l.quantity).isNegative() || d(l.unitPrice).isNegative()) throw new ValidationError("Quantities and prices cannot be negative.");
  }
  const discount = d(content.discountPercent);
  if (discount.isNegative() || discount.greaterThan(100)) throw new ValidationError("Discount must be between 0 and 100%.");
  let taxPercent = "0";
  if (content.taxRateId) {
    const [t] = await tx.select().from(taxRates).where(eq(taxRates.id, content.taxRateId));
    if (!t) throw new ValidationError("Unknown tax rate.");
    taxPercent = t.ratePercent;
  }
  const totals = computeProposalTotals(content.lines, content.discountPercent, taxPercent);
  validatePaymentSchedule(content.paymentSchedule ?? [], totals.total);
  return {
    introduction: content.introduction || null,
    scope: content.scope || null,
    deliverables: content.deliverables ?? [],
    exclusions: content.exclusions || null,
    assumptions: content.assumptions || null,
    timeline: content.timeline || null,
    terms: content.terms || null,
    startDate: content.startDate || null,
    endDate: content.endDate || null,
    pricingModel: content.pricingModel,
    currency: content.currency.toUpperCase(),
    lines: content.lines.map((l) => ({ ...l, quantity: toFixed4(l.quantity), unitPrice: toMoney(l.unitPrice) })),
    discountPercent: toFixed4(content.discountPercent || "0"),
    taxRateId: content.taxRateId || null,
    taxRatePercent: toFixed4(taxPercent),
    hourlyRate: content.hourlyRate ? toMoney(content.hourlyRate) : null,
    estimatedHours: content.estimatedHours ? toFixed4(content.estimatedHours) : null,
    retainerMonths: content.retainerMonths ?? null,
    paymentSchedule: content.paymentSchedule ?? [],
    changeSummary: content.changeSummary || null,
    ...totals,
  };
}

export async function createProposal(tx: Tx, actor: Actor, input: { opportunityId: string; title: string; templateId?: string | null; validUntil?: string | null; content?: ProposalContent }) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, input.opportunityId));
  if (!opp) throw new NotFoundError("Opportunity");
  assertCrmWrite(actor, opp.ownerId);
  if (opp.status !== "open") throw new ValidationError("Proposals can only be created for open opportunities.");
  let content: ProposalContent = input.content ?? {
    pricingModel: opp.pricingModel,
    currency: opp.currency,
    scope: opp.scopeSummary,
    lines: [{ description: opp.name, quantity: "1", unitPrice: opp.value }],
    paymentSchedule: [],
  };
  if (input.templateId && !input.content) {
    const [t] = await tx.select().from(proposalTemplates).where(eq(proposalTemplates.id, input.templateId));
    if (!t) throw new NotFoundError("Proposal template");
    content = {
      ...content,
      introduction: t.introduction,
      scope: t.scope ?? content.scope,
      deliverables: t.deliverables ?? [],
      exclusions: t.exclusions,
      assumptions: t.assumptions,
      timeline: t.timeline,
      terms: t.terms,
      pricingModel: t.pricingModel ?? content.pricingModel,
    };
  }
  const today = await agencyToday(tx);
  const number = await nextNumber(tx, "proposal");
  const [proposal] = await tx
    .insert(proposals)
    .values({
      number,
      opportunityId: opp.id,
      accountId: opp.accountId,
      templateId: input.templateId || null,
      title: input.title.trim() || opp.name,
      ownerId: opp.ownerId ?? actor.userId,
      validUntil: input.validUntil || addDaysISO(today, 30),
    })
    .returning();
  const [version] = await tx
    .insert(proposalVersions)
    .values({ proposalId: proposal.id, versionNumber: 1, ...(await versionValues(tx, content)), createdBy: actor.userId || null })
    .returning();
  await tx.update(proposals).set({ currentVersionId: version.id }).where(eq(proposals.id, proposal.id));
  await advanceStageTo(tx, actor, opp.id, "proposal_preparing");
  await logActivity(tx, actor, { type: "proposal", subject: `Proposal ${number} drafted`, opportunityId: opp.id, accountId: opp.accountId, relatedType: "proposal", relatedId: proposal.id, source: "system" });
  await audit(tx, actor, { action: "proposal.created", entityType: "proposal", entityId: proposal.id, summary: `Created ${number} (v1)` });
  return { ...proposal, currentVersionId: version.id };
}

async function loadProposal(tx: Tx, id: string, lock = false) {
  const q = tx.select().from(proposals).where(eq(proposals.id, id));
  const [p] = lock ? await q.for("update") : await q;
  if (!p) throw new NotFoundError("Proposal");
  return p;
}

async function loadCurrentVersion(tx: Tx, p: typeof proposals.$inferSelect) {
  const [v] = await tx.select().from(proposalVersions).where(eq(proposalVersions.id, p.currentVersionId!));
  if (!v) throw new NotFoundError("Proposal version");
  return v;
}

/** Edit the current draft version (only while it is unlocked). */
export async function updateProposalDraft(tx: Tx, actor: Actor, proposalId: string, content: ProposalContent) {
  const p = await loadProposal(tx, proposalId, true);
  assertCrmWrite(actor, p.ownerId);
  const v = await loadCurrentVersion(tx, p);
  if (v.locked) throw new ValidationError(`Version ${v.versionNumber} is locked (submitted or sent). Create a revision to make changes.`);
  await tx.update(proposalVersions).set(await versionValues(tx, content)).where(eq(proposalVersions.id, v.id));
  await audit(tx, actor, { action: "proposal.draft_updated", entityType: "proposal", entityId: p.id, summary: `Edited ${p.number} v${v.versionNumber}` });
}

/** Create a new version from the current one. Earlier versions are preserved. */
export async function reviseProposal(tx: Tx, actor: Actor, proposalId: string, changeSummary: string) {
  const p = await loadProposal(tx, proposalId, true);
  assertCrmWrite(actor, p.ownerId);
  if (p.status === "accepted") throw new ValidationError("Accepted proposals cannot be revised. Create a change request on the engagement instead.");
  const v = await loadCurrentVersion(tx, p);
  if (!v.locked) throw new ValidationError("The current version is still a draft — edit it directly.");
  const [latest] = await tx.select().from(proposalVersions).where(eq(proposalVersions.proposalId, p.id)).orderBy(desc(proposalVersions.versionNumber)).limit(1);
  const { id: _id, createdAt: _c, versionNumber: _n, locked: _l, approvalStatus: _a, approvedAt: _aa, approvedBy: _ab, approvalNote: _an, approvalRequestedBy: _ar, pdfDocumentId: _pdf, ...copy } = v;
  const [nv] = await tx
    .insert(proposalVersions)
    .values({ ...copy, versionNumber: latest.versionNumber + 1, changeSummary: changeSummary || "Revision", createdBy: actor.userId || null })
    .returning();
  await tx.update(proposals).set({ currentVersionId: nv.id, status: "draft" }).where(eq(proposals.id, p.id));
  await logActivity(tx, actor, { type: "proposal", subject: `${p.number} revised to v${nv.versionNumber}`, body: changeSummary, opportunityId: p.opportunityId, accountId: p.accountId, relatedType: "proposal", relatedId: p.id, source: "system" });
  await audit(tx, actor, { action: "proposal.revised", entityType: "proposal", entityId: p.id, summary: `${p.number} v${nv.versionNumber}: ${changeSummary}` });
  return nv;
}

export async function submitProposalForApproval(tx: Tx, actor: Actor, proposalId: string) {
  const p = await loadProposal(tx, proposalId, true);
  assertCrmWrite(actor, p.ownerId);
  const v = await loadCurrentVersion(tx, p);
  if (v.approvalStatus === "pending") return;
  if (!v.lines.length || d(v.total).lessThanOrEqualTo(0)) throw new ValidationError("Add pricing before requesting approval.");
  await tx.update(proposalVersions).set({ locked: true, approvalStatus: "pending", approvalRequestedBy: actor.userId || null }).where(eq(proposalVersions.id, v.id));
  await tx.update(proposals).set({ status: "in_review" }).where(eq(proposals.id, p.id));
  await audit(tx, actor, { action: "proposal.approval_requested", entityType: "proposal", entityId: p.id, summary: `${p.number} v${v.versionNumber} submitted for internal approval` });
}

export async function decideProposalApproval(tx: Tx, actor: Actor, proposalId: string, decision: "approved" | "rejected", note?: string | null) {
  assertCan(actor, "proposals.approve");
  const p = await loadProposal(tx, proposalId, true);
  const v = await loadCurrentVersion(tx, p);
  if (v.approvalStatus !== "pending") throw new ValidationError("This version is not awaiting approval.");
  if (decision === "rejected" && !note?.trim()) throw new ValidationError("Explain what needs to change.");
  await tx
    .update(proposalVersions)
    .set({ approvalStatus: decision, approvedBy: actor.userId || null, approvedAt: new Date(), approvalNote: note || null })
    .where(eq(proposalVersions.id, v.id));
  await tx.update(proposals).set({ status: decision === "approved" ? "approved" : "draft" }).where(eq(proposals.id, p.id));
  await logActivity(tx, actor, { type: "proposal", subject: `${p.number} v${v.versionNumber} ${decision === "approved" ? "approved internally" : "returned for changes"}`, body: note ?? null, opportunityId: p.opportunityId, accountId: p.accountId, relatedType: "proposal", relatedId: p.id, source: "system" });
  await audit(tx, actor, { action: `proposal.${decision}`, entityType: "proposal", entityId: p.id, summary: `${p.number} v${v.versionNumber} ${decision}`, changes: { note } });
}

/**
 * Record that the approved version was sent to the client (manually, or via a
 * connected integration in future). Moves the opportunity to "Proposal sent".
 */
export async function markProposalSent(tx: Tx, actor: Actor, proposalId: string, sentOn?: string | null) {
  const p = await loadProposal(tx, proposalId, true);
  assertCrmWrite(actor, p.ownerId);
  const v = await loadCurrentVersion(tx, p);
  if (v.approvalStatus !== "approved") throw new ValidationError("Only an internally approved version can be sent.");
  if (p.status === "sent") return;
  await tx.update(proposals).set({ status: "sent", sentAt: sentOn ? new Date(`${sentOn}T12:00:00Z`) : new Date() }).where(eq(proposals.id, p.id));
  await advanceStageTo(tx, actor, p.opportunityId, "proposal_sent");
  await logActivity(tx, actor, { type: "proposal", direction: "outbound", subject: `${p.number} v${v.versionNumber} sent to client`, opportunityId: p.opportunityId, accountId: p.accountId, relatedType: "proposal", relatedId: p.id });
  await audit(tx, actor, { action: "proposal.sent", entityType: "proposal", entityId: p.id, summary: `${p.number} v${v.versionNumber} marked sent` });
}

export type AcceptanceInput = {
  acceptedAt: string;
  acceptedByName: string;
  acceptedByContactId?: string | null;
  method: "manual_record" | "email_confirmation" | "signed_document";
  evidenceNote?: string | null;
  evidenceDocumentId?: string | null;
};

/**
 * Record client acceptance with evidence. A manual record is labelled as such
 * and is never presented as a verified electronic signature.
 */
export async function recordProposalAcceptance(tx: Tx, actor: Actor, proposalId: string, input: AcceptanceInput) {
  const p = await loadProposal(tx, proposalId, true);
  assertCrmWrite(actor, p.ownerId);
  if ((input.method as string) === "verified_esignature") throw new ValidationError("Verified e-signatures require a connected e-signature integration.");
  if (p.status === "accepted") throw new ConflictError("Acceptance has already been recorded for this proposal.");
  if (p.status !== "sent") throw new ValidationError("Mark the proposal as sent before recording acceptance.");
  if (!input.acceptedByName.trim()) throw new ValidationError("Who accepted the proposal?", { acceptedByName: "Required" });
  if (input.method !== "manual_record" && !input.evidenceNote && !input.evidenceDocumentId) {
    throw new ValidationError("Attach the evidence (document or note) for this acceptance method.");
  }
  const v = await loadCurrentVersion(tx, p);
  await tx.insert(proposalAcceptances).values({
    proposalId: p.id,
    versionId: v.id,
    acceptedAt: input.acceptedAt,
    acceptedByName: input.acceptedByName.trim(),
    acceptedByContactId: input.acceptedByContactId || null,
    method: input.method,
    evidenceNote: input.evidenceNote || null,
    evidenceDocumentId: input.evidenceDocumentId || null,
    recordedBy: actor.userId || null,
  });
  await tx.update(proposals).set({ status: "accepted", acceptedVersionId: v.id, decidedAt: new Date() }).where(eq(proposals.id, p.id));
  await tx.update(opportunities).set({ acceptedProposalVersionId: v.id }).where(eq(opportunities.id, p.opportunityId));
  // Any other outstanding proposals on this opportunity are withdrawn.
  await tx
    .update(proposals)
    .set({ status: "withdrawn" })
    .where(and(eq(proposals.opportunityId, p.opportunityId), inArray(proposals.status, ["draft", "in_review", "approved", "sent"])));
  await advanceStageTo(tx, actor, p.opportunityId, "negotiation");
  await logActivity(tx, actor, {
    type: "proposal",
    direction: "inbound",
    subject: `${p.number} v${v.versionNumber} accepted by ${input.acceptedByName} (${input.method.replace("_", " ")})`,
    body: input.evidenceNote ?? null,
    opportunityId: p.opportunityId,
    accountId: p.accountId,
    contactId: input.acceptedByContactId ?? null,
    relatedType: "proposal",
    relatedId: p.id,
  });
  await audit(tx, actor, { action: "proposal.accepted", entityType: "proposal", entityId: p.id, summary: `${p.number} v${v.versionNumber} acceptance recorded (${input.method})`, changes: { ...input } });
  return v;
}

export async function markProposalRejected(tx: Tx, actor: Actor, proposalId: string, reason: string) {
  const p = await loadProposal(tx, proposalId, true);
  assertCrmWrite(actor, p.ownerId);
  if (!["sent", "approved"].includes(p.status)) throw new ValidationError("Only sent proposals can be marked rejected.");
  await tx.update(proposals).set({ status: "rejected", rejectionReason: reason || null, decidedAt: new Date() }).where(eq(proposals.id, p.id));
  await logActivity(tx, actor, { type: "proposal", direction: "inbound", subject: `${p.number} rejected`, body: reason, opportunityId: p.opportunityId, accountId: p.accountId, relatedType: "proposal", relatedId: p.id });
  await audit(tx, actor, { action: "proposal.rejected", entityType: "proposal", entityId: p.id, summary: `${p.number} rejected: ${reason}` });
}

/** Job: sent proposals past validUntil become expired (idempotent). */
export async function expireProposals(tx: Tx, actor: Actor) {
  const today = await agencyToday(tx);
  const rows = await tx.update(proposals).set({ status: "expired" }).where(and(eq(proposals.status, "sent"), lt(proposals.validUntil, today))).returning();
  for (const p of rows) {
    await logActivity(tx, actor, { type: "proposal", subject: `${p.number} expired (valid until ${p.validUntil})`, opportunityId: p.opportunityId, accountId: p.accountId, relatedType: "proposal", relatedId: p.id, source: "system" });
  }
  return rows.length;
}

/** Move an open opportunity forward to a stage key, never backwards. */
async function advanceStageTo(tx: Tx, actor: Actor, opportunityId: string, stageKey: string) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp || opp.status !== "open") return;
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, opp.pipelineId));
  const target = stages.find((s) => s.key === stageKey);
  const current = stages.find((s) => s.id === opp.stageId);
  if (!target || !current || target.sortOrder <= current.sortOrder) return;
  await moveOpportunityStage(tx, actor, opportunityId, target.id, "Advanced automatically by proposal workflow");
}

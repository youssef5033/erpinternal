import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  engagements,
  opportunities,
  opportunityContacts,
  opportunityServices,
  opportunityStageHistory,
  pipelineStages,
  type PricingModel,
} from "@/db/schema";
import { toMoney } from "@/lib/money";
import type { Actor } from "../auth/actor";
import { assertCrmWrite } from "../auth/scope";
import { audit, diff } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";
import { getDefaultPipeline } from "../system/settings";
import { logActivity } from "./activities";
import { setAccountLifecycle } from "./accounts";

export type OpportunityInput = {
  name: string;
  accountId: string;
  primaryContactId?: string | null;
  contactIds?: string[];
  pipelineId?: string | null;
  stageId?: string | null;
  kind?: "new_business" | "renewal" | "expansion";
  ownerId?: string | null;
  businessProblem?: string | null;
  desiredOutcome?: string | null;
  scopeSummary?: string | null;
  discoveryNotes?: string | null;
  value: string;
  currency: string;
  pricingModel: PricingModel;
  probabilityOverride?: number | null;
  expectedCloseDate?: string | null;
  acquisitionChannel?: string | null;
  campaignId?: string | null;
  sourceLeadId?: string | null;
  nextAction?: string | null;
  nextActionDate?: string | null;
  objections?: string | null;
  competitors?: string | null;
  serviceIds?: string[];
  offerIds?: Record<string, string | null>;
  parentEngagementId?: string | null;
  customFields?: Record<string, unknown>;
};

function baseValues(input: OpportunityInput) {
  if (!input.name?.trim()) throw new ValidationError("Opportunity name is required.", { name: "Required" });
  if (!input.currency || input.currency.length !== 3) throw new ValidationError("Currency is required.", { currency: "Required" });
  if (input.probabilityOverride != null && (input.probabilityOverride < 0 || input.probabilityOverride > 100)) {
    throw new ValidationError("Probability must be between 0 and 100.");
  }
  return {
    name: input.name.trim(),
    accountId: input.accountId,
    primaryContactId: input.primaryContactId || null,
    kind: input.kind ?? "new_business",
    ownerId: input.ownerId || null,
    businessProblem: input.businessProblem || null,
    desiredOutcome: input.desiredOutcome || null,
    scopeSummary: input.scopeSummary || null,
    discoveryNotes: input.discoveryNotes || null,
    value: toMoney(input.value || "0"),
    currency: input.currency.toUpperCase(),
    pricingModel: input.pricingModel,
    probabilityOverride: input.probabilityOverride ?? null,
    expectedCloseDate: input.expectedCloseDate || null,
    acquisitionChannel: input.acquisitionChannel || null,
    campaignId: input.campaignId || null,
    nextAction: input.nextAction || null,
    nextActionDate: input.nextActionDate || null,
    objections: input.objections || null,
    competitors: input.competitors || null,
    parentEngagementId: input.parentEngagementId || null,
    customFields: input.customFields ?? {},
  };
}

async function writeServicesAndContacts(tx: Tx, oppId: string, input: OpportunityInput) {
  if (input.serviceIds) {
    await tx.delete(opportunityServices).where(eq(opportunityServices.opportunityId, oppId));
    if (input.serviceIds.length) {
      await tx
        .insert(opportunityServices)
        .values(input.serviceIds.map((serviceId) => ({ opportunityId: oppId, serviceId, offerId: input.offerIds?.[serviceId] || null })))
        .onConflictDoNothing();
    }
  }
  const contactIds = Array.from(new Set([...(input.contactIds ?? []), ...(input.primaryContactId ? [input.primaryContactId] : [])]));
  if (input.contactIds) {
    await tx.delete(opportunityContacts).where(eq(opportunityContacts.opportunityId, oppId));
  }
  if (contactIds.length) {
    await tx.insert(opportunityContacts).values(contactIds.map((contactId) => ({ opportunityId: oppId, contactId }))).onConflictDoNothing();
  }
}

export async function createOpportunity(tx: Tx, actor: Actor, input: OpportunityInput) {
  assertCrmWrite(actor, input.ownerId ?? actor.userId);
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, input.accountId));
  if (!acc) throw new NotFoundError("Account");
  let pipelineId = input.pipelineId;
  let stageId = input.stageId;
  if (!pipelineId || !stageId) {
    const { pipeline, stages } = await getDefaultPipeline(tx);
    pipelineId = pipeline.id;
    stageId = stages.find((s) => s.kind === "open")!.id;
  }
  const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, stageId));
  if (!stage || stage.pipelineId !== pipelineId) throw new ValidationError("Stage does not belong to the pipeline.");
  if (stage.kind !== "open") throw new ValidationError("New opportunities must start in an open stage; mark them won or lost afterwards.");
  const number = await nextNumber(tx, "opportunity");
  const [opp] = await tx
    .insert(opportunities)
    .values({
      ...baseValues(input),
      number,
      ownerId: input.ownerId || acc.ownerId || actor.userId || null,
      pipelineId,
      stageId,
      sourceLeadId: input.sourceLeadId || null,
      acquisitionChannel: input.acquisitionChannel || acc.acquisitionChannel || null,
    })
    .returning();
  await writeServicesAndContacts(tx, opp.id, input);
  await tx.insert(opportunityStageHistory).values({ opportunityId: opp.id, fromStageId: null, toStageId: stageId, changedBy: actor.userId || null, note: "Created" });
  await logActivity(tx, actor, { type: "stage_change", subject: `Opportunity created in "${stage.name}"`, opportunityId: opp.id, accountId: opp.accountId, source: "system" });
  await audit(tx, actor, { action: "opportunity.created", entityType: "opportunity", entityId: opp.id, summary: `Created ${number} ${opp.name} (${opp.currency} ${opp.value})` });
  if (acc.lifecycleStatus === "former") await setAccountLifecycle(tx, actor, acc.id, "prospect", "New opportunity");
  return opp;
}

export async function updateOpportunity(tx: Tx, actor: Actor, id: string, input: OpportunityInput) {
  const [before] = await tx.select().from(opportunities).where(eq(opportunities.id, id)).for("update");
  if (!before) throw new NotFoundError("Opportunity");
  assertCrmWrite(actor, before.ownerId);
  const values = baseValues({ ...input, accountId: before.accountId });
  const [after] = await tx.update(opportunities).set(values).where(eq(opportunities.id, id)).returning();
  await writeServicesAndContacts(tx, id, input);
  const changes = diff(before, after, ["name", "value", "currency", "pricingModel", "ownerId", "expectedCloseDate", "probabilityOverride", "nextAction", "nextActionDate"]);
  if (Object.keys(changes).length) {
    await audit(tx, actor, { action: "opportunity.updated", entityType: "opportunity", entityId: id, summary: `Updated ${after.number}`, changes });
    if (changes.ownerId) await logActivity(tx, actor, { type: "system", subject: "Opportunity owner changed", opportunityId: id, accountId: after.accountId, source: "system" });
  }
  return after;
}

export async function setNextAction(tx: Tx, actor: Actor, id: string, nextAction: string, nextActionDate: string | null) {
  const [before] = await tx.select().from(opportunities).where(eq(opportunities.id, id));
  if (!before) throw new NotFoundError("Opportunity");
  assertCrmWrite(actor, before.ownerId);
  await tx.update(opportunities).set({ nextAction: nextAction || null, nextActionDate: nextActionDate || null }).where(eq(opportunities.id, id));
  await audit(tx, actor, { action: "opportunity.next_action", entityType: "opportunity", entityId: id, summary: `Next action: ${nextAction}`, changes: diff(before, { nextAction, nextActionDate }, ["nextAction", "nextActionDate"]) });
}

async function recordStageChange(tx: Tx, actor: Actor, opp: typeof opportunities.$inferSelect, toStageId: string, note?: string | null) {
  const seconds = Math.max(0, Math.round((Date.now() - opp.stageEnteredAt.getTime()) / 1000));
  await tx.insert(opportunityStageHistory).values({ opportunityId: opp.id, fromStageId: opp.stageId, toStageId, secondsInPreviousStage: seconds, changedBy: actor.userId || null, note: note || null });
}

/** Move between OPEN stages (won/lost use markWon/markLost). */
export async function moveOpportunityStage(tx: Tx, actor: Actor, id: string, stageId: string, note?: string | null) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, id)).for("update");
  if (!opp) throw new NotFoundError("Opportunity");
  assertCrmWrite(actor, opp.ownerId);
  if (opp.stageId === stageId) return opp;
  const [to] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, stageId));
  if (!to || to.pipelineId !== opp.pipelineId) throw new ValidationError("Stage does not belong to this pipeline.");
  if (to.kind === "won") throw new ValidationError("Use “Mark won” so the handover can be reviewed.");
  if (to.kind === "lost") throw new ValidationError("Use “Mark lost” and record a reason.");
  const [from] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, opp.stageId));
  await recordStageChange(tx, actor, opp, stageId, note);
  const [after] = await tx
    .update(opportunities)
    .set({ stageId, stageEnteredAt: new Date(), status: "open", wonAt: null, lostAt: null })
    .where(eq(opportunities.id, id))
    .returning();
  await logActivity(tx, actor, { type: "stage_change", subject: `Stage: ${from?.name ?? "?"} → ${to.name}`, body: note ?? null, opportunityId: id, accountId: opp.accountId, source: "system" });
  await audit(tx, actor, { action: "opportunity.stage_changed", entityType: "opportunity", entityId: id, summary: `${opp.number}: ${from?.name} → ${to.name}`, changes: { stageId: { from: opp.stageId, to: stageId } } });
  return after;
}

/**
 * Mark won. This records a BOOKING only: it does not create revenue, invoices
 * or cash. The handover (src/server/crm/handover.ts) creates the engagement.
 */
export async function markOpportunityWon(tx: Tx, actor: Actor, id: string, input: { closedValue?: string | null; note?: string | null } = {}) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, id)).for("update");
  if (!opp) throw new NotFoundError("Opportunity");
  assertCrmWrite(actor, opp.ownerId);
  if (opp.status === "won") return opp;
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, opp.pipelineId)).orderBy(asc(pipelineStages.sortOrder));
  const won = stages.find((s) => s.kind === "won");
  if (!won) throw new ValidationError("This pipeline has no Won stage.");
  await recordStageChange(tx, actor, opp, won.id, input.note);
  const [after] = await tx
    .update(opportunities)
    .set({ status: "won", stageId: won.id, stageEnteredAt: new Date(), wonAt: new Date(), lostAt: null, closedValue: toMoney(input.closedValue || opp.value), nextAction: null, nextActionDate: null })
    .where(eq(opportunities.id, id))
    .returning();
  await logActivity(tx, actor, { type: "stage_change", subject: `Won — ${opp.currency} ${after.closedValue} booked`, body: input.note ?? null, opportunityId: id, accountId: opp.accountId, source: "system" });
  await audit(tx, actor, { action: "opportunity.won", entityType: "opportunity", entityId: id, summary: `${opp.number} marked won`, changes: { closedValue: after.closedValue } });
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, opp.accountId));
  if (acc && (acc.lifecycleStatus === "prospect" || acc.lifecycleStatus === "former")) await setAccountLifecycle(tx, actor, acc.id, "onboarding", `${opp.number} won`);
  return after;
}

export async function markOpportunityLost(tx: Tx, actor: Actor, id: string, input: { lostReason: string; lostNotes?: string | null }) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, id)).for("update");
  if (!opp) throw new NotFoundError("Opportunity");
  assertCrmWrite(actor, opp.ownerId);
  if (!input.lostReason?.trim()) throw new ValidationError("A lost reason is required.", { lostReason: "Required" });
  const [eng] = await tx.select({ id: engagements.id }).from(engagements).where(eq(engagements.opportunityId, id));
  if (eng) throw new ValidationError("This opportunity already has an engagement; close the engagement instead.");
  const lost = (await tx.select().from(pipelineStages).where(and(eq(pipelineStages.pipelineId, opp.pipelineId), eq(pipelineStages.kind, "lost"))))[0];
  if (!lost) throw new ValidationError("This pipeline has no Lost stage.");
  await recordStageChange(tx, actor, opp, lost.id, input.lostReason);
  const [after] = await tx
    .update(opportunities)
    .set({ status: "lost", stageId: lost.id, stageEnteredAt: new Date(), lostAt: new Date(), wonAt: null, lostReason: input.lostReason, lostNotes: input.lostNotes || null, nextAction: null, nextActionDate: null })
    .where(eq(opportunities.id, id))
    .returning();
  await logActivity(tx, actor, { type: "stage_change", subject: `Lost — ${input.lostReason}`, body: input.lostNotes ?? null, opportunityId: id, accountId: opp.accountId, source: "system" });
  await audit(tx, actor, { action: "opportunity.lost", entityType: "opportunity", entityId: id, summary: `${opp.number} marked lost: ${input.lostReason}` });
  return after;
}

export async function reopenOpportunity(tx: Tx, actor: Actor, id: string, stageId: string) {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, id)).for("update");
  if (!opp) throw new NotFoundError("Opportunity");
  const [eng] = await tx.select({ id: engagements.id }).from(engagements).where(eq(engagements.opportunityId, id));
  if (eng) throw new ValidationError("A handed-over opportunity cannot be reopened.");
  const [to] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, stageId));
  if (!to || to.kind !== "open") throw new ValidationError("Choose an open stage.");
  await recordStageChange(tx, actor, opp, stageId, "Reopened");
  await tx.update(opportunities).set({ status: "open", stageId, stageEnteredAt: new Date(), wonAt: null, lostAt: null, closedValue: null }).where(eq(opportunities.id, id));
  await logActivity(tx, actor, { type: "stage_change", subject: `Reopened in "${to.name}"`, opportunityId: id, accountId: opp.accountId, source: "system" });
  await audit(tx, actor, { action: "opportunity.reopened", entityType: "opportunity", entityId: id, summary: `${opp.number} reopened` });
}

/** Effective probability: override, else stage default. */
export function effectiveProbability(stageProbability: number, override: number | null | undefined) {
  return override ?? stageProbability;
}

import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  billingScheduleItems,
  contacts,
  contracts,
  documents,
  engagements,
  opportunities,
  opportunityContacts,
  opportunityServices,
  proposalAcceptances,
  proposalVersions,
  proposals,
  services,
  type PaymentScheduleItem,
} from "@/db/schema";
import { addDaysISO, addMonthsISO } from "@/lib/dates";
import { allocateProportionally, d, toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { agencyToday } from "../system/settings";
import { createDeliverable, createEngagement, createMilestone, defaultRecognitionMethod, defineScope, setEngagementMembers } from "../delivery/engagements";
import { createTask } from "../delivery/tasks";
import { logActivity } from "./activities";

const ONBOARDING_COMMON = [
  { title: "Send welcome note and kickoff agenda", offset: 1 },
  { title: "Schedule kickoff meeting", offset: 2 },
  { title: "Review accepted scope, exclusions and assumptions with the delivery team", offset: 2 },
  { title: "Set up shared workspace and client access", offset: 3 },
  { title: "Confirm billing contact, PO and invoicing requirements", offset: 3 },
];
const ONBOARDING_BY_KIND: Record<string, { title: string; offset: number }[]> = {
  creative: [
    { title: "Collect brand assets and guidelines", offset: 5 },
    { title: "Complete the creative brief", offset: 7 },
  ],
  advisory: [
    { title: "Send data request list", offset: 3 },
    { title: "Agree workstreams, hypotheses and decision owners", offset: 7 },
  ],
  executive: [
    { title: "Schedule executive profile interview", offset: 4 },
    { title: "Agree audiences, tone and messaging pillars", offset: 7 },
  ],
};

export type HandoverBillingItem = { label: string; plannedDate: string | null; amount: string; milestone?: string | null; isDeposit?: boolean };

export type HandoverPlan = {
  opportunityId: string;
  existingEngagement: { id: string; number: string } | null;
  account: { id: string; name: string };
  contacts: { id: string; fullName: string; role: string | null }[];
  acceptedVersion: { id: string; proposalNumber: string; versionNumber: number; total: string; currency: string } | null;
  acceptance: { acceptedByName: string; acceptedAt: string; method: string } | null;
  contractsToLink: { id: string; number: string; title: string; status: string }[];
  engagement: {
    name: string;
    serviceId: string;
    offerId: string | null;
    billingModel: "fixed" | "retainer" | "milestone" | "hourly";
    recognitionMethod: string;
    ownerId: string | null;
    primaryContactId: string | null;
    startDate: string;
    endDate: string | null;
    currency: string;
    contractValue: string;
    hourlyRate: string | null;
    retainerAmount: string | null;
    retainerPeriodMonths: number | null;
    budgetHours: string | null;
  };
  scope: { inScope: string | null; exclusions: string | null; assumptions: string | null; summary: string | null; discoveryNotes: string | null };
  deliverables: { name: string; dueDate: string | null; milestone: string | null }[];
  milestones: { name: string; dueDate: string | null; billingAmount: string | null }[];
  onboardingTasks: { title: string; dueDate: string }[];
  billingSchedule: HandoverBillingItem[];
  warnings: string[];
};

function scheduleToBilling(schedule: PaymentScheduleItem[], total: string, start: string, model: string): HandoverBillingItem[] {
  if (model === "retainer" || !schedule.length) return [];
  const usesPercent = schedule.some((s) => s.percent);
  const amounts = usesPercent ? allocateProportionally(total, schedule.map((s) => s.percent ?? "0")) : schedule.map((s) => toMoney(s.amount));
  return schedule.map((s, i) => ({
    label: s.label,
    plannedDate: s.milestone ? null : addDaysISO(start, s.dueAfterDays ?? 0),
    amount: amounts[i],
    milestone: s.milestone ?? null,
    isDeposit: i === 0 && (s.dueAfterDays ?? 0) === 0 && !s.milestone,
  }));
}

/**
 * Build a reviewable handover plan for a WON opportunity. Nothing is written.
 * Reuses the existing account and contacts; draws scope, deliverables and the
 * payment schedule from the accepted proposal version.
 */
export async function previewHandover(tx: Tx, opportunityId: string): Promise<HandoverPlan> {
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  if (!opp) throw new NotFoundError("Opportunity");
  const [acc] = await tx.select().from(accounts).where(eq(accounts.id, opp.accountId));
  const [existing] = await tx.select({ id: engagements.id, number: engagements.number }).from(engagements).where(eq(engagements.opportunityId, opportunityId));
  const cs = await tx
    .select({ id: contacts.id, fullName: contacts.fullName, role: opportunityContacts.role })
    .from(opportunityContacts)
    .innerJoin(contacts, eq(contacts.id, opportunityContacts.contactId))
    .where(eq(opportunityContacts.opportunityId, opportunityId));
  const svcRows = await tx.select().from(opportunityServices).where(eq(opportunityServices.opportunityId, opportunityId));
  const allServices = await tx.select().from(services);
  const primaryServiceId = svcRows[0]?.serviceId ?? allServices[0]?.id;
  const kind = allServices.find((s) => s.id === primaryServiceId)?.templateKind ?? "creative";
  const warnings: string[] = [];
  if (opp.status !== "won") warnings.push("The opportunity is not marked won yet.");
  if (svcRows.length > 1) warnings.push(`This opportunity covers ${svcRows.length} services. One engagement is created for the primary service; create further engagements on the account for the others if they are delivered separately.`);

  let version: typeof proposalVersions.$inferSelect | null = null;
  let proposalNumber = "";
  if (opp.acceptedProposalVersionId) {
    const [v] = await tx.select().from(proposalVersions).where(eq(proposalVersions.id, opp.acceptedProposalVersionId));
    version = v ?? null;
    if (v) proposalNumber = (await tx.select({ n: proposals.number }).from(proposals).where(eq(proposals.id, v.proposalId)))[0]?.n ?? "";
  } else {
    warnings.push("No accepted proposal is recorded. Scope and billing will be based on the opportunity only.");
  }
  const [acceptance] = version ? await tx.select().from(proposalAcceptances).where(eq(proposalAcceptances.versionId, version.id)) : [];
  const ctrs = await tx.select({ id: contracts.id, number: contracts.number, title: contracts.title, status: contracts.status }).from(contracts).where(and(eq(contracts.opportunityId, opportunityId), isNull(contracts.engagementId)));
  if (!ctrs.length) warnings.push("No contract is linked to this opportunity yet — add one before work starts.");

  const today = await agencyToday(tx);
  const start = version?.startDate ?? today;
  const model = version?.pricingModel ?? opp.pricingModel;
  const months = version?.retainerMonths ?? (model === "retainer" ? 6 : null);
  const total = version?.total ?? opp.closedValue ?? opp.value;
  const retainerAmount = model === "retainer" ? toMoney(months ? d(version ? version.total : total).div(months) : total) : null;
  const end = version?.endDate ?? (model === "retainer" && months ? addDaysISO(addMonthsISO(start, months), -1) : null);

  const deliverables = (version?.deliverables ?? []).map((dl) => ({
    name: dl.name,
    dueDate: dl.dueOffsetDays != null ? addDaysISO(start, dl.dueOffsetDays) : null,
    milestone: dl.milestone ?? null,
  }));
  const billingSchedule = scheduleToBilling(version?.paymentSchedule ?? [], total, start, model);
  const milestoneNames = Array.from(new Set([...deliverables.map((x) => x.milestone), ...billingSchedule.map((b) => b.milestone)].filter((x): x is string => !!x)));
  const milestones = milestoneNames.map((name) => {
    const due = deliverables.filter((x) => x.milestone === name).map((x) => x.dueDate).filter(Boolean).sort().pop() ?? null;
    const bill = billingSchedule.find((b) => b.milestone === name);
    return { name, dueDate: due, billingAmount: bill?.amount ?? null };
  });
  if (model !== "retainer" && model !== "hourly" && !billingSchedule.length) {
    billingSchedule.push({ label: "Project fee", plannedDate: start, amount: toMoney(total) });
    warnings.push("The accepted proposal has no payment schedule; a single billing item was drafted.");
  }

  return {
    opportunityId,
    existingEngagement: existing ?? null,
    account: { id: acc.id, name: acc.name },
    contacts: cs,
    acceptedVersion: version ? { id: version.id, proposalNumber, versionNumber: version.versionNumber, total: version.total, currency: version.currency } : null,
    acceptance: acceptance ? { acceptedByName: acceptance.acceptedByName, acceptedAt: acceptance.acceptedAt, method: acceptance.method } : null,
    contractsToLink: ctrs,
    engagement: {
      name: opp.name,
      serviceId: primaryServiceId!,
      offerId: svcRows[0]?.offerId ?? null,
      billingModel: model,
      recognitionMethod: defaultRecognitionMethod(model, !!version?.estimatedHours),
      ownerId: opp.ownerId,
      primaryContactId: opp.primaryContactId,
      startDate: start,
      endDate: end,
      currency: version?.currency ?? opp.currency,
      contractValue: toMoney(model === "retainer" ? d(retainerAmount).times(months ?? 1) : total),
      hourlyRate: version?.hourlyRate ?? null,
      retainerAmount,
      retainerPeriodMonths: model === "retainer" ? months : null,
      budgetHours: version?.estimatedHours ?? null,
    },
    scope: { inScope: version?.scope ?? opp.scopeSummary, exclusions: version?.exclusions ?? null, assumptions: version?.assumptions ?? null, summary: opp.desiredOutcome, discoveryNotes: opp.discoveryNotes },
    deliverables,
    milestones,
    onboardingTasks: [...ONBOARDING_COMMON, ...(ONBOARDING_BY_KIND[kind] ?? [])].map((t) => ({ title: t.title, dueDate: addDaysISO(start < today ? today : start, t.offset) })),
    billingSchedule,
    warnings,
  };
}

export type HandoverOverrides = {
  name?: string;
  ownerId?: string | null;
  startDate?: string;
  endDate?: string | null;
  budgetHours?: string | null;
  budgetCost?: string | null;
  memberIds?: string[];
  includeTaskTitles?: string[];
  billingSchedule?: HandoverBillingItem[];
};

/**
 * Execute the reviewed handover in one transaction. The opportunity row is
 * locked and a unique index on engagements.opportunity_id guarantees that a
 * double submission can never create two engagements.
 */
export async function executeHandover(tx: Tx, actor: Actor, opportunityId: string, overrides: HandoverOverrides = {}) {
  assertCan(actor, "delivery.write");
  const [opp] = await tx.select().from(opportunities).where(eq(opportunities.id, opportunityId)).for("update");
  if (!opp) throw new NotFoundError("Opportunity");
  if (opp.status !== "won") throw new ValidationError("Mark the opportunity won before handing it over.");
  const plan = await previewHandover(tx, opportunityId);
  if (plan.existingEngagement) throw new ConflictError(`Already handed over to ${plan.existingEngagement.number}.`);

  const e = plan.engagement;
  const eng = await createEngagement(
    tx,
    actor,
    {
      name: overrides.name?.trim() || e.name,
      accountId: plan.account.id,
      serviceId: e.serviceId,
      offerId: e.offerId,
      billingModel: e.billingModel,
      ownerId: overrides.ownerId ?? e.ownerId,
      primaryContactId: e.primaryContactId,
      startDate: overrides.startDate || e.startDate,
      endDate: overrides.endDate ?? e.endDate,
      currency: e.currency,
      contractValue: e.contractValue,
      hourlyRate: e.hourlyRate,
      retainerAmount: e.retainerAmount,
      retainerPeriodMonths: e.retainerPeriodMonths,
      budgetHours: overrides.budgetHours ?? e.budgetHours,
      budgetCost: overrides.budgetCost ?? null,
      discoveryNotes: plan.scope.discoveryNotes,
      objectives: plan.scope.summary,
      renewalDate: e.billingModel === "retainer" ? overrides.endDate ?? e.endDate : null,
    },
    { opportunityId, acceptedProposalVersionId: plan.acceptedVersion?.id ?? null },
  );

  await defineScope(
    tx,
    actor,
    eng.id,
    {
      summary: plan.scope.summary,
      inScope: plan.scope.inScope,
      exclusions: plan.scope.exclusions,
      assumptions: plan.scope.assumptions,
      deliverables: plan.deliverables.map((x) => ({ name: x.name })),
      feeAmount: e.contractValue,
      budgetHours: overrides.budgetHours ?? e.budgetHours,
    },
    { type: plan.acceptedVersion ? "proposal" : "manual", id: plan.acceptedVersion?.id ?? null },
  );

  const milestoneIds = new Map<string, string>();
  for (const m of plan.milestones) {
    const row = await createMilestone(tx, actor, eng.id, { name: m.name, dueDate: m.dueDate, billable: !!m.billingAmount, billingAmount: m.billingAmount });
    milestoneIds.set(m.name, row.id);
  }
  for (const dl of plan.deliverables) {
    await createDeliverable(tx, actor, eng.id, { name: dl.name, dueDate: dl.dueDate, milestoneId: dl.milestone ? milestoneIds.get(dl.milestone) ?? null : null });
  }

  const include = overrides.includeTaskTitles;
  for (const [i, t] of plan.onboardingTasks.entries()) {
    if (include && !include.includes(t.title)) continue;
    await createTask(tx, actor, {
      title: t.title,
      kind: "onboarding",
      module: "delivery",
      ownerId: overrides.ownerId ?? eng.ownerId,
      dueDate: t.dueDate,
      engagementId: eng.id,
      accountId: eng.accountId,
      opportunityId,
      priority: i < 2 ? "high" : "medium",
      generationKey: `handover:${opportunityId}:${i}`,
    });
  }

  const billing = overrides.billingSchedule ?? plan.billingSchedule;
  if (e.billingModel !== "retainer") {
    const totalBilled = billing.reduce((acc, b) => acc.plus(d(b.amount)), d(0));
    if (billing.length && !totalBilled.equals(d(e.contractValue)) && e.billingModel !== "hourly") {
      throw new ValidationError(`Billing schedule totals ${totalBilled.toFixed(2)} but the contract value is ${e.contractValue}.`);
    }
    for (const [i, b] of billing.entries()) {
      await tx.insert(billingScheduleItems).values({
        engagementId: eng.id,
        label: b.label,
        plannedDate: b.plannedDate,
        amount: toMoney(b.amount),
        currency: eng.currency,
        milestoneId: b.milestone ? milestoneIds.get(b.milestone) ?? null : null,
        status: "draft",
        isDeposit: !!b.isDeposit,
        source: "handover",
        sourceId: opportunityId,
        sourceProposalVersionId: plan.acceptedVersion?.id ?? null,
        generationKey: `handover:${opportunityId}:bill:${i}`,
      });
    }
  }

  if (overrides.memberIds?.length) {
    await setEngagementMembers(tx, actor, eng.id, Array.from(new Set([...(eng.ownerId ? [eng.ownerId] : []), ...overrides.memberIds])).map((userId) => ({ userId, role: userId === eng.ownerId ? "lead" : "contributor" })));
  }

  // Link accepted proposal, its documents and any contracts to the engagement.
  if (plan.contractsToLink.length) {
    await tx.update(contracts).set({ engagementId: eng.id }).where(and(eq(contracts.opportunityId, opportunityId), isNull(contracts.engagementId)));
  }
  await tx.update(documents).set({ engagementId: eng.id }).where(and(eq(documents.opportunityId, opportunityId), isNull(documents.engagementId)));

  await logActivity(tx, actor, {
    type: "handover",
    subject: `Handed over to delivery: ${eng.number}`,
    body: [
      plan.acceptedVersion ? `Accepted proposal ${plan.acceptedVersion.proposalNumber} v${plan.acceptedVersion.versionNumber}` : null,
      `${plan.deliverables.length} deliverables, ${plan.milestones.length} milestones, ${billing.length} billing items drafted`,
    ]
      .filter(Boolean)
      .join("\n"),
    opportunityId,
    accountId: eng.accountId,
    engagementId: eng.id,
    source: "system",
  });
  await audit(tx, actor, { action: "opportunity.handed_over", entityType: "opportunity", entityId: opportunityId, summary: `${opp.number} handed over to ${eng.number}`, changes: { engagementId: eng.id } });
  return eng;
}

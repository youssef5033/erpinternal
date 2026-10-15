"use server";

import { z } from "zod";
import { eq } from "drizzle-orm";
import { f } from "@/lib/formdata";
import { campaigns } from "@/db/schema";
import { runAction, type ActionState } from "./run";
import { addLeadContact, addLeadEvidence, bulkAssignLeads, bulkCreateLeadTasks, bulkTagLeads, changeLeadStatus, convertLead, createLead, mergeLeads, updateLead, type LeadMergeField } from "../crm/leads";
import { commitLeadImport, setImportRowDecision, stageLeadCsv, validateLeadImport } from "../crm/lead-import";
import { archiveAccount, archiveContact, createAccount, createContact, linkContactToAccount, overrideAccountHealth, revokeHealthOverride, setAccountLifecycle, updateAccount, updateContact } from "../crm/accounts";
import { createOpportunity, markOpportunityLost, markOpportunityWon, moveOpportunityStage, reopenOpportunity, setNextAction, updateOpportunity } from "../crm/opportunities";
import { createProposal, decideProposalApproval, markProposalRejected, markProposalSent, recordProposalAcceptance, reviseProposal, submitProposalForApproval, updateProposalDraft } from "../crm/proposals";
import { executeHandover } from "../crm/handover";
import { cancelDraft, enroll, liftSuppression, logReply, markMessageSent, recordOptOut, saveSequence, saveTemplate, setEnrollmentStatus, setSequenceStatus, updateDraft, generateDueDrafts } from "../crm/outreach";
import { completeEvent, scheduleEvent, updateEvent } from "../delivery/events";
import { assertCrmWrite } from "../auth/scope";
import { audit } from "../audit";
import { ValidationError } from "../errors";

/* ---------------- Leads ---------------- */

const leadSchema = z.object({
  companyName: f.str(200),
  website: f.optStr(300),
  industry: f.optStr(100),
  country: f.optStr(100),
  region: f.optStr(100),
  sizeBand: f.optStr(50),
  acquisitionChannel: f.optStr(50),
  acquisitionDetail: f.optStr(300),
  campaignId: f.optId(),
  dateAdded: f.optDate(),
  researchNotes: f.text(),
  observedNeeds: f.text(),
  ownerId: f.userId(),
  nextAction: f.optStr(300),
  nextActionDate: f.optDate(),
  estimatedValue: f.optMoney(),
  currency: f.optStr(3),
  followUpDate: f.optDate(),
  tags: f.optStr(500),
  serviceIds: f.ids(),
  customFields: z.record(z.string(), z.string()).optional(),
  contacts: z.array(z.object({ fullName: f.optStr(200), jobTitle: f.optStr(200), email: f.optStr(300), phone: f.optStr(50), linkedinUrl: f.optStr(300), sourceUrl: f.optStr(500) })).optional(),
  allowDuplicate: f.bool().optional(),
});

function leadInput(d: z.infer<typeof leadSchema>) {
  return {
    ...d,
    tags: d.tags ? d.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
    contacts: (d.contacts ?? []).filter((c) => c.fullName).map((c) => ({ ...c, fullName: c.fullName! })),
    customFields: d.customFields ?? {},
  };
}

export async function createLeadAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "lead.create", schema: leadSchema, run: async ({ actor, tx, data }) => {
    const lead = await createLead(tx, actor, leadInput(data), { allowDuplicate: !!data.allowDuplicate });
    return { ref: lead.id, redirectTo: `/crm/leads/${lead.id}` };
  } });
}

export async function updateLeadAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "lead.update", schema: leadSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    const { contacts: _c, ...rest } = leadInput(data);
    await updateLead(tx, actor, data.id, { ...rest, contacts: undefined });
    return { redirectTo: `/crm/leads/${data.id}` };
  } });
}

export async function leadStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "lead.status", schema: z.object({ id: f.id(), status: f.enumOf(["new", "researching", "qualified", "nurture", "disqualified"] as const), note: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    await changeLeadStatus(tx, actor, data.id, data.status, data.note);
    return `Qualification status: ${data.status}.`;
  } });
}

export async function leadEvidenceAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "lead.evidence", schema: z.object({ id: f.id(), kind: f.enumOf(["note", "source", "need", "signal"] as const), content: f.str(5000), url: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    await addLeadEvidence(tx, actor, data.id, data);
    return "Added to research.";
  } });
}

export async function leadContactAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "lead.contact", schema: z.object({ id: f.id(), fullName: f.str(200), jobTitle: f.optStr(200), email: f.optStr(300), phone: f.optStr(50), linkedinUrl: f.optStr(300), sourceUrl: f.optStr(500) }), run: async ({ actor, tx, data }) => {
    await addLeadContact(tx, actor, data.id, data);
    return "Contact added.";
  } });
}

export async function bulkLeadsAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "lead.bulk",
    schema: z.object({ ids: f.ids(), op: f.enumOf(["assign", "tag", "untag", "task"] as const), ownerId: f.userId(), tag: f.optStr(50), title: f.optStr(200), dueDate: f.optDate() }),
    run: async ({ actor, tx, data }) => {
      if (!data.ids.length) throw new ValidationError("Select at least one lead.");
      if (data.op === "assign") {
        if (!data.ownerId) throw new ValidationError("Choose an owner.");
        return `Assigned ${await bulkAssignLeads(tx, actor, data.ids, data.ownerId)} leads.`;
      }
      if (data.op === "tag" || data.op === "untag") {
        if (!data.tag) throw new ValidationError("Enter a tag.");
        return `Updated tags on ${await bulkTagLeads(tx, actor, data.ids, data.tag, data.op === "untag")} leads.`;
      }
      if (!data.title) throw new ValidationError("Enter a task title.");
      return `Created ${await bulkCreateLeadTasks(tx, actor, data.ids, { title: data.title, dueDate: data.dueDate, ownerId: data.ownerId })} tasks.`;
    },
  });
}

export async function mergeLeadsAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.import", action: "lead.merge", schema: z.object({ sourceId: f.id(), targetId: f.id(), choices: z.record(z.string(), z.enum(["source", "target"])).optional() }), run: async ({ actor, tx, data }) => {
    await mergeLeads(tx, actor, data.sourceId, data.targetId, (data.choices ?? {}) as Partial<Record<LeadMergeField, "source" | "target">>);
    return { redirectTo: `/crm/leads/${data.targetId}` };
  } });
}

export async function convertLeadAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "lead.convert",
    schema: z.object({
      id: f.id(),
      accountId: f.optId(),
      leadContactIds: f.ids(),
      createOpportunity: f.bool(),
      oppName: f.optStr(200),
      value: f.optMoney(),
      currency: f.optStr(3),
      pricingModel: f.enumOf(["fixed", "retainer", "milestone", "hourly"] as const).optional(),
      serviceIds: f.ids(),
      expectedCloseDate: f.optDate(),
    }),
    run: async ({ actor, tx, data }) => {
      const r = await convertLead(tx, actor, data.id, {
        accountId: data.accountId,
        leadContactIds: data.leadContactIds,
        createOpportunity: data.createOpportunity,
        opportunity: data.createOpportunity ? { name: data.oppName ?? "New opportunity", value: data.value ?? "0", currency: data.currency ?? "USD", pricingModel: data.pricingModel ?? "fixed", serviceIds: data.serviceIds, expectedCloseDate: data.expectedCloseDate } : undefined,
      });
      return { ref: r.accountId, redirectTo: r.opportunityId ? `/crm/opportunities/${r.opportunityId}` : `/crm/accounts/${r.accountId}` };
    },
  });
}

export async function stageLeadImportAction(_p: ActionState, fd: FormData) {
  const file = fd.get("file");
  return runAction(fd, { permission: "crm.import", action: "lead.import.stage", schema: z.object({}), run: async ({ actor, tx }) => {
    if (!(file instanceof File) || !file.size) throw new ValidationError("Choose a CSV file.");
    if (file.size > 5 * 1024 * 1024) throw new ValidationError("CSV files must be under 5 MB.");
    if (!file.name.toLowerCase().endsWith(".csv")) throw new ValidationError("Upload a .csv file.");
    const batch = await stageLeadCsv(tx, actor, { fileName: file.name, csv: await file.text() });
    return { ref: batch.id, redirectTo: `/crm/leads/import/${batch.id}` };
  } });
}

export async function validateLeadImportAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.import", action: "lead.import.validate", schema: z.object({ batchId: f.id(), mapping: z.record(z.string(), z.string()).optional() }), run: async ({ actor, tx, data }) => {
    const mapping = Object.fromEntries(Object.entries(data.mapping ?? {}).filter(([, v]) => v));
    const b = await validateLeadImport(tx, actor, data.batchId, mapping);
    return `Validated: ${b.validRows} ready, ${b.duplicateRows} possible duplicates, ${b.errorRows} with errors.`;
  } });
}

export async function importRowDecisionAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.import", action: "lead.import.decision", schema: z.object({ rowId: f.id(), decision: f.enumOf(["import", "skip", "merge"] as const), mergeTargetId: f.optId() }), run: async ({ actor, tx, data }) => {
    await setImportRowDecision(tx, actor, data.rowId, data.decision, data.mergeTargetId);
    return "Updated.";
  } });
}

export async function commitLeadImportAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.import", action: "lead.import.commit", schema: z.object({ batchId: f.id() }), run: async ({ actor, tx, data }) => {
    const r = await commitLeadImport(tx, actor, data.batchId);
    return `Import complete: ${r.created} leads created, ${r.merged} merged into existing leads.`;
  } });
}

/* ---------------- Accounts & contacts ---------------- */

const accountSchema = z.object({
  name: f.str(200),
  website: f.optStr(300),
  industry: f.optStr(100),
  country: f.optStr(100),
  region: f.optStr(100),
  city: f.optStr(100),
  sizeBand: f.optStr(50),
  description: f.text(),
  lifecycleStatus: f.enumOf(["prospect", "onboarding", "active", "former", "partner"] as const).optional(),
  ownerId: f.userId(),
  phone: f.optStr(50),
  billingEmail: f.optStr(300),
  billingAddress: f.text(),
  billingContactName: f.optStr(200),
  taxIdentifier: f.optStr(100),
  paymentTermsDays: f.optInt(),
  defaultCurrency: f.optStr(3),
  acquisitionChannel: f.optStr(50),
  acquisitionDetail: f.optStr(300),
  tags: f.optStr(500),
  allowDuplicate: f.bool().optional(),
});

const accountInput = (d: z.infer<typeof accountSchema>) => ({ ...d, tags: d.tags ? d.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) : [] });

export async function createAccountAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "account.create", schema: accountSchema, run: async ({ actor, tx, data }) => {
    const a = await createAccount(tx, actor, accountInput(data), { allowDuplicate: !!data.allowDuplicate });
    return { ref: a.id, redirectTo: `/crm/accounts/${a.id}` };
  } });
}

export async function updateAccountAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "account.update", schema: accountSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    await updateAccount(tx, actor, data.id, accountInput(data));
    return { redirectTo: `/crm/accounts/${data.id}` };
  } });
}

export async function accountLifecycleAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "account.lifecycle", schema: z.object({ id: f.id(), status: f.enumOf(["prospect", "onboarding", "active", "former", "partner"] as const), reason: f.optStr() }), run: async ({ actor, tx, data }) => {
    await setAccountLifecycle(tx, actor, data.id, data.status, data.reason ?? undefined);
    return "Lifecycle updated.";
  } });
}

export async function archiveAccountAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "account.archive", schema: z.object({ id: f.id(), archived: f.bool() }), run: async ({ actor, tx, data }) => {
    await archiveAccount(tx, actor, data.id, data.archived);
    return data.archived ? "Archived." : "Restored.";
  } });
}

export async function healthOverrideAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "account.health", schema: z.object({ id: f.id(), score: f.int(), reason: f.optStr(1000), expiresAt: f.optDate(), revoke: f.bool().optional() }), run: async ({ actor, tx, data }) => {
    if (data.revoke) await revokeHealthOverride(tx, actor, data.id);
    else await overrideAccountHealth(tx, actor, data.id, data.score, data.reason ?? "", data.expiresAt);
    return "Health override logged.";
  } });
}

const contactSchema = z.object({
  fullName: f.str(200),
  primaryAccountId: f.optId(),
  email: f.optStr(300),
  phone: f.optStr(50),
  jobTitle: f.optStr(200),
  linkedinUrl: f.optStr(300),
  sourceUrl: f.optStr(500),
  preferredChannel: f.enumOf(["email", "phone", "linkedin", "in_person", "other"] as const).optional(),
  buyingRoles: f.ids(),
  relationshipNotes: f.text(),
  ownerId: f.userId(),
  timeZone: f.optStr(64),
  contactRestrictions: f.text(),
  allowDuplicate: f.bool().optional(),
});

export async function createContactAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "contact.create", schema: contactSchema, run: async ({ actor, tx, data }) => {
    const c = await createContact(tx, actor, data, { allowDuplicate: !!data.allowDuplicate });
    return { ref: c.id, redirectTo: `/crm/contacts/${c.id}` };
  } });
}

export async function updateContactAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "contact.update", schema: contactSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    await updateContact(tx, actor, data.id, data);
    return { redirectTo: `/crm/contacts/${data.id}` };
  } });
}

export async function archiveContactAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "contact.archive", schema: z.object({ id: f.id(), archived: f.bool() }), run: async ({ actor, tx, data }) => {
    await archiveContact(tx, actor, data.id, data.archived);
    return data.archived ? "Archived." : "Restored.";
  } });
}

export async function linkContactAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "contact.link", schema: z.object({ id: f.id(), accountId: f.id(), relationship: f.optStr(200) }), run: async ({ actor, tx, data }) => {
    await linkContactToAccount(tx, actor, data.id, data.accountId, data.relationship);
    return "Linked.";
  } });
}

export async function optOutAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "contact.optout", schema: z.object({ contactId: f.optId(), leadContactId: f.optId(), email: f.optStr(300), channel: f.optStr(30), reason: f.enumOf(["opt_out", "bounce", "complaint", "manual", "legal"] as const).optional(), note: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    const r = await recordOptOut(tx, actor, { ...data, channel: data.channel ?? "all", reason: data.reason ?? "opt_out" });
    return `Opt-out recorded. ${r.stoppedEnrollments} active sequence(s) stopped; future outreach is blocked.`;
  } });
}

export async function liftSuppressionAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "outreach.send", action: "suppression.lift", schema: z.object({ id: f.id(), note: f.str(1000) }), run: async ({ actor, tx, data }) => {
    await liftSuppression(tx, actor, data.id, data.note);
    return "Suppression lifted and logged.";
  } });
}

/* ---------------- Opportunities ---------------- */

const oppSchema = z.object({
  name: f.str(200),
  accountId: f.id(),
  primaryContactId: f.optId(),
  contactIds: f.ids(),
  kind: f.enumOf(["new_business", "renewal", "expansion"] as const).optional(),
  ownerId: f.userId(),
  businessProblem: f.text(),
  desiredOutcome: f.text(),
  scopeSummary: f.text(),
  discoveryNotes: f.text(),
  value: f.money(),
  currency: f.currency(),
  pricingModel: f.enumOf(["fixed", "retainer", "milestone", "hourly"] as const),
  probabilityOverride: f.optInt(),
  expectedCloseDate: f.optDate(),
  acquisitionChannel: f.optStr(50),
  campaignId: f.optId(),
  nextAction: f.optStr(300),
  nextActionDate: f.optDate(),
  objections: f.text(),
  competitors: f.optStr(500),
  serviceIds: f.ids(),
  parentEngagementId: f.optId(),
  stageId: f.optId(),
});

export async function createOpportunityAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.create", schema: oppSchema, run: async ({ actor, tx, data }) => {
    const o = await createOpportunity(tx, actor, data);
    return { ref: o.id, redirectTo: `/crm/opportunities/${o.id}` };
  } });
}

export async function updateOpportunityAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.update", schema: oppSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    await updateOpportunity(tx, actor, data.id, data);
    return { redirectTo: `/crm/opportunities/${data.id}` };
  } });
}

export async function opportunityStageAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.stage", schema: z.object({ id: f.id(), stageId: f.id(), note: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    await moveOpportunityStage(tx, actor, data.id, data.stageId, data.note);
    return "Stage updated.";
  } });
}

export async function opportunityNextActionAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.next", schema: z.object({ id: f.id(), nextAction: f.str(300), nextActionDate: f.optDate() }), run: async ({ actor, tx, data }) => {
    await setNextAction(tx, actor, data.id, data.nextAction, data.nextActionDate);
    return "Next action set.";
  } });
}

export async function opportunityWonAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.won", schema: z.object({ id: f.id(), closedValue: f.optMoney(), note: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    await markOpportunityWon(tx, actor, data.id, data);
    return { redirectTo: `/crm/opportunities/${data.id}/handover` };
  } });
}

export async function opportunityLostAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.lost", schema: z.object({ id: f.id(), lostReason: f.str(200), lostNotes: f.text() }), run: async ({ actor, tx, data }) => {
    await markOpportunityLost(tx, actor, data.id, data);
    return "Marked lost.";
  } });
}

export async function opportunityReopenAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "opportunity.reopen", schema: z.object({ id: f.id(), stageId: f.id() }), run: async ({ actor, tx, data }) => {
    await reopenOpportunity(tx, actor, data.id, data.stageId);
    return "Reopened.";
  } });
}

export async function handoverAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "opportunity.handover",
    schema: z.object({
      id: f.id(),
      name: f.str(200),
      ownerId: f.userId(),
      startDate: f.date(),
      endDate: f.optDate(),
      budgetHours: f.optDecimal(),
      budgetCost: f.optMoney(),
      memberIds: f.ids(),
      includeTaskTitles: f.ids(),
      billing: z.array(z.object({ label: f.str(200), plannedDate: f.optDate(), amount: f.money(), milestone: f.optStr(200), isDeposit: f.bool().optional() })).optional(),
    }),
    run: async ({ actor, tx, data }) => {
      const eng = await executeHandover(tx, actor, data.id, { ...data, billingSchedule: data.billing ?? undefined });
      return { ref: eng.id, redirectTo: `/delivery/engagements/${eng.id}` };
    },
  });
}

/* ---------------- Proposals ---------------- */

const proposalContent = z.object({
  introduction: f.text(),
  scope: f.text(),
  exclusions: f.text(),
  assumptions: f.text(),
  timeline: f.text(),
  terms: f.text(),
  startDate: f.optDate(),
  endDate: f.optDate(),
  pricingModel: f.enumOf(["fixed", "retainer", "milestone", "hourly"] as const),
  currency: f.currency(),
  discountPercent: f.optDecimal(),
  taxRateId: f.optId(),
  hourlyRate: f.optMoney(),
  estimatedHours: f.optDecimal(),
  retainerMonths: f.optInt(),
  lines: z.array(z.object({ description: f.optStr(500), quantity: f.optDecimal(), unitPrice: f.optMoney() })).optional(),
  deliverables: z.array(z.object({ name: f.optStr(300), description: f.optStr(1000), dueOffsetDays: f.optInt(), milestone: f.optStr(200) })).optional(),
  schedule: z.array(z.object({ label: f.optStr(200), percent: f.optDecimal(), amount: f.optMoney(), dueAfterDays: f.optInt(), milestone: f.optStr(200) })).optional(),
  changeSummary: f.optStr(500),
});

function toContent(d: z.infer<typeof proposalContent>) {
  return {
    ...d,
    lines: (d.lines ?? []).filter((l) => l.description).map((l) => ({ description: l.description!, quantity: l.quantity ?? "1", unitPrice: l.unitPrice ?? "0" })),
    deliverables: (d.deliverables ?? []).filter((x) => x.name).map((x) => ({ name: x.name!, description: x.description ?? undefined, dueOffsetDays: x.dueOffsetDays ?? undefined, milestone: x.milestone ?? undefined })),
    paymentSchedule: (d.schedule ?? []).filter((x) => x.label).map((x) => ({ label: x.label!, percent: x.percent, amount: x.amount, dueAfterDays: x.dueAfterDays, milestone: x.milestone })),
  };
}

export async function createProposalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "proposal.create", schema: z.object({ opportunityId: f.id(), title: f.str(300), templateId: f.optId(), validUntil: f.optDate() }), run: async ({ actor, tx, data }) => {
    const p = await createProposal(tx, actor, data);
    return { ref: p.id, redirectTo: `/crm/proposals/${p.id}` };
  } });
}

export async function updateProposalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "proposal.update", schema: proposalContent.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    await updateProposalDraft(tx, actor, data.id, toContent(data));
    return "Draft saved.";
  } });
}

export async function proposalWorkflowAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "proposal.workflow",
    schema: z.object({ id: f.id(), op: f.enumOf(["submit", "approve", "return", "sent", "revise", "reject"] as const), note: f.optStr(2000), sentOn: f.optDate() }),
    run: async ({ actor, tx, data }) => {
      switch (data.op) {
        case "submit":
          await submitProposalForApproval(tx, actor, data.id);
          return "Submitted for internal approval. The version is now locked.";
        case "approve":
          await decideProposalApproval(tx, actor, data.id, "approved", data.note);
          return "Approved internally.";
        case "return":
          await decideProposalApproval(tx, actor, data.id, "rejected", data.note);
          return "Returned for changes.";
        case "sent":
          await markProposalSent(tx, actor, data.id, data.sentOn);
          return "Recorded as sent to the client.";
        case "revise":
          await reviseProposal(tx, actor, data.id, data.note ?? "Revision");
          return "New version created.";
        case "reject":
          await markProposalRejected(tx, actor, data.id, data.note ?? "");
          return "Marked rejected by client.";
      }
    },
  });
}

export async function proposalAcceptAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "proposal.accept",
    schema: z.object({ id: f.id(), acceptedAt: f.date(), acceptedByName: f.str(200), acceptedByContactId: f.optId(), method: f.enumOf(["manual_record", "email_confirmation", "signed_document"] as const), evidenceNote: f.text(), evidenceDocumentId: f.optId() }),
    run: async ({ actor, tx, data }) => {
      await recordProposalAcceptance(tx, actor, data.id, data);
      return "Acceptance recorded. Mark the opportunity won to start the handover.";
    },
  });
}

/* ---------------- Outreach ---------------- */

export async function saveTemplateAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "outreach.template", schema: z.object({ id: f.optId(), name: f.str(200), serviceId: f.optId(), segment: f.optStr(200), channel: f.str(30), subject: f.optStr(300), body: f.str(10000), active: f.bool().optional() }), run: async ({ actor, tx, data }) => {
    await saveTemplate(tx, actor, { ...data, id: data.id ?? undefined, active: data.active ?? true });
    return "Template saved.";
  } });
}

export async function saveSequenceAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "outreach.sequence",
    schema: z.object({ id: f.optId(), name: f.str(200), serviceId: f.optId(), segment: f.optStr(200), description: f.text(), steps: z.array(z.object({ dayOffset: f.optInt(), channel: f.optStr(30), templateId: f.optId(), instructions: f.optStr(1000) })).optional() }),
    run: async ({ actor, tx, data }) => {
      const id = await saveSequence(tx, actor, { ...data, id: data.id ?? undefined, steps: (data.steps ?? []).filter((s) => s.channel).map((s) => ({ dayOffset: s.dayOffset ?? 0, channel: s.channel!, templateId: s.templateId, instructions: s.instructions })) });
      return { ref: id, redirectTo: `/crm/outreach/sequences/${id}` };
    },
  });
}

export async function sequenceStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "outreach.sequence_status", schema: z.object({ id: f.id(), status: f.enumOf(["active", "paused", "archived"] as const) }), run: async ({ actor, tx, data }) => {
    await setSequenceStatus(tx, actor, data.id, data.status);
    return `Sequence ${data.status}.`;
  } });
}

export async function enrollAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "outreach.enroll", schema: z.object({ sequenceId: f.id(), contactId: f.optId(), leadContactId: f.optId() }), run: async ({ actor, tx, data }) => {
    await enroll(tx, actor, data.sequenceId, data);
    await generateDueDrafts(tx, actor);
    return "Enrolled. Drafts appear in the outreach queue when each step is due.";
  } });
}

export async function enrollmentStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "outreach.enrollment", schema: z.object({ id: f.id(), status: f.enumOf(["active", "paused", "stopped"] as const) }), run: async ({ actor, tx, data }) => {
    await setEnrollmentStatus(tx, actor, data.id, data.status);
    return `Enrollment ${data.status}.`;
  } });
}

export async function draftAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "outreach.draft",
    schema: z.object({ id: f.id(), op: f.enumOf(["save", "sent", "cancel"] as const), subject: f.optStr(300), body: f.optStr(20000), note: f.optStr(500) }),
    run: async ({ actor, tx, data }) => {
      if (data.op === "save" || data.op === "sent") if (data.body) await updateDraft(tx, actor, data.id, { subject: data.subject, body: data.body });
      if (data.op === "sent") {
        await markMessageSent(tx, actor, data.id, { note: data.note });
        return "Recorded as sent manually and logged on the timeline.";
      }
      if (data.op === "cancel") {
        await cancelDraft(tx, actor, data.id);
        return "Draft cancelled.";
      }
      return "Draft saved.";
    },
  });
}

export async function logReplyAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "outreach.reply", schema: z.object({ contactId: f.optId(), leadId: f.optId(), leadContactId: f.optId(), channel: f.str(30), subject: f.optStr(300), body: f.text(), sentiment: f.enumOf(["positive", "neutral", "negative", "not_interested", "opt_out"] as const) }), run: async ({ actor, tx, data }) => {
    const r = await logReply(tx, actor, data);
    return `Reply logged. ${r.stoppedEnrollments} sequence(s) stopped.${data.sentiment === "opt_out" ? " Contact suppressed." : ""}`;
  } });
}

export async function saveCampaignAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "crm.write",
    action: "campaign.save",
    schema: z.object({ id: f.optId(), name: f.str(200), channel: f.str(50), targetSegment: f.optStr(300), serviceId: f.optId(), offerId: f.optId(), ownerId: f.userId(), startDate: f.optDate(), endDate: f.optDate(), cost: f.optMoney(), currency: f.optStr(3), status: f.enumOf(["planned", "active", "paused", "completed", "cancelled"] as const), goal: f.optStr(500), outcomeNotes: f.text() }),
    run: async ({ actor, tx, data }) => {
      assertCrmWrite(actor, null);
      if (data.cost && !data.currency) throw new ValidationError("Choose the currency of the cost.");
      const { id, ...values } = data;
      const [row] = id ? await tx.update(campaigns).set(values).where(eq(campaigns.id, id)).returning() : await tx.insert(campaigns).values(values).returning();
      await audit(tx, actor, { action: id ? "campaign.updated" : "campaign.created", entityType: "campaign", entityId: row.id, summary: `Campaign ${row.name}` });
      return { ref: row.id, redirectTo: `/crm/outreach/campaigns/${row.id}` };
    },
  });
}

/* ---------------- Meetings ---------------- */

const eventSchema = z.object({
  kind: f.enumOf(["meeting", "call", "discovery", "account_review", "internal", "workshop"] as const),
  title: f.str(300),
  date: f.date(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM"),
  durationMinutes: f.int(),
  timeZone: f.str(64),
  location: f.optStr(300),
  agenda: f.text(),
  accountId: f.optId(),
  contactId: f.optId(),
  leadId: f.optId(),
  opportunityId: f.optId(),
  engagementId: f.optId(),
  reminderMinutes: f.optInt(),
  attendeeUserIds: f.ids(),
});

function toUtc(date: string, time: string, timeZone: string) {
  // Interpret wall-clock time in the event's time zone.
  const guess = new Date(`${date}T${time}:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  const asTz = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess.getTime() - (asTz - guess.getTime()));
}

export async function scheduleEventAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["crm.write", "delivery.write"], action: "event.schedule", schema: eventSchema, run: async ({ actor, tx, data }) => {
    const startsAt = toUtc(data.date, data.startTime, data.timeZone);
    const ev = await scheduleEvent(tx, actor, { ...data, startsAt, endsAt: new Date(startsAt.getTime() + data.durationMinutes * 60000), attendeeUserIds: Array.from(new Set([actor.userId, ...data.attendeeUserIds])), attendeeContactIds: data.contactId ? [data.contactId] : [] });
    return { ref: ev.id, redirectTo: `/operations/calendar/events/${ev.id}` };
  } });
}

export async function updateEventAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["crm.write", "delivery.write"], action: "event.update", schema: eventSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    const startsAt = toUtc(data.date, data.startTime, data.timeZone);
    await updateEvent(tx, actor, data.id, { ...data, startsAt, endsAt: new Date(startsAt.getTime() + data.durationMinutes * 60000) });
    return "Meeting updated.";
  } });
}

export async function completeEventAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: ["crm.write", "delivery.write"],
    action: "event.complete",
    schema: z.object({ id: f.id(), status: f.enumOf(["completed", "cancelled", "no_show"] as const), notes: f.text(), decisions: f.text(), outcome: f.optStr(200), followUps: z.array(z.object({ title: f.optStr(300), ownerId: f.userId(), dueDate: f.optDate() })).optional() }),
    run: async ({ actor, tx, data }) => {
      await completeEvent(tx, actor, data.id, { ...data, followUps: (data.followUps ?? []).filter((x) => x.title).map((x) => ({ title: x.title!, ownerId: x.ownerId, dueDate: x.dueDate })) });
      return "Outcome recorded and follow-ups created.";
    },
  });
}


export async function generateDraftsAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "crm.write", action: "outreach.generate_drafts", schema: z.object({}), run: async ({ actor, tx }) => {
    const r = await generateDueDrafts(tx, actor);
    return `${r} new draft(s) created for due sequence steps.`;
  } });
}

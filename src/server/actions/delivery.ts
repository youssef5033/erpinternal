"use server";

import { z } from "zod";
import { f } from "@/lib/formdata";
import { runAction, type ActionState } from "./run";
import {
  acceptMilestone,
  approveChangeRequest,
  changeEngagementStatus,
  createChangeRequest,
  createDeliverable,
  createEngagement,
  createMilestone,
  defineScope,
  recordDeliverableReview,
  rejectChangeRequest,
  renewRetainer,
  setEngagementMembers,
  submitDeliverableVersion,
  updateEngagement,
} from "../delivery/engagements";
import { saveContract, setContractStatus } from "../delivery/contracts";
import { saveWorkspaceItem } from "../delivery/templates";
import { approveTimeEntries, logTime, rejectTimeEntries, updateTimeEntry } from "../delivery/time";
import { ValidationError } from "../errors";

const engagementSchema = z.object({
  name: f.str(300),
  accountId: f.id(),
  serviceId: f.id(),
  offerId: f.optId(),
  billingModel: f.enumOf(["fixed", "retainer", "milestone", "hourly"] as const),
  recognitionMethod: f.enumOf(["straight_line", "milestone", "time_and_materials", "percent_complete", "on_completion"] as const).optional().nullable(),
  ownerId: f.userId(),
  primaryContactId: f.optId(),
  startDate: f.optDate(),
  endDate: f.optDate(),
  currency: f.currency(),
  contractValue: f.optMoney(),
  hourlyRate: f.optMoney(),
  retainerAmount: f.optMoney(),
  retainerPeriodMonths: f.optInt(),
  budgetHours: f.optDecimal(),
  budgetCost: f.optMoney(),
  includedRevisions: f.optInt(),
  renewalDate: f.optDate(),
  noticePeriodDays: f.optInt(),
  autoRenew: f.bool().optional(),
  objectives: f.text(),
  discoveryNotes: f.text(),
});

export async function createEngagementAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "engagement.create",
    schema: engagementSchema.extend({ createRetainerBilling: f.bool().optional() }),
    run: async ({ actor, tx, data }) => {
      const { createRetainerBilling, ...input } = data;
      const eng = await createEngagement(tx, actor, input, { createRetainerBilling: createRetainerBilling ?? true });
      return { ref: eng.id, redirectTo: `/delivery/engagements/${eng.id}` };
    },
  });
}

export async function updateEngagementAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "engagement.update",
    schema: engagementSchema.extend({ id: f.id() }),
    run: async ({ actor, tx, data }) => {
      const { id, ...input } = data;
      await updateEngagement(tx, actor, id, input);
      return { ref: id, redirectTo: `/delivery/engagements/${id}` };
    },
  });
}

export async function engagementStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "delivery.write", action: "engagement.status", schema: z.object({ id: f.id(), status: f.enumOf(["onboarding", "active", "on_hold", "completed", "cancelled"] as const), note: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    await changeEngagementStatus(tx, actor, data.id, data.status, data.note);
    return `Engagement is now ${data.status.replace("_", " ")}.`;
  } });
}

export async function engagementMembersAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "engagement.members",
    schema: z.object({ id: f.id(), members: z.array(z.object({ userId: f.userId(), role: f.optStr(100), allocationHoursPerWeek: f.optDecimal() })).optional() }),
    run: async ({ actor, tx, data }) => {
      const members = (data.members ?? []).filter((m): m is { userId: string; role: string | null; allocationHoursPerWeek: string | null } => !!m.userId).map((m) => ({ userId: m.userId, role: m.role ?? undefined, allocationHoursPerWeek: m.allocationHoursPerWeek }));
      await setEngagementMembers(tx, actor, data.id, members);
      return "Team updated.";
    },
  });
}

export async function defineScopeAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "engagement.scope",
    schema: z.object({ id: f.id(), summary: f.text(), inScope: f.text(), exclusions: f.text(), assumptions: f.text(), deliverablesText: f.text(), feeAmount: f.optMoney(), budgetHours: f.optDecimal(), budgetCost: f.optMoney(), endDate: f.optDate() }),
    run: async ({ actor, tx, data }) => {
      const deliverables = (data.deliverablesText ?? "").split("\n").map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
      const v = await defineScope(tx, actor, data.id, { ...data, deliverables });
      return `Scope version ${v.versionNumber} saved.`;
    },
  });
}

export async function createChangeRequestAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "change_request.create",
    schema: z.object({ engagementId: f.id(), title: f.str(300), description: f.text(), proposedChanges: f.str(10000), feeImpact: f.optMoney(), hoursImpact: z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : v), z.string().regex(/^-?\d+(\.\d{1,4})?$/, "Enter a number").optional().nullable()).transform((v) => v ?? null), costImpact: f.optMoney(), deadlineImpactDays: f.optInt(), newEndDate: f.optDate(), requestedByContactId: f.optId() }),
    run: async ({ actor, tx, data }) => {
      const { engagementId, ...input } = data;
      const cr = await createChangeRequest(tx, actor, engagementId, input);
      return `Change request ${cr.number} submitted. Scope, budget and billing change only after it is approved with client evidence.`;
    },
  });
}

export async function decideChangeRequestAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.approve",
    action: "change_request.decide",
    schema: z.object({ id: f.id(), decision: f.enumOf(["approved", "rejected", "withdrawn"] as const), clientApprovalEvidence: f.optStr(2000), clientApprovedByContactId: f.optId(), note: f.optStr(2000) }),
    run: async ({ actor, tx, data }) => {
      if (data.decision === "approved") {
        if (!data.clientApprovalEvidence) throw new ValidationError("Record how the client approved the change.", { clientApprovalEvidence: "Required" });
        await approveChangeRequest(tx, actor, data.id, { clientApprovalEvidence: data.clientApprovalEvidence, clientApprovedByContactId: data.clientApprovedByContactId, decisionNote: data.note });
        return "Approved. A new scope version was created and budget/billing updated.";
      }
      if (!data.note) throw new ValidationError("Give a reason.", { note: "Required" });
      await rejectChangeRequest(tx, actor, data.id, data.decision, data.note);
      return `Change request ${data.decision}.`;
    },
  });
}

export async function createMilestoneAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "delivery.write", action: "milestone.create", schema: z.object({ engagementId: f.id(), name: f.str(300), dueDate: f.optDate(), description: f.text(), billable: f.bool().optional(), billingAmount: f.optMoney() }), run: async ({ actor, tx, data }) => {
    const { engagementId, ...input } = data;
    await createMilestone(tx, actor, engagementId, input);
    return "Milestone added.";
  } });
}

export async function acceptMilestoneAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "delivery.approve", action: "milestone.accept", schema: z.object({ id: f.id(), acceptedAt: f.date(), acceptanceEvidence: f.str(2000), acceptedByContactId: f.optId() }), run: async ({ actor, tx, data }) => {
    await acceptMilestone(tx, actor, data.id, data);
    return "Milestone accepted. Any linked billing item is now ready to invoice.";
  } });
}

export async function createDeliverableAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "delivery.write", action: "deliverable.create", schema: z.object({ engagementId: f.id(), name: f.str(300), description: f.text(), dueDate: f.optDate(), ownerId: f.userId(), milestoneId: f.optId(), deliverableType: f.optStr(100), includedRevisions: f.optInt() }), run: async ({ actor, tx, data }) => {
    const { engagementId, ...input } = data;
    await createDeliverable(tx, actor, engagementId, input);
    return "Deliverable added.";
  } });
}

export async function submitDeliverableAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "delivery.write", action: "deliverable.submit", schema: z.object({ id: f.id(), stage: f.enumOf(["internal", "client"] as const), notes: f.text(), link: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    if (data.link && !/^https?:\/\//i.test(data.link)) throw new ValidationError("Links must start with http(s)://", { link: "Invalid URL" });
    await submitDeliverableVersion(tx, actor, data.id, data);
    return data.stage === "client" ? "Sent for client review (recorded — nothing is emailed)." : "Submitted for internal review.";
  } });
}

export async function reviewDeliverableAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["delivery.write", "delivery.approve"], action: "deliverable.review", schema: z.object({ id: f.id(), decision: f.enumOf(["approved", "changes_requested", "rejected"] as const), feedback: f.text(), evidence: f.optStr(2000), reviewerContactId: f.optId(), reviewerName: f.optStr(200) }), run: async ({ actor, tx, data }) => {
    const r = await recordDeliverableReview(tx, actor, data.id, data);
    void r;
    return "Review recorded.";
  } });
}

export async function renewRetainerAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["delivery.write", "finance.write"], action: "engagement.renew", schema: z.object({ id: f.id(), fee: f.optMoney(), months: f.optInt(), expectedPeriodNumber: f.int() }), run: async ({ actor, tx, data }) => {
    await renewRetainer(tx, actor, data.id, { fee: data.fee, months: data.months, expectedPeriodNumber: data.expectedPeriodNumber });
    return "Retainer renewed: a new period and its billing items were created.";
  } });
}

export async function saveWorkspaceItemAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: "delivery.write",
    action: "workspace.save",
    schema: z.object({ engagementId: f.id(), id: f.optId(), itemType: f.str(60), title: f.str(300), status: f.str(60), dueDate: f.optDate(), scheduledDate: f.optDate(), channel: f.optStr(60), sourceUrl: f.optStr(1000), asNewVersion: f.bool().optional(), data: z.record(z.string(), z.string()).optional() }),
    run: async ({ actor, tx, data }) => {
      const { engagementId, id, data: fields, ...rest } = data;
      const clean = Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ""));
      await saveWorkspaceItem(tx, actor, engagementId, { ...rest, id: id ?? undefined, data: clean });
      return "Saved.";
    },
  });
}

const contractSchema = z.object({
  id: f.optId(),
  title: f.str(300),
  accountId: f.id(),
  engagementId: f.optId(),
  opportunityId: f.optId(),
  contractType: f.enumOf(["msa", "sow", "retainer", "nda", "change_order", "other"] as const),
  startDate: f.optDate(),
  endDate: f.optDate(),
  noticePeriodDays: f.optInt(),
  autoRenew: f.bool().optional(),
  value: f.optMoney(),
  currency: f.optStr(3),
  ownerId: f.userId(),
});

export async function saveContractAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["crm.write", "delivery.write"], action: "contract.save", schema: contractSchema, run: async ({ actor, tx, data }) => {
    const c = await saveContract(tx, actor, data);
    return `Contract ${c.number} saved.`;
  } });
}

export async function contractStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: ["crm.write", "delivery.write"], action: "contract.status", schema: z.object({ id: f.id(), status: f.enumOf(["sent", "signed", "active", "expired", "terminated"] as const), signedAt: f.optDate(), signatureMethod: f.enumOf(["manual_record", "signed_document"] as const).optional().nullable(), signatureEvidence: f.optStr(2000), note: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    await setContractStatus(tx, actor, data.id, data);
    return `Contract marked ${data.status}.`;
  } });
}

const timeSchema = z.object({ personId: f.optId(), workDate: f.date(), hours: f.decimal(), engagementId: f.optId(), taskId: f.optId(), description: f.text(), billable: f.bool().optional() });

export async function logTimeAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "time.write", action: "time.log", schema: timeSchema, run: async ({ actor, tx, data }) => {
    await logTime(tx, actor, { ...data, billable: data.billable ?? true });
    return `${data.hours}h logged for ${data.workDate}.`;
  } });
}

export async function updateTimeAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "time.write", action: "time.update", schema: timeSchema.extend({ id: f.id() }), run: async ({ actor, tx, data }) => {
    const { id, ...input } = data;
    await updateTimeEntry(tx, actor, id, { ...input, billable: input.billable ?? false });
    return "Time entry updated.";
  } });
}

export async function approveTimeAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "time.approve", action: "time.approve", schema: z.object({ ids: f.ids(), decision: f.enumOf(["approve", "reject"] as const), reason: f.optStr(1000) }), run: async ({ actor, tx, data }) => {
    if (!data.ids.length) throw new ValidationError("Select at least one entry.");
    if (data.decision === "approve") {
      await approveTimeEntries(tx, actor, data.ids);
      return `${data.ids.length} entr${data.ids.length === 1 ? "y" : "ies"} approved.`;
    }
    if (!data.reason) throw new ValidationError("Give a reason so the person can correct the entry.", { reason: "Required" });
    await rejectTimeEntries(tx, actor, data.ids, data.reason);
    return `${data.ids.length} entr${data.ids.length === 1 ? "y" : "ies"} returned for correction.`;
  } });
}

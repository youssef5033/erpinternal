"use server";

import { z } from "zod";
import { f } from "@/lib/formdata";
import { runAction, type ActionState } from "./run";
import { logActivity } from "../crm/activities";
import { addChecklistItem, addTaskComment, addTaskDependency, changeTaskStatus, createTask, toggleChecklistItem, updateTask, TASK_STATUSES } from "../delivery/tasks";
import { archiveDocument, grantDocumentAccess, revokeDocumentAccess, updateDocumentMeta, uploadDocument } from "../documents";
import { ValidationError } from "../errors";
import { and, eq, isNull } from "drizzle-orm";
import { notifications } from "@/db/schema";

const links = {
  accountId: f.optId(),
  contactId: f.optId(),
  leadId: f.optId(),
  opportunityId: f.optId(),
  engagementId: f.optId(),
};

export async function logActivityAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    permission: ["crm.write", "delivery.write"],
    action: "activity.log",
    schema: z.object({
      ...links,
      type: f.enumOf(["call", "email", "meeting", "note", "message", "linkedin"] as const),
      direction: f.enumOf(["inbound", "outbound", "internal"] as const).optional(),
      subject: f.str(300),
      body: f.text(),
      outcome: f.optStr(100),
      occurredOn: f.optDate(),
      returnTo: f.optStr(),
    }),
    run: async ({ actor, tx, data }) => {
      if (!data.accountId && !data.contactId && !data.leadId && !data.opportunityId && !data.engagementId) throw new ValidationError("Link the activity to at least one record.");
      await logActivity(tx, actor, {
        type: data.type,
        direction: data.direction ?? (data.type === "note" ? "internal" : null),
        subject: data.subject,
        body: data.body,
        outcome: data.outcome,
        occurredAt: data.occurredOn ? new Date(`${data.occurredOn}T12:00:00Z`) : new Date(),
        source: "manual",
        accountId: data.accountId,
        contactId: data.contactId,
        leadId: data.leadId,
        opportunityId: data.opportunityId,
        engagementId: data.engagementId,
      });
      if (data.leadId && data.type !== "note") {
        const { leads } = await import("@/db/schema");
        await tx.update(leads).set({ lastInteractionAt: new Date() }).where(eq(leads.id, data.leadId));
      }
      return "Activity logged.";
    },
    revalidate: [],
  });
}

const taskSchema = z.object({
  ...links,
  title: f.str(300),
  description: f.text(),
  kind: f.enumOf(["task", "follow_up", "onboarding", "renewal", "collection", "approval", "compliance", "outreach", "hr"] as const).optional(),
  priority: f.enumOf(["low", "medium", "high", "urgent"] as const).optional(),
  ownerId: f.userId(),
  dueDate: f.optDate(),
  estimateHours: f.optDecimal(),
  recurrence: f.enumOf(["none", "daily", "weekly", "monthly"] as const).optional(),
  deliverableId: f.optId(),
  milestoneId: f.optId(),
  invoiceId: f.optId(),
  billId: f.optId(),
  personId: f.optId(),
  checklist: f.text(),
  reminderAt: f.optStr(30),
  redirect: f.optStr(),
});

export async function createTaskAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    action: "task.create",
    schema: taskSchema,
    run: async ({ actor, tx, data }) => {
      const t = await createTask(tx, actor, {
        ...data,
        description: data.description,
        kind: data.kind ?? "task",
        priority: data.priority ?? "medium",
        recurrence: data.recurrence ?? "none",
        reminderAt: data.reminderAt ? new Date(data.reminderAt) : null,
        checklist: data.checklist?.split("\n").map((s) => s.trim()).filter(Boolean),
      });
      return { message: "Task created.", ref: t.id, redirectTo: data.redirect === "task" ? `/people/tasks/${t.id}` : undefined };
    },
  });
}

export async function updateTaskAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    action: "task.update",
    schema: taskSchema.extend({ id: f.id() }),
    run: async ({ actor, tx, data }) => {
      await updateTask(tx, actor, data.id, { title: data.title, description: data.description, priority: data.priority, ownerId: data.ownerId, dueDate: data.dueDate, estimateHours: data.estimateHours, recurrence: data.recurrence, reminderAt: data.reminderAt ? new Date(data.reminderAt) : null });
      return "Task saved.";
    },
  });
}

export async function taskStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    action: "task.status",
    schema: z.object({ id: f.id(), status: f.enumOf(TASK_STATUSES as [string, ...string[]]), blockedReason: f.optStr() }),
    run: async ({ actor, tx, data }) => {
      await changeTaskStatus(tx, actor, data.id, data.status as (typeof TASK_STATUSES)[number], { blockedReason: data.blockedReason });
      return `Moved to ${data.status.replace(/_/g, " ")}.`;
    },
  });
}

export async function taskCommentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "task.comment", schema: z.object({ id: f.id(), body: f.str(5000) }), run: async ({ actor, tx, data }) => {
    await addTaskComment(tx, actor, data.id, data.body);
    return "Comment added.";
  } });
}

export async function checklistAddAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "checklist.add", schema: z.object({ parentType: f.enumOf(["task", "person_checklist"] as const), parentId: f.id(), label: f.str(300) }), run: async ({ actor, tx, data }) => {
    await addChecklistItem(tx, actor, data.parentType, data.parentId, data.label);
    return "Added.";
  } });
}

export async function checklistToggleAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "checklist.toggle", schema: z.object({ id: f.id(), done: f.bool() }), run: async ({ actor, tx, data }) => {
    await toggleChecklistItem(tx, actor, data.id, data.done);
    return data.done ? "Done." : "Reopened.";
  } });
}

export async function taskDependencyAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "task.dependency", schema: z.object({ id: f.id(), dependsOn: f.id() }), run: async ({ actor, tx, data }) => {
    await addTaskDependency(tx, actor, data.id, data.dependsOn);
    return "Dependency added.";
  } });
}

/* Documents ------------------------------------------------------ */

export async function uploadDocumentAction(_p: ActionState, fd: FormData) {
  const file = fd.get("file");
  return runAction(fd, {
    action: "document.upload",
    schema: z.object({
      title: f.optStr(300),
      docType: f.enumOf(["proposal", "contract", "sow", "legal", "client_file", "invoice_pdf", "credit_note_pdf", "receipt", "bill", "deliverable", "brand_asset", "employment", "tax", "evidence", "other"] as const),
      visibility: f.enumOf(["internal", "finance", "hr_private", "restricted"] as const).optional(),
      expiresAt: f.optDate(),
      description: f.text(),
      previousVersionId: f.optId(),
      accountId: f.optId(),
      opportunityId: f.optId(),
      proposalId: f.optId(),
      engagementId: f.optId(),
      contractId: f.optId(),
      deliverableId: f.optId(),
      personId: f.optId(),
      invoiceId: f.optId(),
      billId: f.optId(),
      expenseId: f.optId(),
      paymentId: f.optId(),
      supplierId: f.optId(),
    }),
    run: async ({ actor, tx, data }) => {
      if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file to upload.");
      const buffer = Buffer.from(await file.arrayBuffer());
      const doc = await uploadDocument(tx, actor, { ...data, title: data.title || file.name, fileName: file.name, declaredType: file.type, buffer });
      return { message: `Uploaded ${doc.fileName} (v${doc.versionNumber}).`, ref: doc.id };
    },
  });
}

export async function documentAccessAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "document.access", schema: z.object({ id: f.id(), userId: f.str(100), grant: f.bool() }), run: async ({ actor, tx, data }) => {
    if (data.grant) await grantDocumentAccess(tx, actor, data.id, data.userId);
    else await revokeDocumentAccess(tx, actor, data.id, data.userId);
    return data.grant ? "Access granted." : "Access revoked.";
  } });
}

export async function documentMetaAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "document.meta", schema: z.object({ id: f.id(), title: f.str(300), expiresAt: f.optDate(), approvalStatus: f.enumOf(["none", "pending", "approved", "rejected"] as const), visibility: f.enumOf(["internal", "finance", "hr_private", "restricted"] as const) }), run: async ({ actor, tx, data }) => {
    await updateDocumentMeta(tx, actor, data.id, data);
    return "Document updated.";
  } });
}

export async function archiveDocumentAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "document.archive", schema: z.object({ id: f.id() }), run: async ({ actor, tx, data }) => {
    await archiveDocument(tx, actor, data.id);
    return "Archived.";
  } });
}

export async function markNotificationsReadAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "notifications.read", schema: z.object({}), run: async ({ actor, tx }) => {
    await tx.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)));
    return "All marked as read.";
  } });
}


export async function saveViewAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "view.save", schema: z.object({ module: f.str(50), name: f.str(100), query: f.str(2000), shared: f.bool().optional() }), run: async ({ actor, tx, data }) => {
    const { savedViews } = await import("@/db/schema");
    await tx.insert(savedViews).values({ userId: actor.userId, module: data.module, name: data.name, query: data.query.replace(/^\?/, ""), shared: !!data.shared });
    return "View saved.";
  } });
}

export async function deleteViewAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "view.delete", schema: z.object({ id: f.id() }), run: async ({ actor, tx, data }) => {
    const { savedViews } = await import("@/db/schema");
    await tx.delete(savedViews).where(and(eq(savedViews.id, data.id), eq(savedViews.userId, actor.userId)));
    return "View removed.";
  } });
}

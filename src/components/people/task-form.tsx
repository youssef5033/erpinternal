import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { createTaskAction, updateTaskAction } from "@/server/actions/shared";
import type { tasks } from "@/db/schema";

type Opt = { value: string; label: string };
export const TASK_KINDS = ["task", "follow_up", "onboarding", "renewal", "collection", "approval", "compliance", "outreach", "hr"];
export const PRIORITIES = ["low", "medium", "high", "urgent"];

export function TaskForm({ users, engagements, accounts, v, defaults }: { users: Opt[]; engagements: Opt[]; accounts: Opt[]; v?: typeof tasks.$inferSelect; defaults?: { ownerId?: string; engagementId?: string; accountId?: string } }) {
  return (
    <ActionForm action={v ? updateTaskAction : createTaskAction}>
      {v ? <input type="hidden" name="id" value={v.id} /> : <input type="hidden" name="redirect" value="task" />}
      <Field label="Title" required><Input name="title" defaultValue={v?.title} required /></Field>
      <FormGrid cols={3} className="mt-3">
        <Field label="Owner"><Select name="ownerId" options={users} defaultValue={v?.ownerId ?? defaults?.ownerId ?? ""} placeholder="Unassigned" /></Field>
        <Field label="Due"><Input type="date" name="dueDate" defaultValue={v?.dueDate ?? ""} /></Field>
        <Field label="Priority"><Select name="priority" options={PRIORITIES.map((p) => ({ value: p, label: p }))} defaultValue={v?.priority ?? "medium"} /></Field>
        {!v ? <Field label="Kind"><Select name="kind" options={TASK_KINDS.map((k) => ({ value: k, label: k.replace("_", " ") }))} defaultValue="task" /></Field> : null}
        <Field label="Estimate (hours)"><Input name="estimateHours" inputMode="decimal" defaultValue={v?.estimateHours ? Number(v.estimateHours) : ""} /></Field>
        <Field label="Repeats"><Select name="recurrence" options={[{ value: "none", label: "Does not repeat" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} defaultValue={v?.recurrence ?? "none"} /></Field>
        <Field label="Reminder" hint="In-app notification at this time"><Input type="datetime-local" name="reminderAt" defaultValue={v?.reminderAt ? v.reminderAt.toISOString().slice(0, 16) : ""} /></Field>
        {!v ? <Field label="Engagement"><Select name="engagementId" options={engagements} placeholder="—" defaultValue={defaults?.engagementId ?? ""} /></Field> : null}
        {!v ? <Field label="Account"><Select name="accountId" options={accounts} placeholder="—" defaultValue={defaults?.accountId ?? ""} /></Field> : null}
      </FormGrid>
      <Field label="Description" className="mt-3"><Textarea name="description" rows={3} defaultValue={v?.description ?? ""} /></Field>
      {!v ? <Field label="Checklist (one item per line)" className="mt-3"><Textarea name="checklist" rows={3} /></Field> : null}
      <div className="mt-3 flex justify-end"><SubmitButton>{v ? "Save task" : "Create task"}</SubmitButton></div>
    </ActionForm>
  );
}

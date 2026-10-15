import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { savePersonAction } from "@/server/actions/people";
import type { people } from "@/db/schema";

type Opt = { value: string; label: string };

export function PersonForm({ v, departments, managers, users, defaultTz }: { v?: typeof people.$inferSelect; departments: Opt[]; managers: Opt[]; users: Opt[]; defaultTz: string }) {
  return (
    <ActionForm action={savePersonAction}>
      {v ? <input type="hidden" name="id" value={v.id} /> : null}
      <FormGrid cols={3}>
        <Field label="Full name" required><Input name="fullName" defaultValue={v?.fullName} required /></Field>
        <Field label="Type"><Select name="type" options={[{ value: "employee", label: "Employee" }, { value: "contractor", label: "Contractor / freelancer" }]} defaultValue={v?.type ?? "employee"} /></Field>
        <Field label="Status"><Select name="status" options={["onboarding", "active", "offboarding", "inactive"].map((s) => ({ value: s, label: s }))} defaultValue={v?.status ?? "onboarding"} /></Field>
        <Field label="Job title"><Input name="jobTitle" defaultValue={v?.jobTitle ?? ""} /></Field>
        <Field label="Department"><Select name="departmentId" options={departments} placeholder="—" defaultValue={v?.departmentId ?? ""} /></Field>
        <Field label="Manager"><Select name="managerId" options={managers.filter((m) => m.value !== v?.id)} placeholder="—" defaultValue={v?.managerId ?? ""} /></Field>
        <Field label="Work email"><Input type="email" name="email" defaultValue={v?.email ?? ""} /></Field>
        <Field label="Phone"><Input name="phone" defaultValue={v?.phone ?? ""} /></Field>
        <Field label="System user" hint="Links time, tasks and leave to this login."><Select name="userId" options={users} placeholder="No login" defaultValue={v?.userId ?? ""} /></Field>
        <Field label="Start date"><Input type="date" name="startDate" defaultValue={v?.startDate ?? ""} /></Field>
        <Field label="End date"><Input type="date" name="endDate" defaultValue={v?.endDate ?? ""} /></Field>
        <Field label="Time zone" hint="IANA name"><Input name="timeZone" defaultValue={v?.timeZone ?? defaultTz} required /></Field>
        <Field label="Weekly capacity (hours)"><Input name="weeklyCapacityHours" inputMode="decimal" defaultValue={v ? Number(v.weeklyCapacityHours) : 40} /></Field>
      </FormGrid>
      <Field label="Notes" className="mt-3" hint="Operational notes only. Private HR matters belong in HR-private documents."><Textarea name="notes" rows={2} defaultValue={v?.notes ?? ""} /></Field>
      <p className="mt-2 text-[12px] text-muted">Payroll is not calculated here: no jurisdiction-specific rules have been defined. Cost rates are entered separately by authorised users.</p>
      <div className="mt-3 flex justify-end"><SubmitButton>{v ? "Save person" : "Add person"}</SubmitButton></div>
    </ActionForm>
  );
}

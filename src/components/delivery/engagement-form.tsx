import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { createEngagementAction, updateEngagementAction } from "@/server/actions/delivery";

type Opt = { value: string; label: string };
export type EngagementDefaults = Partial<{
  id: string; name: string; accountId: string; serviceId: string; offerId: string | null; billingModel: string; recognitionMethod: string; ownerId: string | null; primaryContactId: string | null;
  startDate: string | null; endDate: string | null; currency: string; contractValue: string | null; hourlyRate: string | null; retainerAmount: string | null; retainerPeriodMonths: number | null;
  budgetHours: string | null; budgetCost: string | null; includedRevisions: number | null; renewalDate: string | null; noticePeriodDays: number | null; autoRenew: boolean; objectives: string | null; discoveryNotes: string | null;
}>;

export const BILLING_MODELS: Opt[] = [
  { value: "fixed", label: "Fixed fee" },
  { value: "retainer", label: "Retainer (recurring)" },
  { value: "milestone", label: "Milestone-based" },
  { value: "hourly", label: "Hourly / time & materials" },
];
export const RECOGNITION: Opt[] = [
  { value: "", label: "Default for billing model" },
  { value: "straight_line", label: "Straight-line over the service period" },
  { value: "milestone", label: "On milestone acceptance" },
  { value: "time_and_materials", label: "Time & materials (approved hours)" },
  { value: "percent_complete", label: "Percent complete (hours vs budget)" },
  { value: "on_completion", label: "On completion" },
];

export function EngagementForm({ accounts, services, offers, users, contacts, v }: { accounts: Opt[]; services: Opt[]; offers: Opt[]; users: Opt[]; contacts: Opt[]; v: EngagementDefaults }) {
  const editing = !!v.id;
  return (
    <ActionForm action={editing ? updateEngagementAction : createEngagementAction}>
      {editing ? <input type="hidden" name="id" value={v.id} /> : null}
      {editing ? <input type="hidden" name="accountId" value={v.accountId} /> : null}
      <FormGrid cols={3}>
        <Field label="Engagement name" required className="sm:col-span-2"><Input name="name" defaultValue={v.name} required /></Field>
        <Field label="Account" required><Select name="accountId" options={accounts} placeholder="Choose" defaultValue={v.accountId ?? ""} disabled={editing} required /></Field>
        <Field label="Service stream" required><Select name="serviceId" options={services} placeholder="Choose" defaultValue={v.serviceId ?? ""} required /></Field>
        <Field label="Offer"><Select name="offerId" options={offers} placeholder="—" defaultValue={v.offerId ?? ""} /></Field>
        <Field label="Engagement lead"><Select name="ownerId" options={users} placeholder="—" defaultValue={v.ownerId ?? ""} /></Field>
        <Field label="Primary client contact"><Select name="primaryContactId" options={contacts} placeholder="—" defaultValue={v.primaryContactId ?? ""} /></Field>
        <Field label="Start"><Input type="date" name="startDate" defaultValue={v.startDate ?? ""} /></Field>
        <Field label="End"><Input type="date" name="endDate" defaultValue={v.endDate ?? ""} /></Field>
      </FormGrid>
      <h3 className="mb-2 mt-5 text-[13px] font-semibold">Commercial terms</h3>
      <FormGrid cols={3}>
        <Field label="Billing model" required><Select name="billingModel" options={BILLING_MODELS} defaultValue={v.billingModel ?? "fixed"} /></Field>
        <Field label="Revenue recognition"><Select name="recognitionMethod" options={RECOGNITION} defaultValue={v.recognitionMethod ?? ""} /></Field>
        <Field label="Currency" required><Select name="currency" options={CURRENCIES} defaultValue={v.currency ?? "USD"} /></Field>
        <Field label="Contract value" hint="Total for fixed / milestone; total over the term for retainers."><Input name="contractValue" inputMode="decimal" defaultValue={v.contractValue ?? ""} /></Field>
        <Field label="Hourly rate" hint="Required for hourly."><Input name="hourlyRate" inputMode="decimal" defaultValue={v.hourlyRate ?? ""} /></Field>
        <Field label="Retainer fee per period" hint="Required for retainers."><Input name="retainerAmount" inputMode="decimal" defaultValue={v.retainerAmount ?? ""} /></Field>
        <Field label="Retainer period (months)"><Input type="number" min={1} name="retainerPeriodMonths" defaultValue={v.retainerPeriodMonths ?? 1} /></Field>
        <Field label="Budget hours"><Input name="budgetHours" inputMode="decimal" defaultValue={v.budgetHours ?? ""} /></Field>
        <Field label="Budget cost"><Input name="budgetCost" inputMode="decimal" defaultValue={v.budgetCost ?? ""} /></Field>
        <Field label="Included revisions"><Input type="number" min={0} name="includedRevisions" defaultValue={v.includedRevisions ?? ""} /></Field>
        <Field label="Renewal date"><Input type="date" name="renewalDate" defaultValue={v.renewalDate ?? ""} /></Field>
        <Field label="Notice period (days)"><Input type="number" min={0} name="noticePeriodDays" defaultValue={v.noticePeriodDays ?? ""} /></Field>
      </FormGrid>
      <div className="mt-3 flex flex-wrap gap-6">
        <Checkbox name="autoRenew" label="Auto-renews" defaultChecked={v.autoRenew ?? false} />
        {!editing ? <Checkbox name="createRetainerBilling" label="Create retainer periods and monthly billing items" defaultChecked /> : null}
      </div>
      <Field label="Objectives" className="mt-4"><Textarea name="objectives" rows={3} defaultValue={v.objectives ?? ""} /></Field>
      <Field label="Discovery notes" className="mt-3"><Textarea name="discoveryNotes" rows={3} defaultValue={v.discoveryNotes ?? ""} /></Field>
      <div className="mt-4 flex justify-end"><SubmitButton>{editing ? "Save engagement" : "Create engagement"}</SubmitButton></div>
    </ActionForm>
  );
}

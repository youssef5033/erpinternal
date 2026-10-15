import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { saveSupplierAction } from "@/server/actions/finance";
import type { suppliers } from "@/db/schema";

type Opt = { value: string; label: string };

export function SupplierForm({ v, ledgers, people }: { v?: typeof suppliers.$inferSelect; ledgers: Opt[]; people: Opt[] }) {
  return (
    <ActionForm action={saveSupplierAction}>
      {v ? <input type="hidden" name="id" value={v.id} /> : null}
      <FormGrid cols={3}>
        <Field label="Name" required><Input name="name" defaultValue={v?.name} required /></Field>
        <Field label="Type"><Select name="supplierType" options={[{ value: "contractor", label: "Contractor" }, { value: "freelancer", label: "Freelancer" }, { value: "agency", label: "Partner agency" }, { value: "vendor", label: "Vendor" }]} defaultValue={v?.supplierType ?? "vendor"} /></Field>
        <Field label="Default currency"><Select name="defaultCurrency" options={CURRENCIES} defaultValue={v?.defaultCurrency ?? "USD"} /></Field>
        <Field label="Contact name"><Input name="contactName" defaultValue={v?.contactName ?? ""} /></Field>
        <Field label="Email"><Input type="email" name="email" defaultValue={v?.email ?? ""} /></Field>
        <Field label="Phone"><Input name="phone" defaultValue={v?.phone ?? ""} /></Field>
        <Field label="Website"><Input name="website" defaultValue={v?.website ?? ""} /></Field>
        <Field label="Tax identifier"><Input name="taxIdentifier" defaultValue={v?.taxIdentifier ?? ""} /></Field>
        <Field label="Payment terms (days)"><Input type="number" min={0} name="paymentTermsDays" defaultValue={v?.paymentTermsDays ?? 30} /></Field>
        <Field label="Default expense account"><Select name="defaultExpenseLedgerAccountId" options={ledgers} placeholder="—" defaultValue={v?.defaultExpenseLedgerAccountId ?? ""} /></Field>
        <Field label="Linked person (contractors)"><Select name="personId" options={people} placeholder="—" defaultValue={v?.personId ?? ""} /></Field>
      </FormGrid>
      <FormGrid cols={2} className="mt-3">
        <Field label="Payment details" hint="Visible to finance only. Never store passwords or online-banking credentials here."><Textarea name="bankDetails" rows={2} defaultValue={v?.bankDetails ?? ""} /></Field>
        <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={v?.notes ?? ""} /></Field>
      </FormGrid>
      <div className="mt-3 flex justify-end"><SubmitButton>{v ? "Save supplier" : "Create supplier"}</SubmitButton></div>
    </ActionForm>
  );
}

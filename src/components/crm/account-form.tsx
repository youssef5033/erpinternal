import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/primitives";
import type { accounts } from "@/db/schema";
import { createAccountAction, updateAccountAction } from "@/server/actions/crm";

type Opt = { value: string; label: string };

export function AccountForm({ account: a, users, channels, industries, sizeBands, currentUserId }: { account?: typeof accounts.$inferSelect; users: Opt[]; channels: Opt[]; industries: string[]; sizeBands: string[]; currentUserId: string }) {
  return (
    <ActionForm action={a ? updateAccountAction : createAccountAction} className="space-y-4">
      {a ? <input type="hidden" name="id" value={a.id} /> : null}
      <Card>
        <CardHeader title="Company profile" />
        <CardBody>
          <FormGrid cols={3}>
            <Field label="Company name" htmlFor="name" required><Input id="name" name="name" defaultValue={a?.name} required /></Field>
            <Field label="Website" htmlFor="website"><Input id="website" name="website" defaultValue={a?.website ?? ""} /></Field>
            <Field label="Lifecycle" htmlFor="lifecycleStatus"><Select id="lifecycleStatus" name="lifecycleStatus" defaultValue={a?.lifecycleStatus ?? "prospect"} options={[{ value: "prospect", label: "Prospect" }, { value: "onboarding", label: "Onboarding" }, { value: "active", label: "Active client" }, { value: "former", label: "Former client" }, { value: "partner", label: "Partner" }]} /></Field>
            <Field label="Industry" htmlFor="industry"><Input id="industry" name="industry" list="ind" defaultValue={a?.industry ?? ""} /><datalist id="ind">{industries.map((i) => <option key={i} value={i} />)}</datalist></Field>
            <Field label="Country" htmlFor="country"><Input id="country" name="country" defaultValue={a?.country ?? ""} /></Field>
            <Field label="City / region" htmlFor="city"><Input id="city" name="city" defaultValue={a?.city ?? ""} /></Field>
            <Field label="Size" htmlFor="sizeBand"><Select id="sizeBand" name="sizeBand" defaultValue={a?.sizeBand ?? ""} placeholder="—" options={sizeBands.map((s) => ({ value: s, label: s }))} /></Field>
            <Field label="Relationship owner" htmlFor="ownerId"><Select id="ownerId" name="ownerId" defaultValue={a?.ownerId ?? currentUserId} options={users} /></Field>
            <Field label="Phone" htmlFor="phone"><Input id="phone" name="phone" defaultValue={a?.phone ?? ""} /></Field>
            <Field label="Description" htmlFor="description" className="sm:col-span-3"><Textarea id="description" name="description" defaultValue={a?.description ?? ""} rows={2} /></Field>
            <Field label="Tags" htmlFor="tags" hint="Comma separated"><Input id="tags" name="tags" defaultValue={(a?.tags ?? []).join(", ")} /></Field>
            <Field label="First-touch channel" htmlFor="acquisitionChannel" hint="Leave blank if unknown"><Select id="acquisitionChannel" name="acquisitionChannel" defaultValue={a?.acquisitionChannel ?? ""} placeholder="Unknown" options={channels} /></Field>
            <Field label="Source detail" htmlFor="acquisitionDetail"><Input id="acquisitionDetail" name="acquisitionDetail" defaultValue={a?.acquisitionDetail ?? ""} /></Field>
          </FormGrid>
        </CardBody>
      </Card>
      <Card id="billing">
        <CardHeader title="Billing details" description="Required before invoices can be issued." />
        <CardBody>
          <FormGrid cols={3}>
            <Field label="Billing email" htmlFor="billingEmail"><Input id="billingEmail" name="billingEmail" type="email" defaultValue={a?.billingEmail ?? ""} /></Field>
            <Field label="Billing contact" htmlFor="billingContactName"><Input id="billingContactName" name="billingContactName" defaultValue={a?.billingContactName ?? ""} /></Field>
            <Field label="Tax identifier" htmlFor="taxIdentifier"><Input id="taxIdentifier" name="taxIdentifier" defaultValue={a?.taxIdentifier ?? ""} /></Field>
            <Field label="Payment terms (days)" htmlFor="paymentTermsDays"><Input id="paymentTermsDays" name="paymentTermsDays" type="number" min={0} defaultValue={a?.paymentTermsDays ?? ""} /></Field>
            <Field label="Default currency" htmlFor="defaultCurrency"><Select id="defaultCurrency" name="defaultCurrency" defaultValue={a?.defaultCurrency ?? ""} placeholder="—" options={CURRENCIES} /></Field>
            <Field label="Billing address" htmlFor="billingAddress" className="sm:col-span-3"><Textarea id="billingAddress" name="billingAddress" defaultValue={a?.billingAddress ?? ""} rows={2} /></Field>
          </FormGrid>
          {!a ? <Checkbox className="mt-3" name="allowDuplicate" label="Create even if a similar account exists (I have checked)" /> : null}
        </CardBody>
      </Card>
      <SubmitButton>{a ? "Save account" : "Create account"}</SubmitButton>
    </ActionForm>
  );
}

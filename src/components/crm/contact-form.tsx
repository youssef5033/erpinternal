import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { Card, CardBody } from "@/components/ui/primitives";
import type { contacts } from "@/db/schema";
import { createContactAction, updateContactAction } from "@/server/actions/crm";

type Opt = { value: string; label: string };

export function ContactForm({ contact: c, accounts, users, roles, defaultAccountId, currentUserId }: { contact?: typeof contacts.$inferSelect; accounts: Opt[]; users: Opt[]; roles: Opt[]; defaultAccountId?: string; currentUserId: string }) {
  return (
    <ActionForm action={c ? updateContactAction : createContactAction}>
      {c ? <input type="hidden" name="id" value={c.id} /> : null}
      <Card>
        <CardBody className="space-y-3">
          <FormGrid cols={3}>
            <Field label="Full name" htmlFor="fullName" required><Input id="fullName" name="fullName" defaultValue={c?.fullName} required /></Field>
            <Field label="Primary account" htmlFor="primaryAccountId"><Select id="primaryAccountId" name="primaryAccountId" defaultValue={c?.primaryAccountId ?? defaultAccountId ?? ""} placeholder="—" options={accounts} /></Field>
            <Field label="Job title" htmlFor="jobTitle"><Input id="jobTitle" name="jobTitle" defaultValue={c?.jobTitle ?? ""} /></Field>
            <Field label="Business email" htmlFor="email"><Input id="email" name="email" type="email" defaultValue={c?.email ?? ""} /></Field>
            <Field label="Phone" htmlFor="phone"><Input id="phone" name="phone" defaultValue={c?.phone ?? ""} /></Field>
            <Field label="LinkedIn URL" htmlFor="linkedinUrl"><Input id="linkedinUrl" name="linkedinUrl" defaultValue={c?.linkedinUrl ?? ""} /></Field>
            <Field label="Preferred channel" htmlFor="preferredChannel"><Select id="preferredChannel" name="preferredChannel" defaultValue={c?.preferredChannel ?? ""} placeholder="—" options={[{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }, { value: "linkedin", label: "LinkedIn" }, { value: "in_person", label: "In person" }, { value: "other", label: "Other" }]} /></Field>
            <Field label="Owner" htmlFor="ownerId"><Select id="ownerId" name="ownerId" defaultValue={c?.ownerId ?? currentUserId} options={users} /></Field>
            <Field label="Time zone" htmlFor="timeZone"><Input id="timeZone" name="timeZone" defaultValue={c?.timeZone ?? ""} placeholder="e.g. Europe/London" /></Field>
            <Field label="Source URL" htmlFor="sourceUrl"><Input id="sourceUrl" name="sourceUrl" defaultValue={c?.sourceUrl ?? ""} /></Field>
          </FormGrid>
          <fieldset>
            <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Buying roles</legend>
            <div className="flex flex-wrap gap-4">{roles.map((r) => <Checkbox key={r.value} name="buyingRoles[]" value={r.value} label={r.label} defaultChecked={c?.buyingRoles.includes(r.value)} />)}</div>
          </fieldset>
          <FormGrid cols={2}>
            <Field label="Relationship notes" htmlFor="relationshipNotes"><Textarea id="relationshipNotes" name="relationshipNotes" defaultValue={c?.relationshipNotes ?? ""} /></Field>
            <Field label="Contact restrictions" htmlFor="contactRestrictions" hint="e.g. 'Only via assistant'. Opt-outs are recorded separately."><Textarea id="contactRestrictions" name="contactRestrictions" defaultValue={c?.contactRestrictions ?? ""} /></Field>
          </FormGrid>
          {!c ? <Checkbox name="allowDuplicate" label="Create even if the email already exists on another contact" /> : null}
          <SubmitButton>{c ? "Save contact" : "Create contact"}</SubmitButton>
        </CardBody>
      </Card>
    </ActionForm>
  );
}

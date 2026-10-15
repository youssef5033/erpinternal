import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/primitives";
import type { leads } from "@/db/schema";
import { createLeadAction, updateLeadAction } from "@/server/actions/crm";

type Opt = { value: string; label: string };

export function LeadForm({
  lead,
  serviceIds = [],
  users,
  channels,
  services,
  campaigns,
  industries,
  sizeBands,
  customFields,
  currentUserId,
}: {
  lead?: typeof leads.$inferSelect;
  serviceIds?: string[];
  users: Opt[];
  channels: Opt[];
  services: Opt[];
  campaigns: Opt[];
  industries: string[];
  sizeBands: string[];
  customFields: { key: string; label: string; fieldType: string; options: string[] | null }[];
  currentUserId: string;
}) {
  const v = lead;
  return (
    <ActionForm action={v ? updateLeadAction : createLeadAction} className="space-y-4">
      {v ? <input type="hidden" name="id" value={v.id} /> : null}
      <Card>
        <CardHeader title="Company" />
        <CardBody>
          <FormGrid cols={3}>
            <Field label="Company name" htmlFor="companyName" required>
              <Input id="companyName" name="companyName" defaultValue={v?.companyName} required maxLength={200} />
            </Field>
            <Field label="Website" htmlFor="website" hint="Used for duplicate detection">
              <Input id="website" name="website" defaultValue={v?.website ?? ""} placeholder="example.com" />
            </Field>
            <Field label="Industry" htmlFor="industry">
              <Input id="industry" name="industry" list="industries" defaultValue={v?.industry ?? ""} />
              <datalist id="industries">{industries.map((i) => <option key={i} value={i} />)}</datalist>
            </Field>
            <Field label="Country / geography" htmlFor="country">
              <Input id="country" name="country" defaultValue={v?.country ?? ""} />
            </Field>
            <Field label="Region / city" htmlFor="region">
              <Input id="region" name="region" defaultValue={v?.region ?? ""} />
            </Field>
            <Field label="Company size" htmlFor="sizeBand">
              <Select id="sizeBand" name="sizeBand" defaultValue={v?.sizeBand ?? ""} placeholder="—" options={sizeBands.map((s) => ({ value: s, label: s }))} />
            </Field>
          </FormGrid>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Source, fit and research" description="First-touch acquisition source is preserved; leave blank if unknown." />
        <CardBody className="space-y-3">
          <FormGrid cols={4}>
            <Field label="Acquisition channel" htmlFor="acquisitionChannel">
              <Select id="acquisitionChannel" name="acquisitionChannel" defaultValue={v?.acquisitionChannel ?? ""} placeholder="Unknown" options={channels} />
            </Field>
            <Field label="Source detail" htmlFor="acquisitionDetail">
              <Input id="acquisitionDetail" name="acquisitionDetail" defaultValue={v?.acquisitionDetail ?? ""} placeholder="e.g. referred by …" />
            </Field>
            <Field label="Campaign" htmlFor="campaignId">
              <Select id="campaignId" name="campaignId" defaultValue={v?.campaignId ?? ""} placeholder="None" options={campaigns} />
            </Field>
            <Field label="Date added" htmlFor="dateAdded">
              <Input id="dateAdded" name="dateAdded" type="date" defaultValue={v?.dateAdded ?? ""} />
            </Field>
          </FormGrid>
          <fieldset>
            <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Recommended services (a lead can fit several)</legend>
            <div className="flex flex-wrap gap-4">
              {services.map((s) => (
                <Checkbox key={s.value} name="serviceIds[]" value={s.value} label={s.label} defaultChecked={serviceIds.includes(s.value)} />
              ))}
            </div>
          </fieldset>
          <FormGrid cols={2}>
            <Field label="Observed business needs" htmlFor="observedNeeds">
              <Textarea id="observedNeeds" name="observedNeeds" defaultValue={v?.observedNeeds ?? ""} />
            </Field>
            <Field label="Research notes" htmlFor="researchNotes" hint={v ? "Add dated evidence on the lead page; this field is the summary." : "Saved as the first research note."}>
              <Textarea id="researchNotes" name="researchNotes" defaultValue={v?.researchNotes ?? ""} />
            </Field>
          </FormGrid>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Ownership and next step" />
        <CardBody>
          <FormGrid cols={4}>
            <Field label="Owner" htmlFor="ownerId">
              <Select id="ownerId" name="ownerId" defaultValue={v?.ownerId ?? currentUserId} options={users} />
            </Field>
            <Field label="Next action" htmlFor="nextAction">
              <Input id="nextAction" name="nextAction" defaultValue={v?.nextAction ?? ""} />
            </Field>
            <Field label="Next action date" htmlFor="nextActionDate">
              <Input id="nextActionDate" name="nextActionDate" type="date" defaultValue={v?.nextActionDate ?? ""} />
            </Field>
            <Field label="Follow-up date" htmlFor="followUpDate">
              <Input id="followUpDate" name="followUpDate" type="date" defaultValue={v?.followUpDate ?? ""} />
            </Field>
            <Field label="Estimated value" htmlFor="estimatedValue">
              <Input id="estimatedValue" name="estimatedValue" inputMode="decimal" defaultValue={v?.estimatedValue ?? ""} />
            </Field>
            <Field label="Currency" htmlFor="currency">
              <Select id="currency" name="currency" defaultValue={v?.currency ?? ""} placeholder="—" options={CURRENCIES} />
            </Field>
            <Field label="Tags" htmlFor="tags" hint="Comma separated" className="sm:col-span-2">
              <Input id="tags" name="tags" defaultValue={(v?.tags ?? []).join(", ")} />
            </Field>
          </FormGrid>
          {customFields.length ? (
            <FormGrid cols={4} className="mt-3">
              {customFields.map((cf) => (
                <Field key={cf.key} label={cf.label} htmlFor={`cf-${cf.key}`}>
                  {cf.fieldType === "select" ? (
                    <Select id={`cf-${cf.key}`} name={`customFields.${cf.key}`} defaultValue={String((v?.customFields as Record<string, string>)?.[cf.key] ?? "")} placeholder="—" options={(cf.options ?? []).map((o) => ({ value: o, label: o }))} />
                  ) : (
                    <Input id={`cf-${cf.key}`} name={`customFields.${cf.key}`} type={cf.fieldType === "date" ? "date" : cf.fieldType === "number" ? "number" : "text"} defaultValue={String((v?.customFields as Record<string, string>)?.[cf.key] ?? "")} />
                  )}
                </Field>
              ))}
            </FormGrid>
          ) : null}
        </CardBody>
      </Card>
      {!v ? (
        <Card>
          <CardHeader title="Contacts" description="Public business contact details only, with the source where you found them." />
          <CardBody className="space-y-3">
            {[0, 1].map((i) => (
              <FormGrid key={i} cols={3}>
                <Field label={`Contact ${i + 1} name`} htmlFor={`c${i}n`}>
                  <Input id={`c${i}n`} name={`contacts.${i}.fullName`} />
                </Field>
                <Field label="Role / title" htmlFor={`c${i}t`}>
                  <Input id={`c${i}t`} name={`contacts.${i}.jobTitle`} />
                </Field>
                <Field label="Business email" htmlFor={`c${i}e`}>
                  <Input id={`c${i}e`} name={`contacts.${i}.email`} type="email" />
                </Field>
                <Field label="Phone" htmlFor={`c${i}p`}>
                  <Input id={`c${i}p`} name={`contacts.${i}.phone`} />
                </Field>
                <Field label="LinkedIn URL" htmlFor={`c${i}l`}>
                  <Input id={`c${i}l`} name={`contacts.${i}.linkedinUrl`} />
                </Field>
                <Field label="Source URL" htmlFor={`c${i}s`}>
                  <Input id={`c${i}s`} name={`contacts.${i}.sourceUrl`} placeholder="https://" />
                </Field>
              </FormGrid>
            ))}
            <Checkbox name="allowDuplicate" label="Save even if a possible duplicate is found (I have reviewed it)" />
          </CardBody>
        </Card>
      ) : null}
      <div className="flex gap-2">
        <SubmitButton>{v ? "Save lead" : "Create lead"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { Card, CardBody, CardHeader } from "@/components/ui/primitives";
import type { opportunities } from "@/db/schema";
import { createOpportunityAction, updateOpportunityAction } from "@/server/actions/crm";

type Opt = { value: string; label: string };

export function OpportunityForm(p: {
  opp?: typeof opportunities.$inferSelect;
  serviceIds?: string[];
  contactIds?: string[];
  accounts: Opt[];
  contacts: Opt[];
  users: Opt[];
  services: Opt[];
  channels: Opt[];
  campaigns: Opt[];
  stages: Opt[];
  engagements: Opt[];
  defaults: { accountId?: string; kind?: string; currency?: string; ownerId: string };
}) {
  const o = p.opp;
  return (
    <ActionForm action={o ? updateOpportunityAction : createOpportunityAction} className="space-y-4">
      {o ? <input type="hidden" name="id" value={o.id} /> : null}
      <Card>
        <CardHeader title="Deal" />
        <CardBody className="space-y-3">
          <FormGrid cols={3}>
            <Field label="Name" htmlFor="name" required><Input id="name" name="name" defaultValue={o?.name} required /></Field>
            <Field label="Account" htmlFor="accountId" required>
              {o ? <><input type="hidden" name="accountId" value={o.accountId} /><Input id="accountId" disabled value={p.accounts.find((a) => a.value === o.accountId)?.label ?? ""} /></> : <Select id="accountId" name="accountId" defaultValue={p.defaults.accountId ?? ""} placeholder="Choose account" options={p.accounts} required />}
            </Field>
            <Field label="Type" htmlFor="kind"><Select id="kind" name="kind" defaultValue={o?.kind ?? p.defaults.kind ?? "new_business"} options={[{ value: "new_business", label: "New business" }, { value: "expansion", label: "Expansion (existing client)" }, { value: "renewal", label: "Renewal" }]} /></Field>
            <Field label="Value" htmlFor="value" required><Input id="value" name="value" inputMode="decimal" defaultValue={o?.value ?? ""} required /></Field>
            <Field label="Currency" htmlFor="currency"><Select id="currency" name="currency" defaultValue={o?.currency ?? p.defaults.currency ?? "USD"} options={CURRENCIES} /></Field>
            <Field label="Pricing model" htmlFor="pricingModel"><Select id="pricingModel" name="pricingModel" defaultValue={o?.pricingModel ?? "fixed"} options={[{ value: "fixed", label: "Fixed fee" }, { value: "retainer", label: "Monthly retainer" }, { value: "milestone", label: "Milestone billing" }, { value: "hourly", label: "Hourly" }]} /></Field>
            {!o ? <Field label="Starting stage" htmlFor="stageId"><Select id="stageId" name="stageId" options={p.stages} /></Field> : null}
            <Field label="Expected close" htmlFor="expectedCloseDate"><Input id="expectedCloseDate" name="expectedCloseDate" type="date" defaultValue={o?.expectedCloseDate ?? ""} /></Field>
            <Field label="Probability override (%)" htmlFor="probabilityOverride" hint="Blank = stage default"><Input id="probabilityOverride" name="probabilityOverride" type="number" min={0} max={100} defaultValue={o?.probabilityOverride ?? ""} /></Field>
            <Field label="Owner" htmlFor="ownerId"><Select id="ownerId" name="ownerId" defaultValue={o?.ownerId ?? p.defaults.ownerId} options={p.users} /></Field>
            <Field label="Primary contact" htmlFor="primaryContactId"><Select id="primaryContactId" name="primaryContactId" defaultValue={o?.primaryContactId ?? ""} placeholder="—" options={p.contacts} /></Field>
            <Field label="Related engagement (renewal/expansion)" htmlFor="parentEngagementId"><Select id="parentEngagementId" name="parentEngagementId" defaultValue={o?.parentEngagementId ?? ""} placeholder="—" options={p.engagements} /></Field>
          </FormGrid>
          <fieldset>
            <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Service streams</legend>
            <div className="flex flex-wrap gap-4">{p.services.map((s) => <Checkbox key={s.value} name="serviceIds[]" value={s.value} label={s.label} defaultChecked={p.serviceIds?.includes(s.value)} />)}</div>
          </fieldset>
          {p.contacts.length ? (
            <fieldset>
              <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Contacts involved</legend>
              <div className="flex flex-wrap gap-4">{p.contacts.map((c) => <Checkbox key={c.value} name="contactIds[]" value={c.value} label={c.label} defaultChecked={p.contactIds?.includes(c.value)} />)}</div>
            </fieldset>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Problem, outcome and scope" />
        <CardBody>
          <FormGrid cols={2}>
            <Field label="Business problem" htmlFor="businessProblem"><Textarea id="businessProblem" name="businessProblem" defaultValue={o?.businessProblem ?? ""} /></Field>
            <Field label="Desired outcome" htmlFor="desiredOutcome"><Textarea id="desiredOutcome" name="desiredOutcome" defaultValue={o?.desiredOutcome ?? ""} /></Field>
            <Field label="Scope summary" htmlFor="scopeSummary"><Textarea id="scopeSummary" name="scopeSummary" defaultValue={o?.scopeSummary ?? ""} /></Field>
            <Field label="Discovery notes" htmlFor="discoveryNotes"><Textarea id="discoveryNotes" name="discoveryNotes" defaultValue={o?.discoveryNotes ?? ""} /></Field>
            <Field label="Objections" htmlFor="objections"><Textarea id="objections" name="objections" defaultValue={o?.objections ?? ""} rows={2} /></Field>
            <Field label="Competitors" htmlFor="competitors"><Input id="competitors" name="competitors" defaultValue={o?.competitors ?? ""} /></Field>
          </FormGrid>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Next step and attribution" />
        <CardBody>
          <FormGrid cols={4}>
            <Field label="Next action" htmlFor="nextAction" className="sm:col-span-2"><Input id="nextAction" name="nextAction" defaultValue={o?.nextAction ?? ""} /></Field>
            <Field label="Next action date" htmlFor="nextActionDate"><Input id="nextActionDate" name="nextActionDate" type="date" defaultValue={o?.nextActionDate ?? ""} /></Field>
            <Field label="Acquisition channel" htmlFor="acquisitionChannel"><Select id="acquisitionChannel" name="acquisitionChannel" defaultValue={o?.acquisitionChannel ?? ""} placeholder="From account / unknown" options={p.channels} /></Field>
            <Field label="Campaign" htmlFor="campaignId"><Select id="campaignId" name="campaignId" defaultValue={o?.campaignId ?? ""} placeholder="None" options={p.campaigns} /></Field>
          </FormGrid>
        </CardBody>
      </Card>
      <SubmitButton>{o ? "Save opportunity" : "Create opportunity"}</SubmitButton>
    </ActionForm>
  );
}

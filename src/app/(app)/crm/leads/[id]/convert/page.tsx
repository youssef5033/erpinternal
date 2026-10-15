import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { leadContacts, leadServiceFits, leads } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { leadVisibility } from "@/server/auth/scope";
import { findLeadDuplicates } from "@/server/crm/leads";
import { crmLookups } from "@/server/crm/lookups";
import { addDaysISO } from "@/lib/dates";
import { agencyToday } from "@/server/system/settings";
import { Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { convertLeadAction } from "@/server/actions/crm";

export default async function ConvertLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.write");
  const { id } = await params;
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, id), leadVisibility(actor)));
  if (!lead) notFound();
  const contacts = await db.select().from(leadContacts).where(eq(leadContacts.leadId, id));
  const fits = await db.select().from(leadServiceFits).where(eq(leadServiceFits.leadId, id));
  const dups = await findLeadDuplicates(db, { companyName: lead.companyName, website: lead.website, emails: contacts.map((c) => c.email) }, id);
  const accountDups = dups.filter((d) => d.type === "account");
  const L = await crmLookups();
  const today = await agencyToday(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "Leads", href: "/crm/leads" }, { label: lead.companyName, href: `/crm/leads/${id}` }, { label: "Convert" }]} title={`Convert ${lead.companyName}`} description="Creates (or reuses) the shared account and contacts and optionally an opportunity. Research notes, evidence and activity stay linked." />
      {lead.status === "converted" ? <Notice tone="warning" title="Already converted" /> : null}
      <ActionForm action={convertLeadAction} className="space-y-4">
        <input type="hidden" name="id" value={id} />
        <Card>
          <CardHeader title="1. Account" description="One account per company, shared across CRM, delivery and finance." />
          <CardBody className="space-y-2 text-[13px]">
            {accountDups.length ? (
              <>
                <Notice tone="info">An account that looks like this company already exists. Reuse it to keep a single customer identity.</Notice>
                {accountDups.map((d, i) => (
                  <label key={d.id} className="flex items-center gap-2">
                    <input type="radio" name="accountId" value={d.id} defaultChecked={i === 0} className="accent-[var(--color-accent)]" />
                    Use existing <Link className="font-medium underline" href={`/crm/accounts/${d.id}`}>{d.label}</Link> <span className="text-muted">({d.reason})</span>
                  </label>
                ))}
                <label className="flex items-center gap-2">
                  <input type="radio" name="accountId" value="" className="accent-[var(--color-accent)]" /> Create a new account anyway
                </label>
              </>
            ) : (
              <p>A new account “{lead.companyName}” will be created with the lead&apos;s profile and first-touch source.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="2. Contacts" description="Contacts with an email that already exists are linked, not duplicated." />
          <CardBody className="space-y-1">
            {contacts.length ? contacts.map((c) => <Checkbox key={c.id} name="leadContactIds[]" value={c.id} defaultChecked label={`${c.fullName}${c.jobTitle ? ` — ${c.jobTitle}` : ""}${c.email ? ` (${c.email})` : ""}`} />) : <p className="text-[13px] text-muted">No contacts on this lead.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="3. Opportunity" />
          <CardBody className="space-y-3">
            <Checkbox name="createOpportunity" defaultChecked label="Create an opportunity in the first pipeline stage (Qualified)" />
            <FormGrid cols={3}>
              <Field label="Opportunity name" htmlFor="oppName">
                <Input id="oppName" name="oppName" defaultValue={`${lead.companyName} — ${L.servicesRaw.find((s) => s.id === fits[0]?.serviceId)?.shortName ?? "engagement"}`} />
              </Field>
              <Field label="Value" htmlFor="value">
                <Input id="value" name="value" inputMode="decimal" defaultValue={lead.estimatedValue ?? ""} />
              </Field>
              <Field label="Currency" htmlFor="currency">
                <Select id="currency" name="currency" defaultValue={lead.currency ?? "USD"} options={CURRENCIES} />
              </Field>
              <Field label="Pricing model" htmlFor="pricingModel">
                <Select id="pricingModel" name="pricingModel" options={[{ value: "fixed", label: "Fixed fee" }, { value: "retainer", label: "Monthly retainer" }, { value: "milestone", label: "Milestone billing" }, { value: "hourly", label: "Hourly" }]} />
              </Field>
              <Field label="Expected close" htmlFor="expectedCloseDate">
                <Input id="expectedCloseDate" name="expectedCloseDate" type="date" defaultValue={addDaysISO(today, 30)} />
              </Field>
            </FormGrid>
            <fieldset>
              <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Services</legend>
              <div className="flex flex-wrap gap-4">
                {L.services.map((s) => <Checkbox key={s.value} name="serviceIds[]" value={s.value} label={s.label} defaultChecked={fits.some((f) => f.serviceId === s.value)} />)}
              </div>
            </fieldset>
          </CardBody>
        </Card>
        <SubmitButton>Convert lead</SubmitButton>
      </ActionForm>
    </>
  );
}

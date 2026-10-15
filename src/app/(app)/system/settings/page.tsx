import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { getSettings } from "@/server/system/settings";
import { saveSettingsAction } from "@/server/actions/system";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";

export const metadata = { title: "Agency settings" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default async function SettingsPage() {
  await guard("system.settings");
  const s = await getSettings(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Agency settings" }]} title="Agency settings" description="Identity shown on documents, financial defaults and thresholds used by dashboards and signals." />
      <ActionForm action={saveSettingsAction} className="max-w-5xl space-y-4">
        <Card>
          <CardHeader title="Agency identity" description="Printed on invoices, credit notes and proposals." />
          <CardBody>
            <FormGrid cols={3}>
              <Field label="Agency name" required><Input name="agencyName" defaultValue={s.agencyName} required /></Field>
              <Field label="Legal name"><Input name="legalName" defaultValue={s.legalName ?? ""} /></Field>
              <Field label="Email"><Input type="email" name="email" defaultValue={s.email ?? ""} /></Field>
              <Field label="Phone"><Input name="phone" defaultValue={s.phone ?? ""} /></Field>
              <Field label="Website"><Input name="website" defaultValue={s.website ?? ""} /></Field>
              <Field label="Tax ID label" hint="e.g. VAT No., TRN, EIN — no jurisdiction is assumed"><Input name="taxIdentifierLabel" defaultValue={s.taxIdentifierLabel ?? "Tax ID"} /></Field>
              <Field label="Tax identifier"><Input name="taxIdentifier" defaultValue={s.taxIdentifier ?? ""} /></Field>
            </FormGrid>
            <Field label="Registered address" className="mt-3"><Textarea name="address" rows={2} defaultValue={s.address ?? ""} /></Field>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Finance defaults" />
          <CardBody>
            <FormGrid cols={3}>
              <Field label="Base currency" hint="Cannot change after ledger entries exist."><Select name="baseCurrency" options={CURRENCIES} defaultValue={s.baseCurrency} /></Field>
              <Field label="Fiscal year starts"><Select name="fiscalYearStartMonth" options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} defaultValue={String(s.fiscalYearStartMonth)} /></Field>
              <Field label="Agency time zone"><Input name="timeZone" defaultValue={s.timeZone} required /></Field>
              <Field label="Invoice number prefix"><Input name="invoicePrefix" defaultValue={s.invoicePrefix} /></Field>
              <Field label="Credit note prefix"><Input name="creditNotePrefix" defaultValue={s.creditNotePrefix} /></Field>
              <Field label="Default payment terms (days)"><Input type="number" min={0} name="defaultPaymentTermsDays" defaultValue={s.defaultPaymentTermsDays} /></Field>
              <Field label={`Minimum cash threshold (${s.baseCurrency})`}><Input name="minimumCashThreshold" inputMode="decimal" defaultValue={s.minimumCashThreshold ?? ""} /></Field>
              <Field label={`Expense approval threshold (${s.baseCurrency})`}><Input name="expenseApprovalThreshold" inputMode="decimal" defaultValue={s.expenseApprovalThreshold ?? ""} /></Field>
            </FormGrid>
            <FormGrid cols={2} className="mt-3">
              <Field label="Payment instructions (on invoices)"><Textarea name="bankDetails" rows={3} defaultValue={s.bankDetails ?? ""} /></Field>
              <Field label="Invoice footer"><Textarea name="invoiceFooter" rows={3} defaultValue={s.invoiceFooter ?? ""} /></Field>
            </FormGrid>
            <div className="mt-3 flex flex-wrap gap-6">
              <Checkbox name="taxSetupComplete" label="Tax setup reviewed with our accountant" defaultChecked={!!s.taxSetupCompletedAt} />
              <Checkbox name="openingBalancesComplete" label="Opening balances entered" defaultChecked={!!s.openingBalancesCompletedAt} />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Signal thresholds" description="Used by the daily dashboard's review signals." />
          <CardBody>
            <FormGrid cols={3}>
              <Field label="Opportunity is stale after (days in stage)"><Input type="number" min={1} name="staleOpportunityDays" defaultValue={s.staleOpportunityDays} /></Field>
              <Field label="Flag renewals this many days ahead"><Input type="number" min={1} name="renewalLeadDays" defaultValue={s.renewalLeadDays} /></Field>
              <Field label="Missing time look-back (working days)"><Input type="number" min={1} name="missingTimeLookbackDays" defaultValue={s.missingTimeLookbackDays} /></Field>
            </FormGrid>
          </CardBody>
        </Card>
        <div className="flex justify-end"><SubmitButton>Save settings</SubmitButton></div>
      </ActionForm>
    </>
  );
}

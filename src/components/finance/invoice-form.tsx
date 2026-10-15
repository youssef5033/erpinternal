import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { createInvoiceAction, saveRecurringAction, updateInvoiceAction } from "@/server/actions/finance";

type Opt = { value: string; label: string };
type Line = { description: string; quantity: string; unitPrice: string; discountPercent?: string | null; taxRateId?: string | null; serviceId?: string | null };

export type InvoiceFormLookups = { accounts: Opt[]; engagements: (Opt & { accountId: string })[]; taxRates: Opt[]; services: Opt[]; contacts: Opt[] };

function Lines({ lines, L, rows }: { lines: Line[]; L: InvoiceFormLookups; rows: number }) {
  return (
    <div className="mt-4">
      <p className="mb-1 text-[13px] font-medium">Lines</p>
      <p className="mb-2 text-[12px] text-muted">Totals, discounts and tax are calculated on the server when you save, using exact decimal arithmetic. Leave unused rows empty.</p>
      <div className="hidden grid-cols-[1fr_70px_110px_70px_150px_150px] gap-2 px-1 text-[11.5px] font-medium uppercase tracking-wide text-muted md:grid">
        <span>Description</span><span>Qty</span><span>Unit price</span><span>Disc %</span><span>Tax</span><span>Service</span>
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => {
          const l = lines[i];
          return (
            <div key={i} className="grid gap-2 rounded-md border border-line p-2 md:grid-cols-[1fr_70px_110px_70px_150px_150px] md:border-0 md:p-0">
              <Input aria-label={`Line ${i + 1} description`} name={`lines.${i}.description`} defaultValue={l?.description} placeholder={i === 0 ? "e.g. Brand strategy — phase 1" : undefined} />
              <Input aria-label={`Line ${i + 1} quantity`} name={`lines.${i}.quantity`} inputMode="decimal" defaultValue={l?.quantity ?? ""} placeholder="1" />
              <Input aria-label={`Line ${i + 1} unit price`} name={`lines.${i}.unitPrice`} inputMode="decimal" defaultValue={l?.unitPrice ?? ""} />
              <Input aria-label={`Line ${i + 1} discount percent`} name={`lines.${i}.discountPercent`} inputMode="decimal" defaultValue={l?.discountPercent && l.discountPercent !== "0.0000" ? l.discountPercent : ""} />
              <Select aria-label={`Line ${i + 1} tax`} name={`lines.${i}.taxRateId`} options={L.taxRates} placeholder="No tax" defaultValue={l?.taxRateId ?? ""} />
              <Select aria-label={`Line ${i + 1} service`} name={`lines.${i}.serviceId`} options={L.services} placeholder="From engagement" defaultValue={l?.serviceId ?? ""} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InvoiceForm({ L, v, lines }: { L: InvoiceFormLookups; v: { id?: string; accountId?: string; engagementId?: string | null; billingContactId?: string | null; currency: string; paymentTermsDays?: number | null; reference?: string | null; notes?: string | null; terms?: string | null; isDeposit?: boolean; revenueTreatment?: string }; lines: Line[] }) {
  return (
    <ActionForm action={v.id ? updateInvoiceAction : createInvoiceAction}>
      {v.id ? <input type="hidden" name="id" value={v.id} /> : null}
      <FormGrid cols={3}>
        <Field label="Client account" required><Select name="accountId" options={L.accounts} placeholder="Choose" defaultValue={v.accountId ?? ""} required /></Field>
        <Field label="Engagement"><Select name="engagementId" options={L.engagements.filter((e) => !v.accountId || e.accountId === v.accountId)} placeholder="—" defaultValue={v.engagementId ?? ""} /></Field>
        <Field label="Billing contact"><Select name="billingContactId" options={L.contacts} placeholder="—" defaultValue={v.billingContactId ?? ""} /></Field>
        <Field label="Currency" required><Select name="currency" options={CURRENCIES} defaultValue={v.currency} /></Field>
        <Field label="Payment terms (days)"><Input type="number" min={0} name="paymentTermsDays" defaultValue={v.paymentTermsDays ?? 14} /></Field>
        <Field label="Reference / PO"><Input name="reference" defaultValue={v.reference ?? ""} /></Field>
        <Field label="Revenue treatment" hint="Deferred: recognised over the engagement. On issue: recognised immediately."><Select name="revenueTreatment" options={[{ value: "deferred", label: "Deferred (per engagement method)" }, { value: "on_issue", label: "Recognise on issue" }]} defaultValue={v.revenueTreatment ?? "deferred"} /></Field>
        <div className="self-end pb-2"><Checkbox name="isDeposit" label="Deposit / advance invoice" defaultChecked={v.isDeposit ?? false} /></div>
      </FormGrid>
      <Lines lines={lines} L={L} rows={Math.max(4, lines.length + 2)} />
      <FormGrid cols={2} className="mt-4">
        <Field label="Notes (shown on invoice)"><Textarea name="notes" rows={2} defaultValue={v.notes ?? ""} /></Field>
        <Field label="Terms"><Textarea name="terms" rows={2} defaultValue={v.terms ?? ""} /></Field>
      </FormGrid>
      <div className="mt-4 flex justify-end"><SubmitButton>{v.id ? "Save draft" : "Create draft invoice"}</SubmitButton></div>
    </ActionForm>
  );
}

export function RecurringForm({ L, baseCurrency, today }: { L: InvoiceFormLookups; baseCurrency: string; today: string }) {
  return (
    <ActionForm action={saveRecurringAction}>
      <FormGrid cols={3}>
        <Field label="Name" required><Input name="name" required placeholder="e.g. Monthly retainer — Solace" /></Field>
        <Field label="Client account" required><Select name="accountId" options={L.accounts} placeholder="Choose" required /></Field>
        <Field label="Engagement"><Select name="engagementId" options={L.engagements} placeholder="—" /></Field>
        <Field label="Frequency"><Select name="frequency" options={[{ value: "monthly", label: "Monthly" }, { value: "quarterly", label: "Quarterly" }, { value: "yearly", label: "Yearly" }]} /></Field>
        <Field label="Next run" required><Input type="date" name="nextRunDate" defaultValue={today} required /></Field>
        <Field label="End"><Input type="date" name="endDate" /></Field>
        <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={baseCurrency} /></Field>
        <Field label="Payment terms (days)"><Input type="number" min={0} name="paymentTermsDays" defaultValue={14} /></Field>
        <div className="self-end pb-2"><Checkbox name="autoIssue" label="Issue automatically (otherwise drafts)" /></div>
      </FormGrid>
      <Lines lines={[]} L={L} rows={3} />
      <div className="mt-4 flex justify-end"><SubmitButton>Create schedule</SubmitButton></div>
    </ActionForm>
  );
}

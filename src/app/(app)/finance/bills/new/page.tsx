import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { agencyToday } from "@/server/system/settings";
import { createBillAction } from "@/server/actions/finance";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { financeLookups, invoiceLookups } from "@/components/finance/lookups";

export const metadata = { title: "New bill" };

export default async function NewBillPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("finance.write");
  const sp = await searchParams;
  const today = await agencyToday(db);
  const L = await financeLookups();
  const T = await invoiceLookups();
  const sup = L.suppliers.find((s) => s.value === sp.supplier);
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Bills & expenses", href: "/finance/bills" }, { label: "New bill" }]} title="New supplier bill" description="Record a bill you received. It posts to accounts payable only when approved. Upload the supplier's PDF on the bill page afterwards." />
      <Card className="max-w-6xl">
        <CardBody>
          <ActionForm action={createBillAction}>
            <FormGrid cols={3}>
              <Field label="Supplier" required><Select name="supplierId" options={L.suppliers} placeholder="Choose" defaultValue={sp.supplier ?? ""} required /></Field>
              <Field label="Supplier's invoice number" hint="Used to block duplicate entry of the same bill."><Input name="supplierReference" /></Field>
              <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={sup?.currency ?? L.banks[0]?.currency ?? "USD"} /></Field>
              <Field label="Bill date" required><Input type="date" name="billDate" defaultValue={today} required /></Field>
              <Field label="Due date" hint="Defaults to the supplier's terms."><Input type="date" name="dueDate" /></Field>
              <Field label="Engagement (direct cost)"><Select name="engagementId" options={L.engagements} placeholder="Overhead (none)" defaultValue={sp.engagement ?? ""} /></Field>
            </FormGrid>
            <Field label="Description" className="mt-3"><Textarea name="description" rows={2} /></Field>
            <p className="mb-1 mt-4 text-[13px] font-medium">Lines (amounts before tax)</p>
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="grid gap-2 md:grid-cols-[1fr_120px_220px_170px_200px]">
                  <Input aria-label={`Line ${i + 1} description`} name={`lines.${i}.description`} placeholder={i === 0 ? "e.g. Photography — campaign shoot" : undefined} />
                  <Input aria-label={`Line ${i + 1} amount`} name={`lines.${i}.amount`} inputMode="decimal" placeholder="Amount" />
                  <Select aria-label={`Line ${i + 1} expense account`} name={`lines.${i}.expenseLedgerAccountId`} options={L.expenseLedgers} placeholder="Expense account" />
                  <Select aria-label={`Line ${i + 1} tax`} name={`lines.${i}.taxRateId`} options={T.purchaseTaxRates} placeholder="No tax" />
                  <Select aria-label={`Line ${i + 1} engagement`} name={`lines.${i}.engagementId`} options={L.engagements} placeholder="Same as bill" />
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center justify-between">
              <Checkbox name="submit" label="Submit for approval now" defaultChecked />
              <SubmitButton>Save bill</SubmitButton>
            </div>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}

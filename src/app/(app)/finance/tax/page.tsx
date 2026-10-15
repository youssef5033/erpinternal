import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { journalEntries, journalLines, ledgerAccounts, taxFilingPeriods, taxRates, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { agencyToday, getSettings } from "@/server/system/settings";
import { isISODate, resolvePeriod } from "@/lib/dates";
import { taxFilingAction, taxRateAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { PERIOD_OPTIONS } from "@/components/crm/analytics-filters";

export const metadata = { title: "Tax & compliance" };

const TREATMENTS = ["standard", "reduced", "zero_rated", "exempt", "reverse_charge", "out_of_scope"] as const;

export default async function TaxPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const p = isISODate(sp.from) && isISODate(sp.to) ? { from: sp.from!, to: sp.to!, label: `${sp.from} → ${sp.to}` } : resolvePeriod(sp.period ?? "quarter", today, s.fiscalYearStartMonth);
  const taxAccs = await db.select().from(ledgerAccounts).where(inArray(ledgerAccounts.systemKey, ["output_tax", "input_tax"]));
  const moves = taxAccs.length
    ? await db.select({ id: journalLines.ledgerAccountId, dr: sql<string>`coalesce(sum(${journalLines.debit}),0)`, cr: sql<string>`coalesce(sum(${journalLines.credit}),0)` }).from(journalLines).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId)).where(and(inArray(journalLines.ledgerAccountId, taxAccs.map((a) => a.id)), gte(journalEntries.entryDate, p.from), lte(journalEntries.entryDate, p.to))).groupBy(journalLines.ledgerAccountId)
    : [];
  const out = taxAccs.find((a) => a.systemKey === "output_tax");
  const inp = taxAccs.find((a) => a.systemKey === "input_tax");
  const outM = moves.find((m) => m.id === out?.id);
  const inM = moves.find((m) => m.id === inp?.id);
  const outputTax = outM ? Number(outM.cr) - Number(outM.dr) : 0;
  const inputTax = inM ? Number(inM.dr) - Number(inM.cr) : 0;
  const rates = await db.select().from(taxRates).orderBy(asc(taxRates.name));
  const filings = await db.select({ f: taxFilingPeriods, owner: user.name }).from(taxFilingPeriods).leftJoin(user, eq(user.id, taxFilingPeriods.ownerId)).orderBy(desc(taxFilingPeriods.dueDate));
  const users = await db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name);
  const canAdmin = can(actor, "finance.admin");
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Tax & compliance" }]} title="Tax & compliance" description="Configurable tax rates, a tax summary from the ledger, and a tracker for filings made outside this system." />
      <Notice tone="warning" className="mb-4" title="No jurisdiction is assumed">This system does not file returns or claim compliance with any tax authority's rules. Figures are a ledger summary to help your accountant prepare filings; confirm treatment, rates and deadlines with a qualified adviser.</Notice>
      <FilterBar fields={[{ type: "select", name: "period", label: "Period", options: PERIOD_OPTIONS, allLabel: "This quarter" }, { type: "date", name: "from", label: "From" }, { type: "date", name: "to", label: "To" }]} />
      <Card className="mb-4 max-w-3xl">
        <CardHeader title={`Tax summary — ${p.label}`} description={`${p.from} → ${p.to}, ${s.baseCurrency}, from posted movements on the output and input tax accounts (issue/approval date basis).`} />
        <Table>
          <tbody>
            <TR><TD>Output tax charged on sales (net of credit notes)</TD><TD align="right"><Money value={outputTax.toFixed(2)} currency={s.baseCurrency} /></TD></TR>
            <TR><TD>Input tax on purchases and expenses</TD><TD align="right"><Money value={inputTax.toFixed(2)} currency={s.baseCurrency} /></TD></TR>
            <TR className="font-semibold"><TD>Net position ({outputTax - inputTax >= 0 ? "payable" : "reclaimable"})</TD><TD align="right"><Money value={(outputTax - inputTax).toFixed(2)} currency={s.baseCurrency} /></TD></TR>
          </tbody>
        </Table>
        <p className="px-4 py-2 text-[12px] text-muted">Cash-basis or partial-exemption schemes are not modelled. Review the ledger detail under Reports → General ledger for accounts {out?.code} and {inp?.code}.</p>
      </Card>
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Tax rates" description="Rates are copied onto each line when a document is created, so changing a rate never alters issued documents." />
          {rates.length ? (
            <Table>
              <THead><tr><TH>Name</TH><TH align="right">Rate</TH><TH>Treatment</TH><TH>Applies to</TH><TH>Status</TH></tr></THead>
              <tbody>{rates.map((r) => <TR key={r.id}><TD className="font-medium">{r.name}{r.description ? <div className="text-[12px] font-normal text-muted">{r.description}</div> : null}</TD><TD align="right">{Number(r.ratePercent)}%</TD><TD>{r.treatment.replace("_", " ")}</TD><TD>{r.appliesTo}</TD><TD>{r.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>}</TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="No tax rates configured" description="Add the rates your accountant confirms apply to you." />}
        </Card>
        {canAdmin ? (
          <Card>
            <CardHeader title="Add tax rate" />
            <CardBody>
              <ActionForm action={taxRateAction} resetOnSuccess>
                <FormGrid cols={2}>
                  <Field label="Name"><Input name="name" required placeholder="e.g. Standard rate" /></Field>
                  <Field label="Rate %"><Input name="ratePercent" inputMode="decimal" required /></Field>
                  <Field label="Treatment"><Select name="treatment" options={TREATMENTS.map((t) => ({ value: t, label: t.replace("_", " ") }))} /></Field>
                  <Field label="Applies to"><Select name="appliesTo" options={[{ value: "both", label: "Sales and purchases" }, { value: "sales", label: "Sales" }, { value: "purchases", label: "Purchases" }]} /></Field>
                </FormGrid>
                <Field label="Description" className="mt-2"><Input name="description" /></Field>
                <div className="mt-2 flex items-center justify-between"><Checkbox name="active" label="Active" defaultChecked /><SubmitButton size="sm">Add rate</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
      <Card className="mt-4">
        <CardHeader title="Filing tracker" description="Deadlines and status for returns your accountant files with the authority. Marking 'filed externally' requires the confirmation reference." />
        {filings.length ? (
          <Table>
            <THead><tr><TH>Filing</TH><TH>Period</TH><TH>Due</TH><TH>Owner</TH><TH>Status</TH>{canAdmin ? <TH>Update</TH> : null}</tr></THead>
            <tbody>
              {filings.map(({ f, owner }) => (
                <TR key={f.id}>
                  <TD className="font-medium">{f.name}<div className="text-[12px] font-normal text-muted">{f.taxType}{f.notes ? ` · ${f.notes}` : ""}</div></TD>
                  <TD className="text-[12.5px]"><DateText value={f.periodStart} /> – <DateText value={f.periodEnd} /></TD>
                  <TD><DateText value={f.dueDate} overdue={f.dueDate < today && !["filed_externally", "not_required"].includes(f.status)} /></TD>
                  <TD>{owner ?? "—"}</TD>
                  <TD><StatusBadge status={f.status} label={f.status.replace("_", " ")} />{f.filedReference ? <div className="text-[12px] text-muted">ref {f.filedReference}</div> : null}</TD>
                  {canAdmin ? (
                    <TD>
                      <ActionForm action={taxFilingAction} className="flex flex-wrap gap-1" hideSuccess>
                        <input type="hidden" name="id" value={f.id} />
                        <Select name="status" aria-label="Status" options={["open", "in_preparation", "filed_externally", "not_required"].map((v) => ({ value: v, label: v.replace("_", " ") }))} defaultValue={f.status} className="h-8" />
                        <Input name="filedReference" aria-label="Filing reference" placeholder="Reference" defaultValue={f.filedReference ?? ""} className="h-8 w-32" />
                        <SubmitButton size="sm" variant="secondary">Save</SubmitButton>
                      </ActionForm>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No filings tracked" />}
        {canAdmin ? (
          <CardBody className="border-t border-line">
            <ActionForm action={taxFilingAction} resetOnSuccess>
              <input type="hidden" name="status" value="open" />
              <FormGrid cols={4}>
                <Field label="Name"><Input name="name" placeholder="e.g. Q4 indirect tax return" /></Field>
                <Field label="Tax type"><Input name="taxType" placeholder="e.g. Indirect tax" /></Field>
                <Field label="Period start"><Input type="date" name="periodStart" /></Field>
                <Field label="Period end"><Input type="date" name="periodEnd" /></Field>
                <Field label="Due date"><Input type="date" name="dueDate" /></Field>
                <Field label="Owner"><Select name="ownerId" options={users} defaultValue={actor.userId} /></Field>
                <Field label="Notes"><Input name="notes" /></Field>
                <div className="self-end"><SubmitButton size="sm">Add to tracker</SubmitButton></div>
              </FormGrid>
            </ActionForm>
          </CardBody>
        ) : null}
      </Card>
    </>
  );
}

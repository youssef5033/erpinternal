import Link from "next/link";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, billingScheduleItems, contracts, invoices, servicePeriods } from "@/db/schema";
import type { engagements } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { invoiceVisibility } from "@/server/auth/scope";
import { isOverdue, statusFromOutstanding, listInvoicesWithBalances } from "@/server/finance/invoices";
import { recognitionPlan, recognitionSummary } from "@/server/finance/revenue";
import { billingItemAction } from "@/server/actions/finance";
import { contractStatusAction, renewRetainerAction, saveContractAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";

type Eng = typeof engagements.$inferSelect;

export async function BillingTab({ actor, e, today }: { actor: Actor; e: Eng; today: string }) {
  if (!can(actor, "finance.read")) return <Notice>Billing and invoices need finance access.</Notice>;
  const items = await db.select().from(billingScheduleItems).where(eq(billingScheduleItems.engagementId, e.id)).orderBy(asc(billingScheduleItems.plannedDate));
  const invs = await listInvoicesWithBalances(db, and(eq(invoices.engagementId, e.id), invoiceVisibility(actor)));
  const rec = await recognitionSummary(db, e.id);
  const plan = await recognitionPlan(db, e.id, today).catch(() => [] as Awaited<ReturnType<typeof recognitionPlan>>);
  const canWrite = can(actor, "finance.write");
  const scheduled = items.filter((i) => i.status !== "cancelled").reduce((a, i) => a + Number(i.amount), 0);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Billing schedule" description={<>What will be invoiced and when. Total scheduled <Money value={scheduled.toFixed(2)} currency={e.currency} /> vs contract value <Money value={e.contractValue} currency={e.currency} />. Drafts are confirmed by finance before invoicing.</>} />
        {items.length ? (
          <Table>
            <THead><tr><TH>Item</TH><TH>Planned</TH><TH align="right">Amount</TH><TH>Source</TH><TH>Status</TH>{canWrite ? <TH /> : null}</tr></THead>
            <tbody>
              {items.map((i) => (
                <TR key={i.id}>
                  <TD>{i.label}{i.isDeposit ? <Badge className="ml-1">deposit</Badge> : null}{i.milestoneId ? <Badge tone="info" className="ml-1">on milestone acceptance</Badge> : null}</TD>
                  <TD><DateText value={i.plannedDate} /></TD>
                  <TD align="right"><Money value={i.amount} currency={i.currency} /></TD>
                  <TD className="text-[12.5px]">{i.source.replace("_", " ")}</TD>
                  <TD><StatusBadge status={i.status} />{i.invoiceId ? <Link className="ml-2 text-[12.5px] text-accent hover:underline" href={`/finance/invoices/${i.invoiceId}`}>invoice</Link> : null}</TD>
                  {canWrite ? (
                    <TD align="right">
                      {i.status === "draft" || i.status === "planned" ? (
                        <ActionForm action={billingItemAction} className="flex justify-end gap-1" hideSuccess>
                          <input type="hidden" name="id" value={i.id} />
                          {i.status === "draft" ? <SubmitButton size="sm" variant="secondary" name="op" value="confirm">Confirm</SubmitButton> : null}
                          {!i.milestoneId || i.status === "planned" ? <SubmitButton size="sm" variant="ghost" name="op" value="invoice">Draft invoice now</SubmitButton> : null}
                        </ActionForm>
                      ) : null}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No billing schedule" description="Hourly engagements are invoiced from approved time; others get a schedule at handover." />}
      </Card>

      <Card>
        <CardHeader title="Invoices" actions={canWrite ? <Link className="text-[13px] text-accent hover:underline" href={`/finance/invoices/new?account=${e.accountId}&engagement=${e.id}`}>New invoice</Link> : null} />
        {invs.length ? (
          <Table>
            <THead><tr><TH>Number</TH><TH>Issued</TH><TH>Due</TH><TH align="right">Total</TH><TH align="right">Outstanding</TH><TH>Status</TH></tr></THead>
            <tbody>
              {invs.map(({ invoice: i, outstanding }) => {
                const st = statusFromOutstanding(i, outstanding);
                return (
                  <TR key={i.id}>
                    <TD><Link className="font-medium hover:underline" href={`/finance/invoices/${i.id}`}>{i.number ?? "Draft"}</Link></TD>
                    <TD><DateText value={i.issueDate} /></TD>
                    <TD><DateText value={i.dueDate} overdue={isOverdue(i, outstanding, today)} /></TD>
                    <TD align="right"><Money value={i.total} currency={i.currency} /></TD>
                    <TD align="right"><Money value={i.status === "issued" ? outstanding : null} currency={i.currency} /></TD>
                    <TD><StatusBadge status={st} /></TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No invoices yet" />}
      </Card>

      <Card>
        <CardHeader title="Revenue recognition" description={<>Method: <b>{e.recognitionMethod.replace(/_/g, " ")}</b>. Recognised to date <Money value={rec.total} currency={e.currency} />. Recognition runs as a scheduled job and is idempotent per period.</>} />
        {rec.rows.length || plan.length ? (
          <Table>
            <THead><tr><TH>Period</TH><TH align="right">Amount</TH><TH>Basis</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rec.rows.map((r) => <TR key={r.id}><TD><DateText value={r.periodStart} /> – <DateText value={r.periodEnd} /></TD><TD align="right"><Money value={r.amount} currency={e.currency} /></TD><TD className="text-[12.5px]">{r.basis}</TD><TD><StatusBadge status={r.status} /></TD></TR>)}
              {plan.filter((p) => !rec.rows.some((r) => r.recognitionKey === p.key)).map((p) => <TR key={p.key}><TD><DateText value={p.periodStart} /> – <DateText value={p.periodEnd} /></TD><TD align="right"><Money value={p.amount} currency={e.currency} /></TD><TD className="text-[12.5px]">{p.basis}</TD><TD><Badge tone="info">due to post</Badge></TD></TR>)}
            </tbody>
          </Table>
        ) : <EmptyState title="Nothing recognised yet" />}
      </Card>
    </div>
  );
}

export async function RenewalTab({ actor, e, today }: { actor: Actor; e: Eng; today: string }) {
  const periods = await db.select().from(servicePeriods).where(eq(servicePeriods.engagementId, e.id)).orderBy(desc(servicePeriods.periodNumber));
  const last = periods[0];
  const canRenew = (can(actor, "delivery.write") || can(actor, "finance.write")) && e.billingModel === "retainer" && ["active", "onboarding", "on_hold"].includes(e.status);
  const dueBy = e.renewalDate ?? e.endDate;
  const noticeBy = dueBy && e.noticePeriodDays ? new Date(new Date(`${dueBy}T00:00:00Z`).getTime() - e.noticePeriodDays * 86400000).toISOString().slice(0, 10) : null;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Renewal" />
        <CardBody>
          <p className="text-[13.5px]">Renewal / end date: <DateText value={dueBy} overdue={!!dueBy && dueBy < today} />{e.autoRenew ? <Badge className="ml-2">auto-renews</Badge> : null}</p>
          {noticeBy ? <p className="mt-1 text-[13px] text-muted">Notice deadline ({e.noticePeriodDays} days): <DateText value={noticeBy} overdue={noticeBy < today} /></p> : null}
          <p className="mt-3 text-[13px]">
            {can(actor, "crm.write") ? <Link className="text-accent hover:underline" href={`/crm/opportunities/new?account=${e.accountId}&kind=renewal&engagement=${e.id}`}>Open a renewal opportunity</Link> : null}
            {can(actor, "crm.write") ? <> · <Link className="text-accent hover:underline" href={`/crm/opportunities/new?account=${e.accountId}&kind=expansion&engagement=${e.id}`}>Open an expansion opportunity</Link></> : null}
          </p>
        </CardBody>
      </Card>
      {e.billingModel === "retainer" ? (
        <Card>
          <CardHeader title="Service periods" description="Each retainer period has its own fee and monthly billing items. Renewing adds the next period once — repeating the action cannot create a duplicate." />
          {periods.length ? (
            <Table>
              <THead><tr><TH>#</TH><TH>Period</TH><TH align="right">Fee</TH><TH>Status</TH></tr></THead>
              <tbody>{periods.map((p) => <TR key={p.id}><TD>{p.periodNumber}</TD><TD><DateText value={p.startDate} /> – <DateText value={p.endDate} /></TD><TD align="right"><Money value={p.fee} currency={p.currency} /></TD><TD><StatusBadge status={p.status} /></TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="No service periods" />}
          {canRenew ? (
            <CardBody className="border-t border-line">
              <ActionForm action={renewRetainerAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="id" value={e.id} />
                <input type="hidden" name="expectedPeriodNumber" value={(last?.periodNumber ?? 0) + 1} />
                <Field label={`New fee per period (${e.currency})`}><Input name="fee" inputMode="decimal" defaultValue={e.retainerAmount ?? ""} /></Field>
                <Field label="Months"><Input type="number" min={1} name="months" defaultValue={e.retainerPeriodMonths ?? 1} /></Field>
                <SubmitButton confirm="Renew the retainer for another period? This creates billing items.">Renew for period {(last?.periodNumber ?? 0) + 1}</SubmitButton>
              </ActionForm>
            </CardBody>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

export async function ContractsTab({ actor, e, today }: { actor: Actor; e: Eng; today: string }) {
  const rows = await db.select({ c: contracts, accountName: accounts.name }).from(contracts).innerJoin(accounts, eq(accounts.id, contracts.accountId)).where(eq(contracts.engagementId, e.id)).orderBy(desc(contracts.createdAt));
  const canWrite = can(actor, "delivery.write") || can(actor, "crm.write");
  const showValue = can(actor, "finance.read") || can(actor, "crm.read");
  return (
    <div className="space-y-4">
      {!rows.some((r) => ["signed", "active"].includes(r.c.status)) ? <Notice tone="warning">No signed contract is recorded for this engagement.</Notice> : null}
      {rows.map(({ c }) => (
        <Card key={c.id}>
          <CardHeader title={<span className="flex items-center gap-2">{c.title}<StatusBadge status={c.status} /></span>} description={<>{c.number} · {c.contractType.toUpperCase().replace("_", " ")} · <DateText value={c.startDate} /> – <DateText value={c.endDate} overdue={!!c.endDate && c.endDate < today} />{showValue && c.value ? <> · <Money value={c.value} currency={c.currency} /></> : null}</>} />
          <CardBody>
            {c.signedAt ? <p className="text-[13px]">Signed <DateText value={c.signedAt} /> — {c.signatureMethod?.replace(/_/g, " ")}: {c.signatureEvidence}</p> : <p className="text-[13px] text-muted">Not signed. Signatures are recorded with evidence; no e-signature provider is connected.</p>}
            {canWrite && !["expired", "terminated"].includes(c.status) ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[13px] font-medium text-accent">Update status</summary>
                <ActionForm action={contractStatusAction} className="mt-2 space-y-2">
                  <input type="hidden" name="id" value={c.id} />
                  {c.status === "draft" || c.status === "sent" ? (
                    <FormGrid cols={3}>
                      <Field label="Signed on"><Input type="date" name="signedAt" defaultValue={today} /></Field>
                      <Field label="Method"><Select name="signatureMethod" options={[{ value: "signed_document", label: "Signed document on file" }, { value: "manual_record", label: "Manual record" }]} /></Field>
                      <Field label="Evidence"><Input name="signatureEvidence" placeholder="e.g. countersigned PDF uploaded to Documents" /></Field>
                    </FormGrid>
                  ) : null}
                  <Field label="Note"><Input name="note" /></Field>
                  <div className="flex flex-wrap gap-2">
                    {c.status === "draft" ? <SubmitButton size="sm" variant="secondary" name="status" value="sent">Mark sent</SubmitButton> : null}
                    {c.status === "draft" || c.status === "sent" ? <SubmitButton size="sm" name="status" value="signed">Record signature</SubmitButton> : null}
                    {c.status === "signed" ? <SubmitButton size="sm" name="status" value="active">Mark active</SubmitButton> : null}
                    {c.status === "signed" || c.status === "active" ? <SubmitButton size="sm" variant="secondary" name="status" value="expired">Mark expired</SubmitButton> : null}
                    <SubmitButton size="sm" variant="danger" name="status" value="terminated" confirm="Terminate this contract?">Terminate</SubmitButton>
                  </div>
                </ActionForm>
              </details>
            ) : null}
          </CardBody>
        </Card>
      ))}
      {canWrite ? (
        <Card>
          <CardHeader title="Add contract" description="Upload the signed file under Documents (type: contract)." />
          <CardBody>
            <ActionForm action={saveContractAction} resetOnSuccess>
              <input type="hidden" name="accountId" value={e.accountId} />
              <input type="hidden" name="engagementId" value={e.id} />
              <FormGrid cols={3}>
                <Field label="Title" required><Input name="title" required defaultValue={`${e.name} — SOW`} /></Field>
                <Field label="Type"><Select name="contractType" options={["sow", "msa", "retainer", "nda", "change_order", "other"].map((v) => ({ value: v, label: v.toUpperCase().replace("_", " ") }))} /></Field>
                <Field label="Owner"><Select name="ownerId" options={[{ value: actor.userId, label: "Me" }]} defaultValue={actor.userId} /></Field>
                <Field label="Start"><Input type="date" name="startDate" defaultValue={e.startDate ?? ""} /></Field>
                <Field label="End"><Input type="date" name="endDate" defaultValue={e.endDate ?? ""} /></Field>
                <Field label="Notice period (days)"><Input type="number" min={0} name="noticePeriodDays" defaultValue={e.noticePeriodDays ?? ""} /></Field>
                <Field label="Value"><Input name="value" inputMode="decimal" defaultValue={e.contractValue} /></Field>
                <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={e.currency} /></Field>
                <div className="self-end pb-2"><Checkbox name="autoRenew" label="Auto-renews" defaultChecked={e.autoRenew} /></div>
              </FormGrid>
              <div className="mt-3 flex justify-end"><SubmitButton>Add contract</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

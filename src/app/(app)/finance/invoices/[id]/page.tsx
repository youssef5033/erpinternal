import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, creditNotes, customerPayments, engagements, invoiceLines, invoices, journalEntries, paymentAllocations, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { invoiceVisibility } from "@/server/auth/scope";
import { daysOverdue, derivePaymentStatus, invoiceBalances, isOverdue } from "@/server/finance/invoices";
import { accountCredit } from "@/server/finance/payments";
import { agencyToday } from "@/server/system/settings";
import { creditNoteAction, invoiceWorkflowAction, reversePaymentAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel, TasksPanel, listUsers } from "@/components/records/panels";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("finance.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db
    .select({ i: invoices, accountName: accounts.name, engName: engagements.name, engNumber: engagements.number, contactName: contacts.fullName, issuedBy: user.name })
    .from(invoices)
    .innerJoin(accounts, eq(accounts.id, invoices.accountId))
    .leftJoin(engagements, eq(engagements.id, invoices.engagementId))
    .leftJoin(contacts, eq(contacts.id, invoices.billingContactId))
    .leftJoin(user, eq(user.id, invoices.issuedBy))
    .where(and(eq(invoices.id, id), invoiceVisibility(actor)));
  if (!row) notFound();
  const i = row.i;
  const today = await agencyToday(db);
  const lines = await db.select({ l: invoiceLines, serviceName: services.name }).from(invoiceLines).leftJoin(services, eq(services.id, invoiceLines.serviceId)).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.sortOrder));
  const [bal] = await invoiceBalances(db, [id]);
  const allocs = await db.select({ a: paymentAllocations, p: customerPayments }).from(paymentAllocations).innerJoin(customerPayments, eq(customerPayments.id, paymentAllocations.paymentId)).where(eq(paymentAllocations.invoiceId, id)).orderBy(asc(paymentAllocations.allocationDate));
  const cns = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, id));
  const sourceIds = [id, ...cns.map((c) => c.id), ...allocs.map((a) => a.a.id)];
  const journals = await db.select().from(journalEntries).where(inArray(journalEntries.sourceId, sourceIds)).orderBy(asc(journalEntries.postedAt));
  const credit = i.status === "issued" ? await accountCredit(db, i.accountId) : [];
  const status = bal ? derivePaymentStatus(i, bal) : i.status;
  const overdue = bal ? isOverdue(i, bal.outstanding, today) : false;
  const canWrite = can(actor, "finance.write");
  const canPost = can(actor, "finance.post");
  const users = await listUsers();
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Finance" }, { label: "Invoices", href: "/finance/invoices" }, { label: i.number ?? "Draft" }]}
        title={i.number ? `Invoice ${i.number}` : "Draft invoice"}
        meta={<><StatusBadge status={status} />{overdue ? <Badge tone="danger">{daysOverdue(i.dueDate, today)} days overdue</Badge> : null}{i.isDeposit ? <Badge>deposit</Badge> : null}</>}
        description={<><Link className="hover:underline" href={`/crm/accounts/${i.accountId}?tab=financials`}>{row.accountName}</Link>{i.engagementId ? <> · <Link className="hover:underline" href={`/delivery/engagements/${i.engagementId}?tab=billing`}>{row.engNumber} {row.engName}</Link></> : null}</>}
        actions={
          <>
            <a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href={`/api/invoices/${id}/pdf`}>{i.status === "issued" ? "Download PDF" : "Preview PDF"}</a>
            {i.status === "draft" && canWrite ? <LinkButton href={`/finance/invoices/${id}/edit`}>Edit</LinkButton> : null}
            {i.status === "issued" && canWrite && bal && Number(bal.outstanding) > 0 ? <LinkButton variant="primary" href={`/finance/collections?tab=record&account=${i.accountId}&invoice=${id}`}>Record payment</LinkButton> : null}
          </>
        }
      />
      {i.status === "draft" ? <Notice className="mb-4" title="Draft">Drafts have no ledger impact and no number. Issuing assigns the next number, locks the content and posts it. Issuing does not send anything — download the PDF and send it yourself.</Notice> : null}
      {i.status === "void" ? <Notice tone="warning" className="mb-4" title="Void">Voided {i.voidedAt ? <DateTimeText value={i.voidedAt} /> : null}: {i.voidReason}. Its postings were reversed.</Notice> : null}
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <Card>
            <Table>
              <THead><tr><TH>Description</TH><TH align="right">Qty</TH><TH align="right">Unit price</TH><TH align="right">Disc</TH><TH align="right">Tax</TH><TH align="right">Line total</TH></tr></THead>
              <tbody>
                {lines.map(({ l, serviceName }) => (
                  <TR key={l.id}>
                    <TD>{l.description}{serviceName ? <div className="text-[12px] text-muted">{serviceName}</div> : null}</TD>
                    <TD align="right">{Number(l.quantity)}</TD>
                    <TD align="right"><Money value={l.unitPrice} currency={i.currency} /></TD>
                    <TD align="right">{Number(l.discountPercent) ? `${Number(l.discountPercent)}%` : "—"}</TD>
                    <TD align="right">{Number(l.taxRatePercent) ? <><Money value={l.lineTax} currency={i.currency} /><div className="text-[11.5px] text-muted">{Number(l.taxRatePercent)}%</div></> : "—"}</TD>
                    <TD align="right"><Money value={l.lineTotal} currency={i.currency} /></TD>
                  </TR>
                ))}
              </tbody>
            </Table>
            <dl className="ml-auto w-full max-w-xs space-y-1 px-4 py-3 text-[13px]">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd><Money value={i.subtotal} currency={i.currency} /></dd></div>
              {Number(i.discountTotal) ? <div className="flex justify-between"><dt className="text-muted">Discount</dt><dd>−<Money value={i.discountTotal} currency={i.currency} /></dd></div> : null}
              <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd><Money value={i.taxTotal} currency={i.currency} /></dd></div>
              <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Total</dt><dd><Money value={i.total} currency={i.currency} /></dd></div>
              {bal && i.status === "issued" ? (
                <>
                  <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd><Money value={bal.allocated} currency={i.currency} /></dd></div>
                  {Number(bal.credited) ? <div className="flex justify-between"><dt className="text-muted">Credited</dt><dd><Money value={bal.credited} currency={i.currency} /></dd></div> : null}
                  <div className="flex justify-between font-semibold"><dt>Outstanding</dt><dd><Money value={bal.outstanding} currency={i.currency} /></dd></div>
                </>
              ) : null}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Payments applied" />
            {allocs.length ? (
              <Table>
                <THead><tr><TH>Payment</TH><TH>Applied on</TH><TH align="right">Amount</TH><TH>Status</TH>{canPost ? <TH /> : null}</tr></THead>
                <tbody>
                  {allocs.map(({ a, p }) => (
                    <TR key={a.id}>
                      <TD>{p.number} · {p.method.replace("_", " ")}{p.reference ? <div className="text-[12px] text-muted">{p.reference}</div> : null}</TD>
                      <TD><DateText value={a.allocationDate} /></TD>
                      <TD align="right"><Money value={a.amount} currency={i.currency} /></TD>
                      <TD>{a.reversedAt ? <Badge tone="warning">reversed</Badge> : <Badge tone="success">applied</Badge>}</TD>
                      {canPost ? <TD align="right">{!a.reversedAt ? <details><summary className="cursor-pointer text-[12.5px] text-accent">Reverse</summary><ActionForm action={reversePaymentAction} className="mt-1 flex gap-1"><input type="hidden" name="id" value={a.id} /><input type="hidden" name="kind" value="allocation" /><Input name="reason" aria-label="Reason" placeholder="Reason" required className="h-8" /><SubmitButton size="sm" variant="danger">Reverse</SubmitButton></ActionForm></details> : null}</TD> : null}
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="No payments applied" />}
            {credit.length && bal && Number(bal.outstanding) > 0 ? <CardBody className="border-t border-line"><p className="text-[13px]">This client has unapplied credit: {credit.map((c) => <span key={c.currency} className="mr-2"><Money value={c.credit} currency={c.currency} /></span>)} — apply it from <Link className="text-accent hover:underline" href={`/finance/collections?tab=payments&account=${i.accountId}`}>Payments</Link>.</p></CardBody> : null}
          </Card>

          {cns.length || (i.status === "issued" && canPost) ? (
            <Card>
              <CardHeader title="Credit notes" />
              {cns.length ? (
                <ul className="divide-y divide-line text-[13px]">{cns.map((c) => <li key={c.id} className="flex justify-between px-4 py-2"><span>{c.number} · <DateText value={c.issueDate} /> · {c.reason}</span><span className="flex items-center gap-3"><Money value={c.total} currency={c.currency} />{c.status === "issued" ? <a className="text-accent hover:underline" href={`/api/invoices/${id}/pdf?creditNote=${c.id}`}>PDF</a> : null}</span></li>)}</ul>
              ) : <CardBody><p className="text-[13px] text-muted">None issued.</p></CardBody>}
              {i.status === "issued" && canPost && bal && Number(bal.outstanding) > 0 ? (
                <CardBody className="border-t border-line">
                  <details>
                    <summary className="cursor-pointer text-[13px] font-medium text-accent">Issue a credit note</summary>
                    <ActionForm action={creditNoteAction} className="mt-2">
                      <input type="hidden" name="invoiceId" value={id} />
                      <FormGrid cols={3}>
                        <Field label={`Gross amount (${i.currency}, incl. tax)`}><Input name="grossAmount" inputMode="decimal" required /></Field>
                        <Field label="Date"><Input type="date" name="issueDate" defaultValue={today} /></Field>
                        <Field label="Reason" required><Input name="reason" required /></Field>
                      </FormGrid>
                      <p className="mt-2 text-[12px] text-muted">Tax is reversed proportionally to the invoice's tax. The credit cannot exceed the outstanding balance.</p>
                      <div className="mt-2 flex justify-end"><SubmitButton confirm="Issue this credit note? It is posted immediately.">Issue credit note</SubmitButton></div>
                    </ActionForm>
                  </details>
                </CardBody>
              ) : null}
            </Card>
          ) : null}

          <TasksPanel actor={actor} link={{ invoiceId: id }} users={users} title="Collection follow-ups" />
          <DocumentsPanel actor={actor} link={{ invoiceId: id }} defaultType="other" />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={1} items={[
                { label: "Issue date", value: <DateText value={i.issueDate} /> },
                { label: "Due date", value: <DateText value={i.dueDate} overdue={overdue} /> },
                { label: "Terms", value: `${i.paymentTermsDays} days` },
                { label: "Billing contact", value: row.contactName ?? "—" },
                { label: "Reference", value: i.reference ?? "—" },
                { label: "Revenue treatment", value: i.revenueTreatment === "deferred" ? "Deferred — recognised per engagement method" : "Recognised on issue" },
                { label: "Exchange rate", value: i.status === "issued" ? `${Number(i.exchangeRate)} (locked at issue)` : "Set when issued" },
                { label: "Issued by", value: i.issuedAt ? <>{row.issuedBy} · <DateTimeText value={i.issuedAt} /></> : "—" },
              ]} />
            </CardBody>
          </Card>
          {(i.status === "draft" && (canWrite || canPost)) || (i.status === "issued" && canPost && bal && Number(bal.allocated) === 0) ? (
            <Card>
              <CardHeader title="Actions" />
              <CardBody>
                <ActionForm action={invoiceWorkflowAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  {i.status === "draft" ? (
                    <>
                      {canPost ? <Field label="Issue date"><Input type="date" name="issueDate" defaultValue={today} /></Field> : null}
                      <div className="flex flex-wrap gap-2">
                        {canPost ? <SubmitButton name="op" value="issue" confirm="Issue this invoice? It gets the next number and becomes immutable.">Issue invoice</SubmitButton> : <p className="text-[12.5px] text-muted">Someone with posting rights must issue it.</p>}
                        {canWrite ? <SubmitButton variant="ghost" name="op" value="delete" confirm="Delete this draft?">Delete draft</SubmitButton> : null}
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label="Reason for voiding"><Input name="reason" /></Field>
                      <SubmitButton variant="danger" name="op" value="void" confirm="Void this invoice? Its postings are reversed. Use a credit note for partial corrections.">Void invoice</SubmitButton>
                      <p className="text-[12px] text-muted">Only possible when no payments are applied.</p>
                    </>
                  )}
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Ledger postings" description="Read-only. Reversals are separate entries." />
            {journals.length ? (
              <ul className="divide-y divide-line text-[13px]">{journals.map((j) => <li key={j.id} className="px-4 py-2"><Link className="font-medium hover:underline" href={`/finance/accounting/journals/${j.id}`}>{j.number}</Link> · <DateText value={j.entryDate} /> · {j.sourceType.replace(/_/g, " ")}<div className="text-[12px] text-muted">{j.memo}</div></li>)}</ul>
            ) : <EmptyState title="No postings (draft)" />}
          </Card>
          <AuditPanel actor={actor} entityType="invoice" entityId={id} />
        </div>
      </div>
    </>
  );
}

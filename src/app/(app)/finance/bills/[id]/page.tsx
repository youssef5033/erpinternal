import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { billLines, bills, engagements, journalEntries, ledgerAccounts, supplierPaymentAllocations, supplierPayments, suppliers, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { billOutstandingSql } from "@/server/finance/payables";
import { agencyToday } from "@/server/system/settings";
import { billWorkflowAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel } from "@/components/records/panels";

export const metadata = { title: "Bill" };

export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("finance.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db.select({ b: bills, supplierName: suppliers.name, outstanding: billOutstandingSql, engName: engagements.name, submitter: user.name }).from(bills).innerJoin(suppliers, eq(suppliers.id, bills.supplierId)).leftJoin(engagements, eq(engagements.id, bills.engagementId)).leftJoin(user, eq(user.id, bills.submittedBy)).where(eq(bills.id, id));
  if (!row) notFound();
  const b = row.b;
  const today = await agencyToday(db);
  const lines = await db.select({ l: billLines, acc: ledgerAccounts.name, code: ledgerAccounts.code, engName: engagements.name }).from(billLines).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, billLines.expenseLedgerAccountId)).leftJoin(engagements, eq(engagements.id, billLines.engagementId)).where(eq(billLines.billId, id)).orderBy(asc(billLines.sortOrder));
  const pays = await db.select({ a: supplierPaymentAllocations, p: supplierPayments }).from(supplierPaymentAllocations).innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentAllocations.supplierPaymentId)).where(eq(supplierPaymentAllocations.billId, id));
  const journals = await db.select().from(journalEntries).where(inArray(journalEntries.sourceId, [id, ...pays.map((p) => p.p.id)])).orderBy(asc(journalEntries.postedAt));
  const [approver] = b.approvedBy ? await db.select({ name: user.name }).from(user).where(eq(user.id, b.approvedBy)) : [];
  const canPost = can(actor, "finance.post");
  const selfSubmitted = b.submittedBy === actor.userId;
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Finance" }, { label: "Bills & expenses", href: "/finance/bills" }, { label: b.number }]}
        title={`Bill ${b.number}`}
        meta={<><StatusBadge status={b.status === "approved" && Number(row.outstanding) <= 0 ? "paid" : b.status} />{b.status === "approved" && Number(row.outstanding) > 0 && b.dueDate < today ? <Badge tone="danger">overdue</Badge> : null}</>}
        description={<><Link className="hover:underline" href={`/finance/suppliers/${b.supplierId}`}>{row.supplierName}</Link>{b.supplierReference ? ` · supplier ref ${b.supplierReference}` : ""}</>}
        actions={b.status === "approved" && Number(row.outstanding) > 0 && canPost ? <LinkButton variant="primary" href={`/finance/bills?tab=pay&supplier=${b.supplierId}`}>Record payment</LinkButton> : null}
      />
      {b.status === "void" ? <Notice tone="warning" className="mb-4">Void: {b.voidReason}</Notice> : null}
      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <Card>
            <Table>
              <THead><tr><TH>Description</TH><TH>Expense account</TH><TH>Engagement</TH><TH align="right">Amount</TH><TH align="right">Tax</TH></tr></THead>
              <tbody>{lines.map(({ l, acc, code, engName }) => <TR key={l.id}><TD>{l.description}</TD><TD className="text-[12.5px]">{code} {acc}</TD><TD className="text-[12.5px]">{l.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${l.engagementId}?tab=budget`}>{engName}</Link> : "Overhead"}</TD><TD align="right"><Money value={l.amount} currency={b.currency} /></TD><TD align="right">{Number(l.taxAmount) ? <Money value={l.taxAmount} currency={b.currency} /> : "—"}</TD></TR>)}</tbody>
            </Table>
            <dl className="ml-auto max-w-xs space-y-1 px-4 py-3 text-[13px]">
              <div className="flex justify-between"><dt className="text-muted">Subtotal</dt><dd><Money value={b.subtotal} currency={b.currency} /></dd></div>
              <div className="flex justify-between"><dt className="text-muted">Tax</dt><dd><Money value={b.taxTotal} currency={b.currency} /></dd></div>
              <div className="flex justify-between border-t border-line pt-1 font-semibold"><dt>Total</dt><dd><Money value={b.total} currency={b.currency} /></dd></div>
              {b.status === "approved" ? <div className="flex justify-between font-semibold"><dt>Unpaid</dt><dd><Money value={row.outstanding} currency={b.currency} /></dd></div> : null}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Payments" />
            {pays.length ? <ul className="divide-y divide-line text-[13px]">{pays.map(({ a, p }) => <li key={a.id} className="flex justify-between px-4 py-2"><span>{p.number} · <DateText value={p.paymentDate} /> · {p.method.replace("_", " ")}</span><span><Money value={a.amount} currency={b.currency} />{a.reversedAt ? <Badge tone="warning" className="ml-2">reversed</Badge> : null}</span></li>)}</ul> : <EmptyState title="No payments recorded" />}
          </Card>
          <DocumentsPanel actor={actor} link={{ billId: id, supplierId: b.supplierId }} defaultType="bill" title="Bill documents" />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={1} items={[
                { label: "Bill date", value: <DateText value={b.billDate} /> },
                { label: "Due date", value: <DateText value={b.dueDate} overdue={b.status === "approved" && Number(row.outstanding) > 0 && b.dueDate < today} /> },
                { label: "Engagement", value: b.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${b.engagementId}`}>{row.engName}</Link> : "Overhead" },
                { label: "Submitted by", value: row.submitter ?? "—" },
                { label: "Approved", value: b.approvedAt ? <>{approver?.name} · <DateTimeText value={b.approvedAt} /></> : "—" },
                { label: "Exchange rate", value: b.status === "approved" ? `${Number(b.exchangeRate)} (at approval)` : "Set on approval" },
                { label: "Description", value: b.description ?? "—" },
              ]} />
            </CardBody>
          </Card>
          {canPost && (b.status === "awaiting_approval" || b.status === "draft" || b.status === "approved") ? (
            <Card>
              <CardHeader title="Approval" />
              <CardBody>
                <ActionForm action={billWorkflowAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <Field label="Reason (for reject / void)"><Input name="reason" /></Field>
                  <div className="flex flex-wrap gap-2">
                    {b.status !== "approved" ? (selfSubmitted ? <p className="text-[12.5px] text-muted">You submitted this bill, so someone else must approve it.</p> : <SubmitButton name="op" value="approve" confirm="Approve and post this bill to payables?">Approve</SubmitButton>) : null}
                    {b.status !== "approved" ? <SubmitButton variant="secondary" name="op" value="reject">Reject</SubmitButton> : null}
                    <SubmitButton variant="danger" name="op" value="void" confirm="Void this bill?">Void</SubmitButton>
                  </div>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Ledger postings" />
            {journals.length ? <ul className="divide-y divide-line text-[13px]">{journals.map((j) => <li key={j.id} className="px-4 py-2"><Link className="font-medium hover:underline" href={`/finance/accounting/journals/${j.id}`}>{j.number}</Link> · <DateText value={j.entryDate} /> · {j.sourceType.replace(/_/g, " ")}</li>)}</ul> : <EmptyState title="Not posted yet" />}
          </Card>
          <AuditPanel actor={actor} entityType="bill" entityId={id} />
        </div>
      </div>
    </>
  );
}

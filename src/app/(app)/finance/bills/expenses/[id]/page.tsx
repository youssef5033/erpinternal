import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { bankAccounts, engagements, expenseCategories, expenses, journalEntries, suppliers, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { agencyToday } from "@/server/system/settings";
import { expenseWorkflowAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, Notice, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel } from "@/components/records/panels";

export const metadata = { title: "Expense" };

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("finance.read", "expenses.submit");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db.select({ e: expenses, cat: expenseCategories.name, who: user.name, engName: engagements.name, supName: suppliers.name, bankName: bankAccounts.name }).from(expenses).innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId)).leftJoin(user, eq(user.id, expenses.submittedBy)).leftJoin(engagements, eq(engagements.id, expenses.engagementId)).leftJoin(suppliers, eq(suppliers.id, expenses.supplierId)).leftJoin(bankAccounts, eq(bankAccounts.id, expenses.bankAccountId)).where(eq(expenses.id, id));
  if (!row) notFound();
  const e = row.e;
  const mine = e.submittedBy === actor.userId;
  if (!mine && !can(actor, "finance.read")) notFound();
  const today = await agencyToday(db);
  const journals = await db.select().from(journalEntries).where(inArray(journalEntries.id, [e.journalEntryId, e.reimbursementJournalEntryId].filter((x): x is string => !!x)));
  const canPost = can(actor, "finance.post");
  const banks = canPost ? await db.select({ value: bankAccounts.id, label: bankAccounts.name }).from(bankAccounts).where(eq(bankAccounts.active, true)) : [];
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Bills & expenses", href: "/finance/bills?tab=expenses" }, { label: e.number }]} title={`Expense ${e.number}`} meta={<><StatusBadge status={e.status} />{e.exceedsThreshold ? <Badge tone="warning">over approval threshold</Badge> : null}</>} description={e.description} />
      {e.status === "rejected" ? <Notice tone="warning" className="mb-4">Returned: {e.rejectionReason}</Notice> : null}
      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={2} items={[
                { label: "Amount", value: <Money value={e.amount} currency={e.currency} /> },
                { label: "Of which tax", value: <Money value={e.taxAmount} currency={e.currency} /> },
                { label: "Date", value: <DateText value={e.expenseDate} /> },
                { label: "Category", value: row.cat },
                { label: "Submitted by", value: row.who ?? "—" },
                { label: "Paid from", value: e.paidFrom === "personal" ? "Personal funds (to be reimbursed)" : `Company — ${row.bankName ?? "account not set"}` },
                { label: "Engagement", value: e.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${e.engagementId}?tab=budget`}>{row.engName}</Link> : "Overhead" },
                { label: "Supplier", value: row.supName ?? "—" },
                { label: "Direct cost", value: e.isDirectCost ? "Yes" : "No" },
                { label: "Rebill to client", value: e.billableToClient ? "Yes" : "No" },
                { label: "Approved", value: e.approvedAt ? <DateTimeText value={e.approvedAt} /> : "—" },
              ]} />
            </CardBody>
          </Card>
          <DocumentsPanel actor={actor} link={{ expenseId: id }} defaultType="receipt" title="Receipts" />
        </div>
        <div className="space-y-4">
          {canPost && (e.status === "submitted" || (e.status === "approved" && e.paidFrom === "personal")) ? (
            <Card>
              <CardHeader title={e.status === "submitted" ? "Approve or return" : "Reimburse"} />
              <CardBody>
                <ActionForm action={expenseWorkflowAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  {e.status === "submitted" ? (
                    <>
                      <Field label="Reason (if returning)"><Input name="reason" /></Field>
                      <div className="flex gap-2">{mine ? <p className="text-[12.5px] text-muted">You cannot approve your own expense.</p> : <SubmitButton name="op" value="approve">Approve</SubmitButton>}<SubmitButton variant="secondary" name="op" value="reject">Return to submitter</SubmitButton></div>
                    </>
                  ) : (
                    <>
                      <FormGrid cols={2}>
                        <Field label="Paid from"><Select name="bankAccountId" options={banks} /></Field>
                        <Field label="Date"><Input type="date" name="date" defaultValue={today} /></Field>
                      </FormGrid>
                      <SubmitButton name="op" value="reimburse">Record reimbursement</SubmitButton>
                      <p className="text-[12px] text-muted">Records a reimbursement you made — it does not send money.</p>
                    </>
                  )}
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Ledger postings" />
            {journals.length ? <ul className="divide-y divide-line text-[13px]">{journals.map((j) => <li key={j.id} className="px-4 py-2"><Link className="font-medium hover:underline" href={`/finance/accounting/journals/${j.id}`}>{j.number}</Link> · <DateText value={j.entryDate} /> · {j.memo}</li>)}</ul> : <EmptyState title="Not posted yet" />}
          </Card>
          <AuditPanel actor={actor} entityType="expense" entityId={id} />
        </div>
      </div>
    </>
  );
}

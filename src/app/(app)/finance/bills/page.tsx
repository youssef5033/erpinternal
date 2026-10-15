import Link from "next/link";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { bills, engagements, expenseCategories, expenses, suppliers, supplierPayments, bankAccounts, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { billOutstandingSql } from "@/server/finance/payables";
import { agencyToday } from "@/server/system/settings";
import { paySupplierAction, reverseSupplierPaymentAction, submitExpenseAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { financeLookups } from "@/components/finance/lookups";

export const metadata = { title: "Bills & expenses" };

export default async function BillsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read", "expenses.submit");
  const sp = await searchParams;
  const fin = can(actor, "finance.read");
  const tabs = [
    ...(fin ? [{ key: "bills", label: "Supplier bills" }, { key: "pay", label: "Pay suppliers" }] : []),
    { key: "expenses", label: fin ? "Expenses" : "My expenses" },
    ...(can(actor, "expenses.submit") ? [{ key: "submit", label: "Submit expense" }] : []),
  ];
  const tab = tabs.some((t) => t.key === sp.tab) ? sp.tab! : tabs[0].key;
  const today = await agencyToday(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Bills & expenses" }]} title="Bills & expenses" description="Supplier bills and staff expenses go through approval before they post. Paying a supplier here records a payment you made elsewhere — no money moves from this system." actions={fin && can(actor, "finance.write") ? <LinkButton variant="primary" href="/finance/bills/new">New bill</LinkButton> : null} />
      <Tabs current={tab} tabs={tabs.map((t) => ({ ...t, href: `/finance/bills?tab=${t.key}` }))} />
      <div className="mt-4">
        {tab === "bills" ? <Bills sp={sp} today={today} /> : null}
        {tab === "pay" ? <Pay sp={sp} today={today} canPost={can(actor, "finance.post")} /> : null}
        {tab === "expenses" ? <Expenses sp={sp} mineOnly={!fin} userId={actor.userId} /> : null}
        {tab === "submit" ? <SubmitExpense today={today} /> : null}
      </div>
    </>
  );
}

async function Bills({ sp, today }: { sp: Record<string, string | undefined>; today: string }) {
  const conds: (SQL | undefined)[] = [];
  if (sp.status === "open") conds.push(and(eq(bills.status, "approved"), sql`${billOutstandingSql} > 0`));
  else if (sp.status) conds.push(eq(bills.status, sp.status as "draft"));
  if (sp.supplier) conds.push(eq(bills.supplierId, sp.supplier));
  const rows = await db
    .select({ b: bills, supplierName: suppliers.name, engName: engagements.name, outstanding: billOutstandingSql })
    .from(bills)
    .innerJoin(suppliers, eq(suppliers.id, bills.supplierId))
    .leftJoin(engagements, eq(engagements.id, bills.engagementId))
    .where(and(...conds))
    .orderBy(desc(bills.billDate))
    .limit(300);
  const sups = await db.select({ value: suppliers.id, label: suppliers.name }).from(suppliers).orderBy(suppliers.name);
  return (
    <>
      <FilterBar keep={["tab"]} fields={[{ type: "select", name: "status", label: "Status", options: [{ value: "awaiting_approval", label: "Awaiting approval" }, { value: "open", label: "Approved, unpaid" }, { value: "approved", label: "Approved (all)" }, { value: "draft", label: "Draft" }, { value: "void", label: "Void" }] }, { type: "select", name: "supplier", label: "Supplier", options: sups }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Bill</TH><TH>Supplier</TH><TH>Engagement</TH><TH>Date</TH><TH>Due</TH><TH align="right">Total</TH><TH align="right">Unpaid</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ b, supplierName, engName, outstanding }) => {
                const od = b.status === "approved" && Number(outstanding) > 0 && b.dueDate < today;
                return (
                  <TR key={b.id}>
                    <TD><Link className="font-medium hover:underline" href={`/finance/bills/${b.id}`}>{b.number}</Link>{b.supplierReference ? <div className="text-[12px] text-muted">{b.supplierReference}</div> : null}</TD>
                    <TD><Link className="hover:underline" href={`/finance/suppliers/${b.supplierId}`}>{supplierName}</Link></TD>
                    <TD className="text-[12.5px]">{b.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${b.engagementId}?tab=budget`}>{engName}</Link> : "—"}</TD>
                    <TD><DateText value={b.billDate} /></TD>
                    <TD><DateText value={b.dueDate} overdue={od} /></TD>
                    <TD align="right"><Money value={b.total} currency={b.currency} /></TD>
                    <TD align="right">{b.status === "approved" ? <Money value={outstanding} currency={b.currency} /> : "—"}</TD>
                    <TD><StatusBadge status={b.status === "approved" && Number(outstanding) <= 0 ? "paid" : b.status} /></TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No bills match" />}
      </Card>
    </>
  );
}

async function Pay({ sp, today, canPost }: { sp: Record<string, string | undefined>; today: string; canPost: boolean }) {
  const sups = await db.select({ value: suppliers.id, label: suppliers.name }).from(suppliers).where(sql`${suppliers.id} in (select supplier_id from bills where status = 'approved')`).orderBy(suppliers.name);
  const open = sp.supplier ? (await db.select({ b: bills, outstanding: billOutstandingSql }).from(bills).where(and(eq(bills.supplierId, sp.supplier), eq(bills.status, "approved"))).orderBy(bills.dueDate)).filter((x) => Number(x.outstanding) > 0) : [];
  const L = await financeLookups();
  const recent = await db.select({ p: supplierPayments, supplierName: suppliers.name, bankName: bankAccounts.name }).from(supplierPayments).innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId)).innerJoin(bankAccounts, eq(bankAccounts.id, supplierPayments.bankAccountId)).orderBy(desc(supplierPayments.paymentDate)).limit(50);
  return (
    <div className="space-y-4">
      {canPost ? (
        <Card>
          <CardHeader title="Record a supplier payment" description="Choose the supplier, then enter amounts against approved bills." />
          <CardBody>
            <FilterBar keep={["tab"]} fields={[{ type: "select", name: "supplier", label: "Supplier", options: sups, allLabel: "Choose a supplier" }]} />
            {sp.supplier ? (
              open.length ? (
                <ActionForm action={paySupplierAction}>
                  <input type="hidden" name="supplierId" value={sp.supplier} />
                  <FormGrid cols={4}>
                    <Field label="Paid on" required><Input type="date" name="paymentDate" defaultValue={today} max={today} required /></Field>
                    <Field label="From bank account" required><Select name="bankAccountId" options={L.banks} /></Field>
                    <Field label="Method"><Select name="method" options={[{ value: "bank_transfer", label: "Bank transfer" }, { value: "card", label: "Card" }, { value: "cheque", label: "Cheque" }, { value: "cash", label: "Cash" }, { value: "other", label: "Other" }]} /></Field>
                    <Field label="Reference"><Input name="reference" /></Field>
                  </FormGrid>
                  <Table className="mt-3">
                    <THead><tr><TH>Bill</TH><TH>Due</TH><TH align="right">Unpaid</TH><TH align="right">Pay now</TH></tr></THead>
                    <tbody>
                      {open.map(({ b, outstanding }, n) => (
                        <TR key={b.id}>
                          <TD>{b.number}{b.supplierReference ? ` · ${b.supplierReference}` : ""}<input type="hidden" name={`allocations.${n}.billId`} value={b.id} /></TD>
                          <TD><DateText value={b.dueDate} overdue={b.dueDate < today} /></TD>
                          <TD align="right"><Money value={outstanding} currency={b.currency} /></TD>
                          <TD align="right"><Input name={`allocations.${n}.amount`} aria-label={`Pay ${b.number}`} inputMode="decimal" className="ml-auto h-8 w-32 text-right" /></TD>
                        </TR>
                      ))}
                    </tbody>
                  </Table>
                  <div className="mt-3 flex justify-end"><SubmitButton>Record payment</SubmitButton></div>
                </ActionForm>
              ) : <p className="text-[13px] text-muted">No approved unpaid bills for this supplier.</p>
            ) : null}
          </CardBody>
        </Card>
      ) : <Notice>Recording supplier payments needs posting rights.</Notice>}
      <Card>
        <CardHeader title="Recent supplier payments" />
        {recent.length ? (
          <Table>
            <THead><tr><TH>Payment</TH><TH>Supplier</TH><TH>Date</TH><TH>From</TH><TH align="right">Amount</TH><TH>Status</TH>{canPost ? <TH /> : null}</tr></THead>
            <tbody>{recent.map(({ p, supplierName, bankName }) => <TR key={p.id}><TD className="font-medium">{p.number}<div className="text-[12px] font-normal text-muted">{p.reference}</div></TD><TD>{supplierName}</TD><TD><DateText value={p.paymentDate} /></TD><TD>{bankName}</TD><TD align="right"><Money value={p.amount} currency={p.currency} /></TD><TD><StatusBadge status={p.status} /></TD>{canPost ? <TD align="right">{p.status === "recorded" ? <details><summary className="cursor-pointer text-[12.5px] text-danger">Reverse</summary><ActionForm action={reverseSupplierPaymentAction} className="mt-1 flex gap-1"><input type="hidden" name="id" value={p.id} /><Input name="reason" aria-label="Reason" required className="h-8" /><SubmitButton size="sm" variant="danger">Reverse</SubmitButton></ActionForm></details> : null}</TD> : null}</TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No supplier payments yet" />}
      </Card>
    </div>
  );
}

async function Expenses({ sp, mineOnly, userId }: { sp: Record<string, string | undefined>; mineOnly: boolean; userId: string }) {
  const rows = await db
    .select({ e: expenses, cat: expenseCategories.name, who: user.name, engName: engagements.name })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(user, eq(user.id, expenses.submittedBy))
    .leftJoin(engagements, eq(engagements.id, expenses.engagementId))
    .where(and(mineOnly ? eq(expenses.submittedBy, userId) : undefined, sp.status ? eq(expenses.status, sp.status as "submitted") : undefined))
    .orderBy(desc(expenses.expenseDate))
    .limit(300);
  return (
    <>
      <FilterBar keep={["tab"]} fields={[{ type: "select", name: "status", label: "Status", options: ["submitted", "approved", "rejected", "reimbursed"].map((v) => ({ value: v, label: v })) }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Expense</TH><TH>Date</TH><TH>Category</TH><TH>Submitted by</TH><TH>Engagement</TH><TH align="right">Amount</TH><TH>Paid from</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ e, cat, who, engName }) => (
                <TR key={e.id}>
                  <TD><Link className="font-medium hover:underline" href={`/finance/bills/expenses/${e.id}`}>{e.number}</Link><div className="text-[12px] text-muted">{e.description}</div></TD>
                  <TD><DateText value={e.expenseDate} /></TD>
                  <TD>{cat}</TD>
                  <TD>{who ?? "—"}</TD>
                  <TD className="text-[12.5px]">{engName ?? "—"}{e.billableToClient ? <Badge className="ml-1">rebill</Badge> : null}</TD>
                  <TD align="right"><Money value={e.amount} currency={e.currency} /></TD>
                  <TD>{e.paidFrom === "personal" ? "Personal (reimburse)" : "Company"}</TD>
                  <TD><StatusBadge status={e.status} />{e.exceedsThreshold ? <Badge tone="warning" className="ml-1">over threshold</Badge> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No expenses" />}
      </Card>
    </>
  );
}

async function SubmitExpense({ today }: { today: string }) {
  const L = await financeLookups();
  return (
    <Card className="max-w-4xl">
      <CardHeader title="Submit an expense" description="After submitting, attach the receipt on the expense page. Expenses over the category threshold need finance approval." />
      <CardBody>
        <ActionForm action={submitExpenseAction}>
          <FormGrid cols={3}>
            <Field label="Date" required><Input type="date" name="expenseDate" defaultValue={today} max={today} required /></Field>
            <Field label="Category" required><Select name="categoryId" options={L.categories} placeholder="Choose" required /></Field>
            <Field label="Description" required><Input name="description" required /></Field>
            <Field label="Amount (incl. tax)" required><Input name="amount" inputMode="decimal" required /></Field>
            <Field label="Of which tax"><Input name="taxAmount" inputMode="decimal" /></Field>
            <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={L.banks[0]?.currency ?? "USD"} /></Field>
            <Field label="Paid from"><Select name="paidFrom" options={[{ value: "personal", label: "My own money (reimburse me)" }, { value: "company", label: "Company card / account" }]} /></Field>
            <Field label="Company account (if company-paid)"><Select name="bankAccountId" options={L.banks} placeholder="—" /></Field>
            <Field label="Engagement"><Select name="engagementId" options={L.engagements} placeholder="Overhead (none)" /></Field>
            <Field label="Supplier"><Select name="supplierId" options={L.suppliers} placeholder="—" /></Field>
          </FormGrid>
          <div className="mt-3 flex flex-wrap gap-6">
            <Checkbox name="isDirectCost" label="Direct cost of the engagement" />
            <Checkbox name="billableToClient" label="Rebill to client" />
          </div>
          <div className="mt-3 flex justify-end"><SubmitButton>Submit expense</SubmitButton></div>
        </ActionForm>
      </CardBody>
    </Card>
  );
}

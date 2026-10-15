import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, journalEntries, journalLines, ledgerAccounts, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { agencyToday, getSettings } from "@/server/system/settings";
import { reverseJournalAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, DefinitionList, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input } from "@/components/forms/fields";

export const metadata = { title: "Journal entry" };

const SOURCE_HREF: Record<string, (id: string) => string> = {
  invoice: (id) => `/finance/invoices/${id}`,
  bill: (id) => `/finance/bills/${id}`,
  expense: (id) => `/finance/bills/expenses/${id}`,
  expense_reimbursement: (id) => `/finance/bills/expenses/${id}`,
  revenue_recognition: (id) => `/delivery/engagements/${id}?tab=billing`,
};

export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("finance.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db.select({ j: journalEntries, by: user.name }).from(journalEntries).leftJoin(user, eq(user.id, journalEntries.createdBy)).where(eq(journalEntries.id, id));
  if (!row) notFound();
  const j = row.j;
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const lines = await db.select({ l: journalLines, code: ledgerAccounts.code, name: ledgerAccounts.name, accountName: accounts.name, engNumber: engagements.number }).from(journalLines).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.ledgerAccountId)).leftJoin(accounts, eq(accounts.id, journalLines.accountId)).leftJoin(engagements, eq(engagements.id, journalLines.engagementId)).where(eq(journalLines.entryId, id)).orderBy(asc(journalLines.lineOrder));
  const dr = lines.reduce((a, x) => a + Number(x.l.debit), 0);
  const cr = lines.reduce((a, x) => a + Number(x.l.credit), 0);
  const [rev] = j.reversedById ? await db.select().from(journalEntries).where(eq(journalEntries.id, j.reversedById)) : [];
  const [orig] = j.reversalOfId ? await db.select().from(journalEntries).where(eq(journalEntries.id, j.reversalOfId)) : [];
  const srcHref = j.sourceId && SOURCE_HREF[j.sourceType] ? SOURCE_HREF[j.sourceType](j.sourceId) : null;
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Accounting", href: "/finance/accounting?tab=journals" }, { label: j.number }]} title={`Journal ${j.number}`} meta={<>{rev ? <Badge tone="warning">reversed</Badge> : null}{orig ? <Badge>reversal</Badge> : null}</>} description={j.memo} />
      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card>
          <Table>
            <THead><tr><TH>Account</TH><TH>Dimensions</TH><TH align="right">Debit ({s.baseCurrency})</TH><TH align="right">Credit ({s.baseCurrency})</TH><TH align="right">Transaction amount</TH></tr></THead>
            <tbody>
              {lines.map(({ l, code, name, accountName, engNumber }) => (
                <TR key={l.id}>
                  <TD><Link className="hover:underline" href={`/finance/reports?report=ledger&account=${l.ledgerAccountId}`}>{code} {name}</Link>{l.description ? <div className="text-[12px] text-muted">{l.description}</div> : null}</TD>
                  <TD className="text-[12px] text-muted">{[accountName, engNumber].filter(Boolean).join(" · ") || "—"}</TD>
                  <TD align="right" className="num">{Number(l.debit) ? Number(l.debit).toFixed(2) : ""}</TD>
                  <TD align="right" className="num">{Number(l.credit) ? Number(l.credit).toFixed(2) : ""}</TD>
                  <TD align="right"><Money value={l.txnAmount} currency={l.txnCurrency} />{l.exchangeRate && Number(l.exchangeRate) !== 1 ? <div className="text-[11.5px] text-muted">@ {Number(l.exchangeRate)}</div> : null}</TD>
                </TR>
              ))}
              <TR className="font-semibold"><TD>Total</TD><TD /><TD align="right" className="num">{dr.toFixed(2)}</TD><TD align="right" className="num">{cr.toFixed(2)}</TD><TD /></TR>
            </tbody>
          </Table>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={1} items={[
                { label: "Entry date", value: <DateText value={j.entryDate} /> },
                { label: "Source", value: srcHref ? <Link className="hover:underline" href={srcHref}>{j.sourceType.replace(/_/g, " ")}</Link> : j.sourceType.replace(/_/g, " ") },
                { label: "Posted", value: <><DateTimeText value={j.postedAt} /> · {row.by ?? "System"}</> },
                { label: "Posting key", value: <span className="font-mono text-[12px]">{j.postingKey}</span> },
                ...(rev ? [{ label: "Reversed by", value: <Link className="hover:underline" href={`/finance/accounting/journals/${rev.id}`}>{rev.number}</Link> }] : []),
                ...(orig ? [{ label: "Reverses", value: <Link className="hover:underline" href={`/finance/accounting/journals/${orig.id}`}>{orig.number}</Link> }] : []),
              ]} />
            </CardBody>
          </Card>
          {can(actor, "finance.post") && j.sourceType === "manual" && !j.reversedById ? (
            <Card>
              <CardHeader title="Reverse" description="Posts an equal and opposite entry. Documents generated by invoices, bills and payments are reversed from their own record instead." />
              <CardBody>
                <ActionForm action={reverseJournalAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <FormGrid cols={2}>
                    <Field label="Reversal date"><Input type="date" name="entryDate" defaultValue={today} /></Field>
                    <Field label="Reason"><Input name="reason" required /></Field>
                  </FormGrid>
                  <SubmitButton size="sm" variant="danger" confirm="Post a reversing entry?">Reverse journal</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

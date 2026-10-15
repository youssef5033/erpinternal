import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bankAccounts, importBatches, importRows } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { commitBankImportAction, validateBankImportAction } from "@/server/actions/finance";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Select } from "@/components/forms/fields";

export const metadata = { title: "Bank import" };

const guess = (headers: string[], ...names: string[]) => headers.find((h) => names.some((n) => h.toLowerCase().includes(n))) ?? "";

export default async function BankImportPage({ params }: { params: Promise<{ batchId: string }> }) {
  await guard("finance.write");
  const { batchId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) notFound();
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!batch || batch.kind !== "bank_transactions") notFound();
  const bankId = (batch.context as { bankAccountId: string }).bankAccountId;
  const [bank] = await db.select().from(bankAccounts).where(eq(bankAccounts.id, bankId));
  const rows = await db.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber)).limit(500);
  const headers = batch.headers ?? [];
  const m = (batch.mapping ?? {}) as Record<string, string>;
  const opts = headers.map((h) => ({ value: h, label: h }));
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Bank & spending", href: `/finance/bank?account=${bankId}` }, { label: "Import" }]} title={`Import ${batch.fileName}`} meta={<StatusBadge status={batch.status} />} description={`Into ${bank?.name} (${bank?.currency}). ${batch.totalRows} rows. Nothing is saved to the bank account until you confirm.`} />
      {batch.status === "committed" ? <Notice tone="success" className="mb-4">Imported {batch.importedRows} line(s). Duplicates and invalid rows were skipped.</Notice> : null}
      {batch.status !== "committed" ? (
        <Card className="mb-4">
          <CardHeader title="1. Map columns" description="Use a signed Amount column, or separate Debit (money out) and Credit (money in) columns." />
          <CardBody>
            <ActionForm action={validateBankImportAction}>
              <input type="hidden" name="batchId" value={batchId} />
              <FormGrid cols={4}>
                <Field label="Date" required><Select name="date" options={opts} defaultValue={m.date ?? guess(headers, "date")} required /></Field>
                <Field label="Date format"><Select name="dateFormat" options={[{ value: "yyyy-MM-dd", label: "2026-10-15" }, { value: "dd/MM/yyyy", label: "15/10/2026" }, { value: "MM/dd/yyyy", label: "10/15/2026" }]} defaultValue={m.dateFormat ?? "yyyy-MM-dd"} /></Field>
                <Field label="Description" required><Select name="description" options={opts} defaultValue={m.description ?? guess(headers, "desc", "narrative", "details", "memo")} required /></Field>
                <Field label="Amount (signed)"><Select name="amount" options={opts} placeholder="—" defaultValue={m.amount ?? guess(headers, "amount")} /></Field>
                <Field label="Debit (out)"><Select name="debit" options={opts} placeholder="—" defaultValue={m.debit ?? ""} /></Field>
                <Field label="Credit (in)"><Select name="credit" options={opts} placeholder="—" defaultValue={m.credit ?? ""} /></Field>
                <Field label="Reference"><Select name="reference" options={opts} placeholder="—" defaultValue={m.reference ?? guess(headers, "ref")} /></Field>
                <Field label="Counterparty"><Select name="counterparty" options={opts} placeholder="—" defaultValue={m.counterparty ?? guess(headers, "payee", "counterparty", "name")} /></Field>
              </FormGrid>
              <div className="mt-3 flex justify-end"><SubmitButton>Validate rows</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
      {batch.status === "validated" || batch.status === "committed" ? (
        <Card>
          <CardHeader title={batch.status === "committed" ? "Rows" : "2. Review and import"} description={<span className="flex flex-wrap gap-2"><Badge tone="success">{batch.validRows} to import</Badge><Badge tone="warning">{batch.duplicateRows} already imported</Badge><Badge tone="danger">{batch.errorRows} with errors</Badge></span>} actions={batch.status === "validated" ? <ActionForm action={commitBankImportAction}><input type="hidden" name="batchId" value={batchId} /><input type="hidden" name="bankAccountId" value={bankId} /><SubmitButton confirm={`Import ${batch.validRows} line(s)?`}>Import {batch.validRows} line(s)</SubmitButton></ActionForm> : null} />
          <Table>
            <THead><tr><TH>#</TH><TH>Date</TH><TH>Description</TH><TH align="right">Amount</TH><TH>Result</TH></tr></THead>
            <tbody>
              {rows.map((r) => {
                const n = (r.normalized ?? {}) as { txnDate?: string; amount?: string; description?: string };
                return (
                  <TR key={r.id}>
                    <TD>{r.rowNumber}</TD>
                    <TD>{n.txnDate ?? r.raw[m.date] ?? "—"}</TD>
                    <TD className="text-[12.5px]">{n.description ?? r.raw[m.description]}</TD>
                    <TD align="right" className="num">{n.amount ?? "—"}</TD>
                    <TD className="text-[12.5px]">{r.errors?.length ? <span className="text-danger">{r.errors.join("; ")}</span> : r.duplicates?.length ? <span className="text-warning">{r.duplicates.map((x) => x.reason).join("; ")}</span> : r.resultEntityId ? <Badge tone="success">imported</Badge> : <Badge>{r.decision}</Badge>}</TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ) : (
        <Card><CardBody><p className="text-[13px] text-muted">Preview of the first rows as uploaded:</p><pre className="mt-2 overflow-x-auto text-[12px]">{JSON.stringify(rows.slice(0, 3).map((r) => r.raw), null, 2)}</pre></CardBody></Card>
      )}
    </>
  );
}

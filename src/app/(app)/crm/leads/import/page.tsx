import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { importBatches } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { LEAD_IMPORT_FIELDS } from "@/server/crm/lead-import";
import { formatDateTime } from "@/lib/dates";
import { Card, CardBody, CardHeader, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input } from "@/components/forms/fields";
import { stageLeadImportAction } from "@/server/actions/crm";

export const metadata = { title: "Import leads" };

export default async function LeadImportPage() {
  await guard("crm.import");
  const batches = await db.select().from(importBatches).where(eq(importBatches.kind, "leads")).orderBy(desc(importBatches.createdAt)).limit(20);
  return (
    <>
      <PageHeader crumbs={[{ label: "Leads", href: "/crm/leads" }, { label: "Import" }]} title="Import leads from CSV" description="Upload → map columns → validate (row-level errors) → review duplicates (import, skip or merge) → commit. Nothing is created until you commit." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Upload" />
          <CardBody>
            <ActionForm action={stageLeadImportAction} className="space-y-3">
              <Field label="CSV file (UTF-8, header row, ≤ 5,000 rows)" htmlFor="file">
                <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
              </Field>
              <SubmitButton>Upload and map columns</SubmitButton>
            </ActionForm>
            <p className="mt-3 text-[12.5px] text-muted">
              Need a template? <a className="text-accent underline" href="/api/export/lead-template">Download the CSV template</a>.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Supported fields" />
          <CardBody>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[12.5px] text-ink-2">
              {LEAD_IMPORT_FIELDS.map((f) => <li key={f.key}>{f.label}{f.required ? " *" : ""}</li>)}
            </ul>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Recent imports" />
        <Table>
          <THead><tr><TH>File</TH><TH>Status</TH><TH align="right">Rows</TH><TH align="right">Valid</TH><TH align="right">Duplicates</TH><TH align="right">Errors</TH><TH align="right">Imported</TH><TH>Uploaded</TH></tr></THead>
          <tbody>
            {batches.map((b) => (
              <TR key={b.id}>
                <TD><Link className="font-medium hover:underline" href={`/crm/leads/import/${b.id}`}>{b.fileName}</Link></TD>
                <TD><StatusBadge status={b.status} /></TD>
                <TD align="right">{b.totalRows}</TD><TD align="right">{b.validRows}</TD><TD align="right">{b.duplicateRows}</TD><TD align="right">{b.errorRows}</TD><TD align="right">{b.importedRows}</TD>
                <TD>{formatDateTime(b.createdAt)}</TD>
              </TR>
            ))}
            {!batches.length ? <TR><TD colSpan={8} className="text-muted">No imports yet.</TD></TR> : null}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

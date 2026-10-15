import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { importBatches, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";

export const metadata = { title: "Imports & exports" };

const EXPORTS = [
  { entity: "leads", label: "Leads", perm: "crm.export" as const },
  { entity: "accounts", label: "Accounts", perm: "crm.export" as const },
  { entity: "contacts", label: "Contacts", perm: "crm.export" as const },
  { entity: "opportunities", label: "Opportunities", perm: "crm.export" as const },
  { entity: "invoices", label: "Invoices", perm: "finance.export" as const },
  { entity: "bills", label: "Bills", perm: "finance.export" as const },
  { entity: "time", label: "Time entries", perm: "finance.export" as const },
  { entity: "journal", label: "Journal lines (general ledger)", perm: "finance.export" as const },
];

export default async function DataPage() {
  const actor = await guard("system.settings", "crm.export", "finance.export");
  const batches = await db.select({ b: importBatches, by: user.name }).from(importBatches).leftJoin(user, eq(user.id, importBatches.createdBy)).orderBy(desc(importBatches.createdAt)).limit(50);
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Imports & exports" }]} title="Imports & exports" description="CSV in and out. Every export is permission-checked and recorded in the audit log; CSV cells that could run as spreadsheet formulas are neutralised." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Export (CSV)" />
          <ul className="divide-y divide-line">
            {EXPORTS.map((e) => (
              <li key={e.entity} className="flex items-center justify-between px-4 py-2 text-[13.5px]">
                <span>{e.label}</span>
                {can(actor, e.perm) ? <a className="text-accent hover:underline" href={`/api/export/${e.entity}`}>Download</a> : <span className="text-[12px] text-muted">needs {e.perm}</span>}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Import" />
          <CardBody>
            <ul className="list-disc space-y-1 pl-5 text-[13px]">
              <li><Link className="text-accent hover:underline" href="/crm/leads/import">Leads & contacts</Link> — map columns, validate, review duplicates (skip, merge or import), then commit.</li>
              <li><Link className="text-accent hover:underline" href="/finance/bank">Bank statements</Link> — map columns, detect already-imported lines, then commit.</li>
              <li>Lead template: <a className="text-accent hover:underline" href="/api/export/lead-template">download CSV template</a>.</li>
            </ul>
          </CardBody>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Import history" />
        {batches.length ? (
          <Table>
            <THead><tr><TH>File</TH><TH>Kind</TH><TH align="right">Rows</TH><TH align="right">Valid</TH><TH align="right">Duplicates</TH><TH align="right">Errors</TH><TH align="right">Imported</TH><TH>Status</TH><TH>By</TH></tr></THead>
            <tbody>{batches.map(({ b, by }) => <TR key={b.id}><TD><Link className="hover:underline" href={b.kind === "bank_transactions" ? `/finance/bank/import/${b.id}` : `/crm/leads/import/${b.id}`}>{b.fileName}</Link><div className="text-[12px] text-muted"><DateTimeText value={b.createdAt} /></div></TD><TD>{b.kind.replace("_", " ")}</TD><TD align="right">{b.totalRows}</TD><TD align="right">{b.validRows}</TD><TD align="right">{b.duplicateRows}</TD><TD align="right">{b.errorRows}</TD><TD align="right">{b.importedRows}</TD><TD><StatusBadge status={b.status} /></TD><TD>{by ?? "—"}</TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No imports yet" />}
      </Card>
      <Notice className="mt-4" title="Backups">Database backups are taken outside the application (see README → Backup and restore: <code>pg_dump</code> / <code>pg_restore</code> plus the private file storage directory or bucket). This page does not create or restore backups.</Notice>
    </>
  );
}

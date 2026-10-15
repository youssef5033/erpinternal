import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { importBatches, importRows } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { LEAD_IMPORT_FIELDS } from "@/server/crm/lead-import";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Select } from "@/components/forms/fields";
import { commitLeadImportAction, importRowDecisionAction, validateLeadImportAction } from "@/server/actions/crm";

export default async function LeadImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  await guard("crm.import");
  const { batchId } = await params;
  const [b] = await db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!b || b.kind !== "leads") notFound();
  const rows = await db.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber));
  const headers = b.headers ?? [];
  const mapping = (b.mapping ?? {}) as Record<string, string>;
  const committed = b.status === "committed";
  const toImport = rows.filter((r) => r.decision === "import").length;
  const toMerge = rows.filter((r) => r.decision === "merge").length;
  return (
    <>
      <PageHeader crumbs={[{ label: "Leads", href: "/crm/leads" }, { label: "Import", href: "/crm/leads/import" }, { label: b.fileName }]} title={`Import: ${b.fileName}`} meta={<><StatusBadge status={b.status} /><span className="text-[12.5px] text-muted">{b.totalRows} rows</span></>} />
      {committed ? <Notice tone="success" title={`Committed — ${b.importedRows} rows imported or merged.`} className="mb-4"><Link className="underline" href="/crm/leads?sort=">View leads</Link></Notice> : null}
      {!committed ? (
        <Card className="mb-4">
          <CardHeader title="1. Map columns" description="Suggested from your header names. Unmapped columns are ignored." />
          <CardBody>
            <ActionForm action={validateLeadImportAction} className="space-y-3">
              <input type="hidden" name="batchId" value={batchId} />
              <FormGrid cols={4}>
                {LEAD_IMPORT_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label} htmlFor={`m-${f.key}`} required={f.required}>
                    <Select id={`m-${f.key}`} name={`mapping.${f.key}`} defaultValue={mapping[f.key] ?? ""} placeholder="— not mapped —" options={headers.map((h) => ({ value: h, label: h }))} />
                  </Field>
                ))}
              </FormGrid>
              <SubmitButton>Validate and preview</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
      {b.status === "validated" || committed ? (
        <Card>
          <CardHeader
            title="2. Review rows"
            description="Rows with errors are skipped. Possible duplicates default to skip — choose import (new lead) or merge into the matched lead."
            actions={
              !committed ? (
                <ActionForm action={commitLeadImportAction}>
                  <input type="hidden" name="batchId" value={batchId} />
                  <SubmitButton confirm={`Create ${toImport} leads and merge ${toMerge} rows into existing leads?`}>Commit: {toImport} new, {toMerge} merge</SubmitButton>
                </ActionForm>
              ) : null
            }
          />
          <div className="flex flex-wrap gap-2 px-4 py-2 text-[12.5px]">
            <Badge tone="success">{b.validRows} ready</Badge><Badge tone="warning">{b.duplicateRows} possible duplicates</Badge><Badge tone="danger">{b.errorRows} errors</Badge>
          </div>
          <Table>
            <THead><tr><TH>Row</TH><TH>Company</TH><TH>Contact</TH><TH>Problems</TH><TH>Decision</TH></tr></THead>
            <tbody>
              {rows.map((r) => {
                const n = r.normalized as { companyName?: string; contact?: { fullName: string; email: string | null } | null } | null;
                return (
                  <TR key={r.id}>
                    <TD>{r.rowNumber}</TD>
                    <TD className="font-medium">{n?.companyName ?? r.raw[mapping.companyName] ?? "—"}</TD>
                    <TD className="text-[12.5px]">{n?.contact ? `${n.contact.fullName}${n.contact.email ? ` · ${n.contact.email}` : ""}` : "—"}</TD>
                    <TD className="min-w-[260px] text-[12.5px]">
                      {(r.errors ?? []).map((e) => <p key={e} className="text-danger">✕ {e}</p>)}
                      {(r.duplicates ?? []).map((d) => (
                        <p key={`${d.type}${d.id}`} className="text-warning">
                          ≈ {d.type === "lead" ? <Link className="underline" href={`/crm/leads/${d.id}`}>{d.label}</Link> : d.type === "account" ? <Link className="underline" href={`/crm/accounts/${d.id}`}>{d.label}</Link> : d.label} — {d.reason}
                        </p>
                      ))}
                      {!(r.errors ?? []).length && !(r.duplicates ?? []).length ? <span className="text-success">OK</span> : null}
                    </TD>
                    <TD>
                      {committed ? (
                        <span className="text-[12.5px]">{r.decision}{r.resultEntityId ? <> · <Link className="text-accent underline" href={`/crm/leads/${r.resultEntityId}`}>open</Link></> : null}</span>
                      ) : (r.errors ?? []).length ? (
                        <Badge tone="danger">skip</Badge>
                      ) : (
                        <ActionForm action={importRowDecisionAction} hideSuccess className="flex gap-1">
                          <input type="hidden" name="rowId" value={r.id} />
                          <Select name="decision" defaultValue={r.decision} aria-label="Decision" className="h-7 w-28 py-0 text-[12px]" options={[{ value: "import", label: "Import" }, { value: "skip", label: "Skip" }, ...((r.duplicates ?? []).some((d) => d.type === "lead") ? [{ value: "merge", label: "Merge" }] : [])]} />
                          {(r.duplicates ?? []).filter((d) => d.type === "lead").length ? (
                            <Select name="mergeTargetId" defaultValue={r.mergeTargetId ?? ""} aria-label="Merge into" className="h-7 w-40 py-0 text-[12px]" options={(r.duplicates ?? []).filter((d) => d.type === "lead").map((d) => ({ value: d.id, label: d.label }))} />
                          ) : null}
                          <SubmitButton size="sm" variant="secondary">Set</SubmitButton>
                        </ActionForm>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </>
  );
}

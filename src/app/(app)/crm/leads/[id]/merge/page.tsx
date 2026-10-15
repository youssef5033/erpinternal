import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { previewLeadMerge } from "@/server/crm/leads";
import { Card, CardBody, CardHeader, Notice, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { mergeLeadsAction } from "@/server/actions/crm";
import { NotFoundError } from "@/server/errors";

export default async function MergeLeadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ target?: string }> }) {
  await guard("crm.import");
  const { id } = await params;
  const { target } = await searchParams;
  if (!target) notFound();
  let preview;
  try {
    preview = await previewLeadMerge(db, id, target);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const { source, target: t, fields, counts } = preview;
  return (
    <>
      <PageHeader crumbs={[{ label: "Leads", href: "/crm/leads" }, { label: source.companyName, href: `/crm/leads/${id}` }, { label: "Merge" }]} title="Review merge" description={`Merge “${source.companyName}” into “${t.companyName}”. Choose which value to keep for each differing field.`} />
      <Notice tone="info" className="mb-4">
        Moving to the surviving lead: {counts.contacts} contacts, {counts.evidence} research items, {counts.activities} activities, {counts.tasks} tasks, plus status history, meetings, campaign memberships and outreach. The merged lead is kept as a read-only record with a full snapshot.
      </Notice>
      <ActionForm action={mergeLeadsAction} className="space-y-4">
        <input type="hidden" name="sourceId" value={id} />
        <input type="hidden" name="targetId" value={target} />
        <Card>
          <CardHeader title="Field choices" />
          <Table>
            <THead>
              <tr><TH>Field</TH><TH>Keep (surviving): <Link className="normal-case underline" href={`/crm/leads/${t.id}`}>{t.companyName}</Link></TH><TH>Use from duplicate: {source.companyName}</TH></tr>
            </THead>
            <tbody>
              {fields.filter((f) => f.differs).map((f) => (
                <TR key={f.field}>
                  <TD className="font-medium">{f.field.replace(/([A-Z])/g, " $1").toLowerCase()}</TD>
                  <TD><label className="flex gap-2"><input type="radio" name={`choices.${f.field}`} value="target" defaultChecked={f.target !== null && f.target !== ""} className="accent-[var(--color-accent)]" />{String(f.target ?? "—")}</label></TD>
                  <TD><label className="flex gap-2"><input type="radio" name={`choices.${f.field}`} value="source" defaultChecked={f.target === null || f.target === ""} className="accent-[var(--color-accent)]" />{String(f.source ?? "—")}</label></TD>
                </TR>
              ))}
            </tbody>
          </Table>
          <CardBody>
            <SubmitButton confirm="Merge these leads? This cannot be split back automatically (a snapshot is kept).">Merge into {t.companyName}</SubmitButton>
          </CardBody>
        </Card>
      </ActionForm>
    </>
  );
}

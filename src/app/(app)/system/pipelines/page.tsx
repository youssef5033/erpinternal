import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { customFieldDefinitions } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { listPipelinesWithStages } from "@/server/system/settings";
import { saveCustomFieldAction, saveStageAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select } from "@/components/forms/fields";

export const metadata = { title: "Pipelines & fields" };

const ENTITIES = ["lead", "account", "contact", "opportunity", "engagement"] as const;

export default async function PipelinesPage() {
  await guard("system.settings");
  const pipelines = await listPipelinesWithStages(db);
  const fields = await db.select().from(customFieldDefinitions).orderBy(asc(customFieldDefinitions.entityType), asc(customFieldDefinitions.sortOrder));
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Pipelines & fields" }]} title="Pipelines & fields" description="Stage names, probabilities and staleness thresholds drive the weighted pipeline and follow-up signals. Stage keys are fixed so workflows (discovery, proposal, won) keep working." />
      {pipelines.map((p) => (
        <Card key={p.id} className="mb-4">
          <CardHeader title={<span className="flex items-center gap-2">{p.name}{p.isDefault ? <Badge tone="success">default</Badge> : null}</span>} />
          <Table>
            <THead><tr><TH>Key</TH><TH>Name</TH><TH>Probability %</TH><TH>Stale after (days)</TH><TH>Order</TH><TH>Kind</TH><TH /></tr></THead>
            <tbody>
              {p.stages.map((s) => (
                <TR key={s.id}>
                  <TD className="font-mono text-[12px]">{s.key}</TD>
                  <TD colSpan={5}>
                    <ActionForm action={saveStageAction} hideSuccess className="grid grid-cols-[1fr_110px_130px_80px_auto] items-center gap-2">
                      <input type="hidden" name="id" value={s.id} />
                      <Input name="name" aria-label={`${s.key} name`} defaultValue={s.name} className="h-8" />
                      <Input type="number" min={0} max={100} name="probability" aria-label={`${s.key} probability`} defaultValue={s.probability} className="h-8" readOnly={s.kind !== "open"} />
                      <Input type="number" min={1} name="staleAfterDays" aria-label={`${s.key} stale days`} defaultValue={s.staleAfterDays ?? ""} placeholder="default" className="h-8" />
                      <Input type="number" name="sortOrder" aria-label={`${s.key} order`} defaultValue={s.sortOrder} className="h-8" />
                      <SubmitButton size="sm" variant="ghost">Save</SubmitButton>
                    </ActionForm>
                  </TD>
                  <TD><Badge tone={s.kind === "won" ? "success" : s.kind === "lost" ? "danger" : "neutral"}>{s.kind}</Badge></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
      <Card>
        <CardHeader title="Custom fields" description="Extra fields shown on record forms. Values are stored with the record; removing a field hides it without deleting data." />
        {fields.length ? (
          <Table>
            <THead><tr><TH>Record</TH><TH>Label</TH><TH>Type</TH><TH>Options</TH><TH>Required</TH><TH>Status</TH></tr></THead>
            <tbody>{fields.map((f) => <TR key={f.id}><TD className="capitalize">{f.entityType}</TD><TD>{f.label}<div className="font-mono text-[11.5px] text-muted">{f.key}</div></TD><TD>{f.fieldType}</TD><TD className="text-[12.5px]">{f.options?.join(", ") ?? "—"}</TD><TD>{f.required ? "Yes" : "No"}</TD><TD>{f.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>}</TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No custom fields" />}
        <CardBody className="border-t border-line">
          <ActionForm action={saveCustomFieldAction} resetOnSuccess>
            <FormGrid cols={4}>
              <Field label="Record type"><Select name="entityType" options={ENTITIES.map((e) => ({ value: e, label: e }))} /></Field>
              <Field label="Label"><Input name="label" required /></Field>
              <Field label="Type"><Select name="fieldType" options={["text", "number", "date", "select", "boolean", "url"].map((t) => ({ value: t, label: t }))} /></Field>
              <Field label="Options (select; comma-separated)"><Input name="optionsText" /></Field>
            </FormGrid>
            <div className="mt-2 flex items-center justify-between"><div className="flex gap-4"><Checkbox name="required" label="Required" /><input type="hidden" name="active" value="true" /></div><SubmitButton size="sm">Add field</SubmitButton></div>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}

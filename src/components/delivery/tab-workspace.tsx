import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { workspaceItems, user } from "@/db/schema";
import type { engagements } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { itemTypesFor, type FieldDef, type ItemTypeDef } from "@/server/delivery/templates";
import { saveWorkspaceItemAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, StatusBadge } from "@/components/ui/primitives";
import { DateText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";

type Eng = typeof engagements.$inferSelect;
type Item = typeof workspaceItems.$inferSelect;

const label = (s: string) => s.replace(/_/g, " ");

function FieldInput({ f, value }: { f: FieldDef; value?: unknown }) {
  const v = value === undefined || value === null ? "" : String(value);
  const name = `data.${f.key}`;
  if (f.type === "textarea") return <Textarea name={name} rows={3} defaultValue={v} required={f.required} />;
  if (f.type === "select") return <Select name={name} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} placeholder="—" defaultValue={v} required={f.required} />;
  return <Input name={name} type={f.type === "number" ? "text" : f.type === "url" ? "url" : f.type} inputMode={f.type === "number" ? "decimal" : undefined} defaultValue={v} required={f.required} />;
}

function ItemForm({ e, def, item }: { e: Eng; def: ItemTypeDef; item?: Item }) {
  return (
    <ActionForm action={saveWorkspaceItemAction} resetOnSuccess={!item} className="space-y-3">
      <input type="hidden" name="engagementId" value={e.id} />
      <input type="hidden" name="itemType" value={def.key} />
      {item ? <input type="hidden" name="id" value={item.id} /> : null}
      <FormGrid cols={3}>
        <Field label="Title" required><Input name="title" defaultValue={item?.title} required /></Field>
        <Field label="Status"><Select name="status" options={def.statuses.map((s) => ({ value: s, label: label(s) }))} defaultValue={item?.status ?? def.statuses[0]} /></Field>
        <Field label="Due"><Input type="date" name="dueDate" defaultValue={item?.dueDate ?? ""} /></Field>
        {def.scheduled ? <Field label="Scheduled for"><Input type="date" name="scheduledDate" defaultValue={item?.scheduledDate ?? ""} /></Field> : null}
        {def.channel ? <Field label="Channel"><Input name="channel" defaultValue={item?.channel ?? ""} placeholder="e.g. LinkedIn" /></Field> : null}
      </FormGrid>
      <FormGrid cols={2}>
        {def.fields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required} className={f.type === "textarea" ? "sm:col-span-2" : undefined}>
            <FieldInput f={f} value={item?.data[f.key]} />
          </Field>
        ))}
      </FormGrid>
      <div className="flex items-center justify-between">
        {item ? <Checkbox name="asNewVersion" label={`Save as version ${item.versionNumber + 1} (keep v${item.versionNumber})`} /> : <span />}
        <SubmitButton size="sm">{item ? "Save" : `Add ${def.label.toLowerCase()}`}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export async function WorkspaceTab({ actor, e, today }: { actor: Actor; e: Eng; today: string }) {
  const defs = itemTypesFor(e.templateKind);
  const items = await db.select({ i: workspaceItems, owner: user.name }).from(workspaceItems).leftJoin(user, eq(user.id, workspaceItems.ownerId)).where(and(eq(workspaceItems.engagementId, e.id))).orderBy(asc(workspaceItems.sortOrder));
  const superseded = new Set(items.map((x) => x.i.supersedesId).filter(Boolean));
  const canWrite = can(actor, "delivery.write");
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">Workspace for the <b>{e.templateKind === "creative" ? "Creative Direction" : e.templateKind === "advisory" ? "Strategy, Financial & Operational Advisory" : "Executive Communication"}</b> stream. Results and KPIs must cite their source; nothing here is published or sent externally.</p>
      {defs.map((def) => {
        const list = items.filter((x) => x.i.itemType === def.key && !superseded.has(x.i.id));
        return (
          <Card key={def.key}>
            <CardHeader title={<span className="flex items-center gap-2">{def.plural}<Badge>{list.length}</Badge></span>} description={def.description} />
            {list.length ? (
              <ul className="divide-y divide-line">
                {list.map(({ i, owner }) => {
                  const late = !!i.dueDate && i.dueDate < today && !["approved", "completed", "published_manually", "final", "issued", "done", "closed", "agreed", "received", "verified", "reported", "recorded", "achieved"].includes(i.status);
                  return (
                    <li key={i.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{i.title}{i.versionNumber > 1 ? <span className="ml-2 text-[12px] text-muted">v{i.versionNumber}</span> : null}</p>
                        <span className="flex items-center gap-2">{i.channel ? <Badge>{i.channel}</Badge> : null}<StatusBadge status={i.status} label={label(i.status)} />{late ? <Badge tone="danger">late</Badge> : null}</span>
                      </div>
                      <p className="text-[12.5px] text-muted">{owner ?? "—"}{i.dueDate ? <> · due <DateText value={i.dueDate} overdue={late} /></> : null}{i.scheduledDate ? <> · scheduled <DateText value={i.scheduledDate} /></> : null}</p>
                      <dl className="mt-1 grid gap-x-6 gap-y-0.5 text-[13px] sm:grid-cols-2">
                        {def.fields.filter((f) => i.data[f.key] !== undefined && i.data[f.key] !== "").map((f) => (
                          <div key={f.key} className={f.type === "textarea" ? "sm:col-span-2" : undefined}>
                            <dt className="inline text-muted">{f.label}: </dt>
                            <dd className="inline whitespace-pre-wrap">{f.type === "url" ? <a className="text-accent hover:underline" href={String(i.data[f.key])} target="_blank" rel="noreferrer noopener">{String(i.data[f.key])}</a> : String(i.data[f.key])}</dd>
                          </div>
                        ))}
                      </dl>
                      {canWrite ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[12.5px] font-medium text-accent">Edit</summary>
                          <div className="mt-2"><ItemForm e={e} def={def} item={i} /></div>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {canWrite ? (
              <CardBody className={list.length ? "border-t border-line" : undefined}>
                <details>
                  <summary className="cursor-pointer text-[13px] font-medium text-accent">Add {def.label.toLowerCase()}</summary>
                  <div className="mt-3"><ItemForm e={e} def={def} /></div>
                </details>
              </CardBody>
            ) : !list.length ? <CardBody><p className="text-[13px] text-muted">Nothing recorded.</p></CardBody> : null}
          </Card>
        );
      })}
    </div>
  );
}

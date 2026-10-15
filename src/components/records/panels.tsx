import Link from "next/link";
import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, documents, tasks, user } from "@/db/schema";
import { timeline, type TimelineFilter } from "@/server/crm/activities";
import { documentVisibility, taskVisibility } from "@/server/auth/scope";
import { can, type Actor } from "@/server/auth/actor";
import { OPEN_TASK_STATUSES } from "@/server/delivery/tasks";
import { formatDate, formatDateTime } from "@/lib/dates";
import { Badge, Card, CardBody, CardHeader, EmptyState, PriorityBadge, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { createTaskAction, logActivityAction, taskStatusAction, uploadDocumentAction } from "@/server/actions/shared";

const TYPE_LABEL: Record<string, string> = {
  email: "Email", message: "Message", linkedin: "LinkedIn", call: "Call", meeting: "Meeting", note: "Note", task: "Task", stage_change: "Stage", status_change: "Status",
  proposal: "Proposal", contract: "Contract", handover: "Handover", renewal: "Renewal", deliverable: "Deliverable", invoice: "Invoice", payment: "Payment", system: "System",
};

/** Unified activity timeline: one row per activity, shown on every linked record. */
export async function TimelinePanel({ filter, actor, title = "Activity timeline", allowLog = true }: { filter: TimelineFilter; actor: Actor; title?: string; allowLog?: boolean }) {
  const rows = await timeline(db, filter, 150);
  const canLog = allowLog && (can(actor, "crm.write") || can(actor, "delivery.write"));
  return (
    <Card>
      <CardHeader title={title} description="Manually logged notes are marked “Logged”; system entries come from workflows; imported communications are marked “Imported”." />
      {canLog ? (
        <CardBody className="border-b border-line bg-[#fbfbf9]">
          <details>
            <summary className="cursor-pointer text-[13px] font-medium text-accent">Log a call, email, meeting or note</summary>
            <ActionForm action={logActivityAction} resetOnSuccess className="mt-3 space-y-3">
              {Object.entries(filter).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
              <FormGrid cols={4}>
                <Field label="Type" htmlFor="act-type">
                  <Select id="act-type" name="type" options={["call", "email", "meeting", "note", "message", "linkedin"].map((v) => ({ value: v, label: TYPE_LABEL[v] }))} />
                </Field>
                <Field label="Direction" htmlFor="act-dir">
                  <Select id="act-dir" name="direction" placeholder="—" options={[{ value: "outbound", label: "Outbound" }, { value: "inbound", label: "Inbound" }, { value: "internal", label: "Internal" }]} />
                </Field>
                <Field label="Outcome" htmlFor="act-outcome">
                  <Input id="act-outcome" name="outcome" placeholder="e.g. connected, no answer" />
                </Field>
                <Field label="Date" htmlFor="act-date">
                  <Input id="act-date" name="occurredOn" type="date" />
                </Field>
              </FormGrid>
              <Field label="Subject" htmlFor="act-subject" required>
                <Input id="act-subject" name="subject" required maxLength={300} />
              </Field>
              <Field label="Notes" htmlFor="act-body">
                <Textarea id="act-body" name="body" rows={3} />
              </Field>
              <SubmitButton size="sm">Log activity</SubmitButton>
            </ActionForm>
          </details>
        </CardBody>
      ) : null}
      {rows.length ? (
        <ol className="divide-y divide-line">
          {rows.map(({ activity: a, actorName }) => (
            <li key={a.id} className="flex gap-3 px-4 py-2.5">
              <div className="w-20 shrink-0 pt-0.5 text-right text-[11.5px] text-muted">
                {formatDate(a.occurredAt, "dd MMM")}
                <br />
                {formatDate(a.occurredAt, "yyyy")}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={["email", "call", "meeting", "message", "linkedin"].includes(a.type) ? "accent" : "neutral"}>{TYPE_LABEL[a.type] ?? a.type}</Badge>
                  {a.direction && a.direction !== "internal" ? <Badge>{a.direction}</Badge> : null}
                  <Badge tone={a.source === "imported" ? "info" : a.source === "system" ? "neutral" : "success"}>{a.source === "manual" ? "Logged" : a.source === "imported" ? "Imported" : "System"}</Badge>
                  <span className="text-[13px] font-medium text-ink">{a.subject}</span>
                </div>
                {a.body ? <p className="mt-1 whitespace-pre-line text-[12.5px] text-ink-2">{a.body}</p> : null}
                <p className="mt-0.5 text-[11.5px] text-faint">
                  {actorName ?? "System"}
                  {a.outcome ? ` · outcome: ${a.outcome.replace(/_/g, " ")}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title="No activity yet" description="Calls, emails, meetings, stage changes and handovers will appear here." />
      )}
    </Card>
  );
}

/** Tasks linked to a record, with a quick-add form. */
export async function TasksPanel({ actor, link, title = "Tasks", users }: { actor: Actor; link: Partial<Record<"accountId" | "leadId" | "opportunityId" | "engagementId" | "contactId" | "deliverableId" | "invoiceId" | "personId", string>>; title?: string; users: { id: string; name: string }[] }) {
  const conds: SQL[] = [];
  if (link.accountId) conds.push(eq(tasks.accountId, link.accountId));
  if (link.leadId) conds.push(eq(tasks.leadId, link.leadId));
  if (link.opportunityId) conds.push(eq(tasks.opportunityId, link.opportunityId));
  if (link.engagementId) conds.push(eq(tasks.engagementId, link.engagementId));
  if (link.contactId) conds.push(eq(tasks.contactId, link.contactId));
  if (link.invoiceId) conds.push(eq(tasks.invoiceId, link.invoiceId));
  if (link.personId) conds.push(eq(tasks.personId, link.personId));
  const rows = await db
    .select({ t: tasks, ownerName: user.name })
    .from(tasks)
    .leftJoin(user, eq(user.id, tasks.ownerId))
    .where(and(or(...conds), taskVisibility(actor)))
    .orderBy(desc(inArray(tasks.status, OPEN_TASK_STATUSES)), tasks.dueDate)
    .limit(100);
  const today = new Date().toISOString().slice(0, 10);
  const canCreate = can(actor, "crm.write") || can(actor, "delivery.write") || can(actor, "finance.write");
  return (
    <Card>
      <CardHeader title={title} actions={<Badge>{rows.filter((r) => OPEN_TASK_STATUSES.includes(r.t.status)).length} open</Badge>} />
      {canCreate ? (
        <CardBody className="border-b border-line bg-[#fbfbf9]">
          <ActionForm action={createTaskAction} resetOnSuccess className="flex flex-wrap items-end gap-2">
            {Object.entries(link).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
            <Field label="New task" htmlFor={`task-title-${Object.values(link)[0]}`} className="min-w-[200px] flex-1">
              <Input id={`task-title-${Object.values(link)[0]}`} name="title" placeholder="What needs doing?" required />
            </Field>
            <Field label="Owner" htmlFor="task-owner">
              <Select id="task-owner" name="ownerId" defaultValue={actor.userId} options={users.map((u) => ({ value: u.id, label: u.name }))} />
            </Field>
            <Field label="Due" htmlFor="task-due">
              <Input id="task-due" name="dueDate" type="date" />
            </Field>
            <Field label="Priority" htmlFor="task-pri">
              <Select id="task-pri" name="priority" defaultValue="medium" options={["low", "medium", "high", "urgent"].map((p) => ({ value: p, label: p }))} />
            </Field>
            <Field label="Kind" htmlFor="task-kind">
              <Select id="task-kind" name="kind" defaultValue="task" options={[{ value: "task", label: "Task" }, { value: "follow_up", label: "Follow-up" }, { value: "collection", label: "Collection" }, { value: "renewal", label: "Renewal" }]} />
            </Field>
            <SubmitButton size="md">Add</SubmitButton>
          </ActionForm>
        </CardBody>
      ) : null}
      {rows.length ? (
        <Table>
          <THead>
            <tr>
              <TH>Task</TH>
              <TH>Owner</TH>
              <TH>Due</TH>
              <TH>Priority</TH>
              <TH>Status</TH>
              <TH />
            </tr>
          </THead>
          <tbody>
            {rows.map(({ t, ownerName }) => {
              const open = OPEN_TASK_STATUSES.includes(t.status);
              return (
                <TR key={t.id} className={open ? "" : "opacity-60"}>
                  <TD>
                    <Link href={`/people/tasks/${t.id}`} className="font-medium text-ink hover:underline">
                      {t.title}
                    </Link>
                    {t.blockedReason ? <p className="text-[12px] text-danger">Blocked: {t.blockedReason}</p> : null}
                  </TD>
                  <TD>{ownerName ?? "—"}</TD>
                  <TD>
                    <DateText value={t.dueDate} overdue={open && !!t.dueDate && t.dueDate < today} />
                  </TD>
                  <TD>
                    <PriorityBadge priority={t.priority} />
                  </TD>
                  <TD>
                    <StatusBadge status={t.status} />
                  </TD>
                  <TD>
                    {open && t.status !== "blocked" ? (
                      <ActionForm action={taskStatusAction} hideSuccess>
                        <input type="hidden" name="id" value={t.id} />
                        <input type="hidden" name="status" value="completed" />
                        <SubmitButton size="sm" variant="ghost">
                          Complete
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No tasks" />
      )}
    </Card>
  );
}

const DOC_TYPES = ["client_file", "contract", "sow", "legal", "proposal", "deliverable", "brand_asset", "evidence", "receipt", "bill", "tax", "employment", "other"];

/** Documents linked to a record; respects visibility on the server. */
export async function DocumentsPanel({ actor, link, defaultType = "client_file", title = "Documents" }: { actor: Actor; link: Partial<Record<"accountId" | "opportunityId" | "proposalId" | "engagementId" | "contractId" | "deliverableId" | "personId" | "invoiceId" | "billId" | "expenseId" | "supplierId", string>>; defaultType?: string; title?: string }) {
  const conds: SQL[] = Object.entries(link).filter(([, v]) => v).map(([k, v]) => eq(documents[k as keyof typeof link] as typeof documents.accountId, v!));
  const rows = await db
    .select({ d: documents, uploader: user.name })
    .from(documents)
    .leftJoin(user, eq(user.id, documents.uploadedBy))
    .where(and(or(...conds), documentVisibility(actor), isNull(documents.archivedAt)))
    .orderBy(desc(documents.createdAt));
  const canUpload = can(actor, "documents.write") || can(actor, "delivery.write") || can(actor, "finance.write") || can(actor, "people.write");
  return (
    <Card>
      <CardHeader title={title} description="Private storage — downloads are authorised per user on the server." />
      {canUpload ? (
        <CardBody className="border-b border-line bg-[#fbfbf9]">
          <details>
            <summary className="cursor-pointer text-[13px] font-medium text-accent">Upload a document</summary>
            <ActionForm action={uploadDocumentAction} resetOnSuccess className="mt-3 space-y-3">
              {Object.entries(link).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
              <FormGrid cols={4}>
                <Field label="File" htmlFor="doc-file" required hint="PDF, images, Office files, CSV, ZIP · max 15 MB">
                  <Input id="doc-file" name="file" type="file" required />
                </Field>
                <Field label="Title" htmlFor="doc-title">
                  <Input id="doc-title" name="title" placeholder="Defaults to file name" />
                </Field>
                <Field label="Type" htmlFor="doc-type">
                  <Select id="doc-type" name="docType" defaultValue={defaultType} options={DOC_TYPES.filter((t) => t !== "employment" || can(actor, "people.private")).map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} />
                </Field>
                <Field label="Visibility" htmlFor="doc-vis">
                  <Select
                    id="doc-vis"
                    name="visibility"
                    options={[
                      { value: "internal", label: "Internal (record access)" },
                      ...(can(actor, "finance.read") ? [{ value: "finance", label: "Finance only" }] : []),
                      ...(can(actor, "people.private") ? [{ value: "hr_private", label: "Private HR" }] : []),
                      { value: "restricted", label: "Restricted (owner + grants)" },
                    ]}
                  />
                </Field>
                <Field label="Expires" htmlFor="doc-exp">
                  <Input id="doc-exp" name="expiresAt" type="date" />
                </Field>
              </FormGrid>
              <SubmitButton size="sm">Upload</SubmitButton>
            </ActionForm>
          </details>
        </CardBody>
      ) : null}
      {rows.length ? (
        <Table>
          <THead>
            <tr>
              <TH>Document</TH>
              <TH>Type</TH>
              <TH>Version</TH>
              <TH>Access</TH>
              <TH>Approval</TH>
              <TH>Expires</TH>
              <TH>Uploaded</TH>
            </tr>
          </THead>
          <tbody>
            {rows.map(({ d, uploader }) => (
              <TR key={d.id}>
                <TD>
                  <a href={`/api/documents/${d.id}/download`} className="font-medium text-accent hover:underline">
                    {d.title}
                  </a>
                  <p className="text-[11.5px] text-muted">
                    {d.fileName} · {(d.sizeBytes / 1024).toFixed(0)} KB
                  </p>
                </TD>
                <TD>{d.docType.replace(/_/g, " ")}</TD>
                <TD>
                  v{d.versionNumber}
                  {d.isLatest ? "" : <Badge className="ml-1">superseded</Badge>}
                </TD>
                <TD>
                  <Badge tone={d.visibility === "hr_private" ? "danger" : d.visibility === "restricted" ? "warning" : d.visibility === "finance" ? "info" : "neutral"}>{d.visibility.replace("_", " ")}</Badge>
                </TD>
                <TD>{d.approvalStatus !== "none" ? <StatusBadge status={d.approvalStatus} /> : <span className="text-faint">—</span>}</TD>
                <TD>
                  <DateText value={d.expiresAt} overdue={!!d.expiresAt && d.expiresAt < new Date().toISOString().slice(0, 10)} />
                </TD>
                <TD className="text-[12px]">
                  {uploader ?? "System"}
                  <br />
                  {formatDate(d.createdAt)}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No documents" />
      )}
    </Card>
  );
}

/** Audit history for one record (material changes, who/when/what). */
export async function AuditPanel({ entityType, entityId, actor, extra = [] }: { entityType: string; entityId: string; actor: Actor; extra?: { entityType: string; entityId: string }[] }) {
  if (!can(actor, "audit.read") && !can(actor, "crm.read") && !can(actor, "delivery.read")) return null;
  const pairs = [{ entityType, entityId }, ...extra];
  const rows = await db
    .select()
    .from(auditEvents)
    .where(or(...pairs.map((p) => and(eq(auditEvents.entityType, p.entityType), eq(auditEvents.entityId, p.entityId)))))
    .orderBy(desc(auditEvents.createdAt))
    .limit(50);
  return (
    <Card>
      <CardHeader title="Audit history" description="Who changed what and when. Secrets are never recorded." />
      {rows.length ? (
        <ol className="divide-y divide-line">
          {rows.map((e) => (
            <li key={e.id} className="px-4 py-2 text-[12.5px]">
              <p className="text-ink">{e.summary}</p>
              <p className="text-muted">
                {e.actorLabel.split(" <")[0]} · {formatDateTime(e.createdAt)} · <code className="text-[11px]">{e.action}</code>
              </p>
              {e.changes && Object.keys(e.changes).length && Object.values(e.changes).some((v) => v && typeof v === "object" && "from" in (v as object)) ? (
                <ul className="mt-1 space-y-0.5 text-[11.5px] text-ink-2">
                  {Object.entries(e.changes as Record<string, { from: unknown; to: unknown }>)
                    .filter(([, v]) => v && typeof v === "object" && "from" in v)
                    .map(([k, v]) => (
                      <li key={k}>
                        <span className="font-medium">{k}</span>: {String(v.from ?? "—")} → {String(v.to ?? "—")}
                      </li>
                    ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title="No audit events" />
      )}
    </Card>
  );
}

export async function listUsers() {
  return db.select({ id: user.id, name: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name);
}

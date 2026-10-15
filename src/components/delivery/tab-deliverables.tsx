import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { contacts, user } from "@/db/schema";
import type { engagements } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { deliverableHistory, listMilestonesWithDeliverables } from "@/server/delivery/engagements";
import { acceptMilestoneAction, createDeliverableAction, createMilestoneAction, reviewDeliverableAction, submitDeliverableAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";

type Eng = typeof engagements.$inferSelect;

export async function DeliverablesTab({ actor, e, today }: { actor: Actor; e: Eng; today: string }) {
  const { milestones, deliverables } = await listMilestonesWithDeliverables(db, e.id);
  const { versions, reviews } = await deliverableHistory(db, deliverables.map((d) => d.id));
  const users = await db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name);
  const cts = await db.select({ value: contacts.id, label: contacts.fullName }).from(contacts).where(eq(contacts.primaryAccountId, e.accountId));
  const userName = (id: string | null) => users.find((u) => u.value === id)?.label ?? "—";
  const canWrite = can(actor, "delivery.write");
  const canApprove = can(actor, "delivery.approve");
  const groups = [...milestones.map((m) => ({ m, items: deliverables.filter((d) => d.milestoneId === m.id) })), { m: null, items: deliverables.filter((d) => !d.milestoneId || !milestones.some((m) => m.id === d.milestoneId)) }];

  return (
    <div className="space-y-4">
      {groups.map(({ m, items }) => (m || items.length ? (
        <Card key={m?.id ?? "none"}>
          <CardHeader
            title={m ? <span className="flex flex-wrap items-center gap-2">{m.name}<StatusBadge status={m.status} />{m.billable ? <Badge tone="info">billable <Money value={m.billingAmount} currency={m.currency ?? e.currency} /></Badge> : null}</span> : "Deliverables without a milestone"}
            description={m ? <>Due <DateText value={m.dueDate} overdue={!!m.dueDate && m.dueDate < today && m.status !== "accepted"} />{m.acceptedAt ? <> · accepted <DateText value={m.acceptedAt} /> — {m.acceptanceEvidence}</> : null}</> : undefined}
            actions={m && m.status !== "accepted" && m.status !== "cancelled" && canApprove ? (
              <details className="text-right">
                <summary className="cursor-pointer text-[13px] font-medium text-accent">Record client acceptance</summary>
                <ActionForm action={acceptMilestoneAction} className="mt-2 w-[320px] space-y-2 text-left">
                  <input type="hidden" name="id" value={m.id} />
                  <Field label="Accepted on"><Input type="date" name="acceptedAt" defaultValue={today} required /></Field>
                  <Field label="Evidence" hint="e.g. sign-off email from the client"><Input name="acceptanceEvidence" required /></Field>
                  <Field label="Accepted by"><Select name="acceptedByContactId" options={cts} placeholder="—" /></Field>
                  <SubmitButton size="sm">Accept milestone</SubmitButton>
                </ActionForm>
              </details>
            ) : null}
          />
          {items.length ? (
            <ul className="divide-y divide-line">
              {items.map((d) => {
                const vs = versions.filter((v) => v.deliverableId === d.id);
                const rs = reviews.filter((r) => r.deliverableId === d.id);
                const pending = vs.find((v) => v.versionNumber === d.currentVersionNumber && v.outcome === "pending");
                const late = !!d.dueDate && d.dueDate < today && d.approvalStatus !== "approved";
                const revisionsOver = d.includedRevisions !== null && d.revisionsUsed > d.includedRevisions;
                return (
                  <li key={d.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{d.name}{d.deliverableType ? <span className="ml-2 text-[12px] font-normal text-muted">{d.deliverableType}</span> : null}</p>
                      <span className="flex items-center gap-2"><StatusBadge status={d.approvalStatus} />{late ? <Badge tone="danger">late</Badge> : null}{revisionsOver ? <Badge tone="warning">revisions over scope</Badge> : null}</span>
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-muted">Owner {userName(d.ownerId)} · due <DateText value={d.dueDate} overdue={late} /> · version {d.currentVersionNumber} · revisions {d.revisionsUsed}{d.includedRevisions !== null ? ` of ${d.includedRevisions} included` : ""}</p>
                    {d.description ? <p className="mt-1 text-[13px] text-ink-2">{d.description}</p> : null}
                    {vs.length ? (
                      <ul className="mt-2 space-y-1 border-l-2 border-line pl-3 text-[12.5px]">
                        {vs.map((v) => {
                          const r = rs.filter((x) => x.versionId === v.id);
                          return (
                            <li key={v.id}>
                              <span className="font-medium">v{v.versionNumber}</span> · {v.stage} review · <DateTimeText value={v.submittedAt} /> · <StatusBadge status={v.outcome} />
                              {v.link ? <> · <a className="text-accent hover:underline" href={v.link} target="_blank" rel="noreferrer noopener">link</a></> : null}
                              {v.notes ? <span className="text-muted"> — {v.notes}</span> : null}
                              {r.map((x) => <div key={x.id} className="text-muted">↳ {x.reviewerType} {x.decision.replace("_", " ")} by {x.reviewerName ?? userName(x.reviewerUserId)}{x.feedback ? `: ${x.feedback}` : ""}{x.evidence ? ` (evidence: ${x.evidence})` : ""}</div>)}
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-4">
                      {canWrite && !pending && d.approvalStatus !== "approved" ? (
                        <details>
                          <summary className="cursor-pointer text-[13px] font-medium text-accent">Submit a version for review</summary>
                          <ActionForm action={submitDeliverableAction} className="mt-2 w-[min(520px,90vw)] space-y-2">
                            <input type="hidden" name="id" value={d.id} />
                            <Field label="Review stage"><Select name="stage" options={[{ value: "internal", label: "Internal review" }, { value: "client", label: "Client review (recorded only — nothing is sent)" }]} /></Field>
                            <Field label="Link to the work"><Input name="link" placeholder="https://…" /></Field>
                            <Field label="Notes"><Textarea name="notes" rows={2} /></Field>
                            <SubmitButton size="sm">Submit version {d.currentVersionNumber + 1}</SubmitButton>
                          </ActionForm>
                        </details>
                      ) : null}
                      {pending && ((d.approvalStatus === "awaiting_client" && canApprove) || (d.approvalStatus === "internal_review" && canWrite)) ? (
                        <details open>
                          <summary className="cursor-pointer text-[13px] font-medium text-accent">Record {d.approvalStatus === "awaiting_client" ? "client" : "internal"} review of v{pending.versionNumber}</summary>
                          <ActionForm action={reviewDeliverableAction} className="mt-2 w-[min(520px,90vw)] space-y-2">
                            <input type="hidden" name="id" value={d.id} />
                            {d.approvalStatus === "awaiting_client" ? (
                              <FormGrid cols={2}>
                                <Field label="Client reviewer"><Select name="reviewerContactId" options={cts} placeholder="—" /></Field>
                                <Field label="Evidence" hint="Required to record approval."><Input name="evidence" placeholder="e.g. approval email 14 Oct" /></Field>
                              </FormGrid>
                            ) : null}
                            <Field label="Feedback"><Textarea name="feedback" rows={2} /></Field>
                            <div className="flex gap-2">
                              <SubmitButton size="sm" name="decision" value="approved">Approved</SubmitButton>
                              <SubmitButton size="sm" variant="secondary" name="decision" value="changes_requested">Changes requested</SubmitButton>
                              <SubmitButton size="sm" variant="danger" name="decision" value="rejected">Rejected</SubmitButton>
                            </div>
                          </ActionForm>
                        </details>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : <EmptyState title="No deliverables in this milestone" />}
        </Card>
      ) : null))}

      {canWrite ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Add deliverable" />
            <CardBody>
              <ActionForm action={createDeliverableAction} resetOnSuccess>
                <input type="hidden" name="engagementId" value={e.id} />
                <FormGrid cols={2}>
                  <Field label="Name" required><Input name="name" required /></Field>
                  <Field label="Type"><Input name="deliverableType" placeholder="e.g. Board pack" /></Field>
                  <Field label="Milestone"><Select name="milestoneId" options={milestones.map((m) => ({ value: m.id, label: m.name }))} placeholder="—" /></Field>
                  <Field label="Owner"><Select name="ownerId" options={users} defaultValue={actor.userId} /></Field>
                  <Field label="Due"><Input type="date" name="dueDate" /></Field>
                  <Field label="Included revisions"><Input type="number" min={0} name="includedRevisions" defaultValue={e.includedRevisions ?? ""} /></Field>
                </FormGrid>
                <Field label="Description" className="mt-3"><Textarea name="description" rows={2} /></Field>
                <div className="mt-3 flex justify-end"><SubmitButton>Add deliverable</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Add milestone" description="Billable milestones create a billing item that becomes invoiceable once the client accepts the milestone." />
            <CardBody>
              <ActionForm action={createMilestoneAction} resetOnSuccess>
                <input type="hidden" name="engagementId" value={e.id} />
                <FormGrid cols={2}>
                  <Field label="Name" required><Input name="name" required /></Field>
                  <Field label="Due"><Input type="date" name="dueDate" /></Field>
                  <Field label={`Billing amount (${e.currency})`}><Input name="billingAmount" inputMode="decimal" /></Field>
                  <div className="self-end pb-2"><Checkbox name="billable" label="Billable on acceptance" /></div>
                </FormGrid>
                <Field label="Description" className="mt-3"><Textarea name="description" rows={2} /></Field>
                <div className="mt-3 flex justify-end"><SubmitButton>Add milestone</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

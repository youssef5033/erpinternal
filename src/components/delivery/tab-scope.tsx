import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { changeRequests, contacts, scopeVersions, user } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { createChangeRequestAction, decideChangeRequestAction, defineScopeAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, StatusBadge } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import type { engagements } from "@/db/schema";

type Eng = typeof engagements.$inferSelect;

export async function ScopeTab({ actor, e }: { actor: Actor; e: Eng }) {
  const versions = await db.select({ v: scopeVersions, by: user.name }).from(scopeVersions).leftJoin(user, eq(user.id, scopeVersions.createdBy)).where(eq(scopeVersions.engagementId, e.id)).orderBy(desc(scopeVersions.versionNumber));
  const crs = await db.select({ cr: changeRequests, by: user.name }).from(changeRequests).leftJoin(user, eq(user.id, changeRequests.requestedBy)).where(eq(changeRequests.engagementId, e.id)).orderBy(desc(changeRequests.createdAt));
  const cts = await db.select({ value: contacts.id, label: contacts.fullName }).from(contacts).where(eq(contacts.primaryAccountId, e.accountId));
  const current = versions.find((x) => x.v.isCurrent)?.v;
  const canWrite = can(actor, "delivery.write");
  const canApprove = can(actor, "delivery.approve");
  const hasApprovedCr = crs.some((c) => c.cr.status === "approved");
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={current ? `Current scope — version ${current.versionNumber}` : "Scope not defined yet"} description={current ? <>Source: {current.sourceType.replace("_", " ")} · <DateTimeText value={current.createdAt} /></> : "Define what is in and out of scope so change requests have a baseline."} />
        <CardBody>
          {current ? (
            <DefinitionList
              items={[
                { label: "Summary", value: current.summary ?? "—", full: true },
                { label: "In scope", value: <span className="whitespace-pre-wrap">{current.inScope ?? "—"}</span>, full: true },
                { label: "Deliverables", value: current.deliverables.length ? <ul className="list-disc pl-5">{current.deliverables.map((d, i) => <li key={i}>{d.name}</li>)}</ul> : "—", full: true },
                { label: "Exclusions", value: <span className="whitespace-pre-wrap">{current.exclusions ?? "—"}</span>, full: true },
                { label: "Assumptions", value: <span className="whitespace-pre-wrap">{current.assumptions ?? "—"}</span>, full: true },
                { label: "Fee", value: <Money value={current.feeAmount} currency={current.currency ?? e.currency} /> },
                { label: "Budget hours", value: current.budgetHours ? Number(current.budgetHours).toFixed(1) : "—" },
                { label: "Budget cost", value: current.budgetCost ? <Money value={current.budgetCost} currency={e.currency} /> : "—" },
                { label: "End date", value: <DateText value={current.endDate} /> },
              ]}
            />
          ) : <EmptyState title="No scope recorded" />}
        </CardBody>
      </Card>

      {canWrite && !hasApprovedCr ? (
        <Card>
          <CardHeader title={current ? "Revise scope (before any change request)" : "Define scope"} description="Saving creates a new version; earlier versions are kept. After a change request has been approved, scope can only change through change requests." />
          <CardBody>
            <ActionForm action={defineScopeAction}>
              <input type="hidden" name="id" value={e.id} />
              <Field label="Summary"><Textarea name="summary" rows={2} defaultValue={current?.summary ?? ""} /></Field>
              <FormGrid cols={2} className="mt-3">
                <Field label="In scope"><Textarea name="inScope" rows={4} defaultValue={current?.inScope ?? ""} /></Field>
                <Field label="Deliverables (one per line)"><Textarea name="deliverablesText" rows={4} defaultValue={current?.deliverables.map((d) => d.name).join("\n") ?? ""} /></Field>
                <Field label="Exclusions"><Textarea name="exclusions" rows={3} defaultValue={current?.exclusions ?? ""} /></Field>
                <Field label="Assumptions"><Textarea name="assumptions" rows={3} defaultValue={current?.assumptions ?? ""} /></Field>
              </FormGrid>
              <FormGrid cols={4} className="mt-3">
                <Field label="Fee"><Input name="feeAmount" inputMode="decimal" defaultValue={current?.feeAmount ?? e.contractValue} /></Field>
                <Field label="Budget hours"><Input name="budgetHours" inputMode="decimal" defaultValue={current?.budgetHours ?? e.budgetHours ?? ""} /></Field>
                <Field label="Budget cost"><Input name="budgetCost" inputMode="decimal" defaultValue={current?.budgetCost ?? e.budgetCost ?? ""} /></Field>
                <Field label="End date"><Input type="date" name="endDate" defaultValue={current?.endDate ?? e.endDate ?? ""} /></Field>
              </FormGrid>
              <div className="mt-3 flex justify-end"><SubmitButton>Save scope version</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Change requests" description="Fee, hours, cost and deadline changes take effect only when approved with recorded client evidence." />
        {crs.length ? (
          <ul className="divide-y divide-line">
            {crs.map(({ cr, by }) => (
              <li key={cr.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{cr.number} · {cr.title}</p>
                  <StatusBadge status={cr.status} />
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink-2">{cr.proposedChanges}</p>
                <div className="mt-2 flex flex-wrap gap-3 text-[12.5px] text-muted">
                  <span>Fee <Money value={cr.feeImpact} currency={cr.currency} sign /></span>
                  <span>Hours {Number(cr.hoursImpact) >= 0 ? "+" : ""}{Number(cr.hoursImpact).toFixed(1)}</span>
                  <span>Cost <Money value={cr.costImpact} currency={cr.currency} sign /></span>
                  <span>Deadline {cr.deadlineImpactDays >= 0 ? "+" : ""}{cr.deadlineImpactDays}d{cr.newEndDate ? <> → <DateText value={cr.newEndDate} /></> : null}</span>
                  <span>Raised by {by ?? "—"} · <DateTimeText value={cr.createdAt} /></span>
                </div>
                {cr.clientApprovalEvidence ? <p className="mt-1 text-[12.5px]"><Badge tone="success">client approval</Badge> {cr.clientApprovalEvidence}</p> : null}
                {cr.decisionNote ? <p className="mt-1 text-[12.5px] text-muted">Decision note: {cr.decisionNote}</p> : null}
                {cr.status === "submitted" && canApprove ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[13px] font-medium text-accent">Record decision</summary>
                    <ActionForm action={decideChangeRequestAction} className="mt-2">
                      <input type="hidden" name="id" value={cr.id} />
                      <FormGrid cols={2}>
                        <Field label="Client approval evidence" hint="Required to approve: e.g. “Email from CFO, 12 Oct, approving revised fee”."><Input name="clientApprovalEvidence" /></Field>
                        <Field label="Approved by (client contact)"><Select name="clientApprovedByContactId" options={cts} placeholder="—" /></Field>
                      </FormGrid>
                      <Field label="Note" className="mt-2"><Input name="note" placeholder="Required when rejecting or withdrawing" /></Field>
                      <div className="mt-2 flex justify-end gap-2">
                        <SubmitButton variant="ghost" name="decision" value="withdrawn">Withdraw</SubmitButton>
                        <SubmitButton variant="danger" name="decision" value="rejected">Reject</SubmitButton>
                        <SubmitButton name="decision" value="approved" confirm="Approve? This creates a new scope version and updates budget and billing.">Approve</SubmitButton>
                      </div>
                    </ActionForm>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No change requests" />}
        {canWrite ? (
          <CardBody className="border-t border-line">
            <details>
              <summary className="cursor-pointer text-[13px] font-medium text-accent">Raise a change request</summary>
              <ActionForm action={createChangeRequestAction} resetOnSuccess className="mt-3">
                <input type="hidden" name="engagementId" value={e.id} />
                <FormGrid cols={2}>
                  <Field label="Title" required><Input name="title" required /></Field>
                  <Field label="Requested by (client)"><Select name="requestedByContactId" options={cts} placeholder="—" /></Field>
                </FormGrid>
                <Field label="Proposed changes" required className="mt-3"><Textarea name="proposedChanges" rows={3} required /></Field>
                <Field label="Background" className="mt-3"><Textarea name="description" rows={2} /></Field>
                <FormGrid cols={4} className="mt-3">
                  <Field label={`Fee impact (${e.currency})`}><Input name="feeImpact" inputMode="decimal" placeholder="e.g. 4500 or -1000" /></Field>
                  <Field label="Hours impact"><Input name="hoursImpact" inputMode="decimal" /></Field>
                  <Field label={`Cost impact (${e.currency})`}><Input name="costImpact" inputMode="decimal" /></Field>
                  <Field label="Deadline impact (days)"><Input type="number" name="deadlineImpactDays" /></Field>
                </FormGrid>
                <div className="mt-3 flex justify-end"><SubmitButton>Submit change request</SubmitButton></div>
              </ActionForm>
            </details>
          </CardBody>
        ) : null}
      </Card>

      {versions.length > 1 ? (
        <Card>
          <CardHeader title="Scope history" />
          <ul className="divide-y divide-line text-[13px]">
            {versions.map(({ v, by }) => (
              <li key={v.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                <span>v{v.versionNumber} · {v.sourceType.replace("_", " ")}{v.isCurrent ? <Badge tone="success" className="ml-2">current</Badge> : null}</span>
                <span className="text-muted"><Money value={v.feeAmount} currency={v.currency ?? e.currency} /> · {v.budgetHours ? `${Number(v.budgetHours).toFixed(0)}h` : "—"} · ends <DateText value={v.endDate} /> · {by ?? "System"} · <DateTimeText value={v.createdAt} /></span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

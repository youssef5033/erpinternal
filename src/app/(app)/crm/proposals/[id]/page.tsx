import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, opportunities, proposalAcceptances, proposalVersions, proposals, taxRates, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { opportunityVisibility } from "@/server/auth/scope";
import { agencyToday } from "@/server/system/settings";
import { formatDateTime } from "@/lib/dates";
import { Badge, Card, CardBody, CardHeader, DefinitionList, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel } from "@/components/records/panels";
import { proposalAcceptAction, proposalWorkflowAction, updateProposalAction } from "@/server/actions/crm";

export default async function ProposalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const actor = await guard("crm.read");
  const { id } = await params;
  const sp = await searchParams;
  const [row] = await db
    .select({ p: proposals, accountName: accounts.name, opp: opportunities, ownerName: user.name })
    .from(proposals)
    .innerJoin(accounts, eq(accounts.id, proposals.accountId))
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .leftJoin(user, eq(user.id, proposals.ownerId))
    .where(and(eq(proposals.id, id), opportunityVisibility(actor)));
  if (!row) notFound();
  const p = row.p;
  const versions = await db.select().from(proposalVersions).where(eq(proposalVersions.proposalId, id)).orderBy(desc(proposalVersions.versionNumber));
  const current = versions.find((v) => v.id === p.currentVersionId)!;
  const shown = versions.find((v) => String(v.versionNumber) === sp.v) ?? current;
  const [acceptance] = await db.select().from(proposalAcceptances).where(eq(proposalAcceptances.proposalId, id));
  const rates = await db.select().from(taxRates).where(eq(taxRates.active, true));
  const cts = await db.select().from(contacts).where(eq(contacts.primaryAccountId, p.accountId));
  const today = await agencyToday(db);
  const canWrite = can(actor, "crm.write");
  const editable = canWrite && shown.id === current.id && !current.locked;
  const approvers = can(actor, "proposals.approve");
  const blankLines = 3;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Proposals", href: "/crm/proposals" }, { label: p.number }]}
        title={p.title}
        description={<><Link href={`/crm/accounts/${p.accountId}`} className="text-accent hover:underline">{row.accountName}</Link> · <Link href={`/crm/opportunities/${p.opportunityId}`} className="text-accent hover:underline">{row.opp.number} {row.opp.name}</Link></>}
        meta={<><StatusBadge status={p.status} /><Badge>v{current.versionNumber}</Badge><StatusBadge status={current.approvalStatus === "not_requested" ? "draft" : current.approvalStatus} label={`approval: ${current.approvalStatus.replace("_", " ")}`} />{p.validUntil ? <span className="text-[12.5px] text-muted">Valid until <DateText value={p.validUntil} overdue={p.validUntil < today && p.status === "sent"} /></span> : null}</>}
        actions={<a className="inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3.5 text-sm hover:bg-sunken" href={`/api/proposals/${id}/pdf?v=${shown.versionNumber}`}>Download PDF (v{shown.versionNumber})</a>}
      />
      {acceptance ? (
        <Notice tone="success" title={`Accepted by ${acceptance.acceptedByName} on ${acceptance.acceptedAt}`} className="mb-4">
          Method: {acceptance.method.replace(/_/g, " ")}. {acceptance.method !== "verified_esignature" ? "This is a recorded acceptance, not a verified electronic signature." : ""} {acceptance.evidenceNote ? `Evidence: ${acceptance.evidenceNote}` : ""}
        </Notice>
      ) : null}
      {current.approvalStatus === "rejected" && current.approvalNote ? <Notice tone="warning" title="Returned for changes" className="mb-4">{current.approvalNote}</Notice> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {editable ? (
            <ActionForm action={updateProposalAction} className="space-y-4">
              <input type="hidden" name="id" value={id} />
              <Card>
                <CardHeader title={`Draft v${current.versionNumber}`} description="Editable until submitted for approval. After that, changes create a new version." actions={<SubmitButton size="sm">Save draft</SubmitButton>} />
                <CardBody className="space-y-3">
                  <FormGrid cols={4}>
                    <Field label="Pricing model" htmlFor="pricingModel"><Select id="pricingModel" name="pricingModel" defaultValue={current.pricingModel} options={[{ value: "fixed", label: "Fixed fee" }, { value: "retainer", label: "Retainer" }, { value: "milestone", label: "Milestone" }, { value: "hourly", label: "Hourly" }]} /></Field>
                    <Field label="Currency" htmlFor="currency"><Select id="currency" name="currency" defaultValue={current.currency} options={CURRENCIES} /></Field>
                    <Field label="Start" htmlFor="startDate"><Input id="startDate" name="startDate" type="date" defaultValue={current.startDate ?? ""} /></Field>
                    <Field label="End" htmlFor="endDate"><Input id="endDate" name="endDate" type="date" defaultValue={current.endDate ?? ""} /></Field>
                    <Field label="Discount %" htmlFor="discountPercent"><Input id="discountPercent" name="discountPercent" defaultValue={Number(current.discountPercent) ? String(Number(current.discountPercent)) : ""} /></Field>
                    <Field label="Tax rate" htmlFor="taxRateId"><Select id="taxRateId" name="taxRateId" defaultValue={current.taxRateId ?? ""} placeholder="No tax" options={rates.map((r) => ({ value: r.id, label: `${r.name} (${Number(r.ratePercent)}%)` }))} /></Field>
                    <Field label="Estimated hours" htmlFor="estimatedHours"><Input id="estimatedHours" name="estimatedHours" defaultValue={current.estimatedHours ? String(Number(current.estimatedHours)) : ""} /></Field>
                    <Field label="Retainer months" htmlFor="retainerMonths"><Input id="retainerMonths" name="retainerMonths" type="number" defaultValue={current.retainerMonths ?? ""} /></Field>
                    <Field label="Hourly rate" htmlFor="hourlyRate"><Input id="hourlyRate" name="hourlyRate" defaultValue={current.hourlyRate ?? ""} /></Field>
                  </FormGrid>
                  <Field label="Introduction" htmlFor="introduction"><Textarea id="introduction" name="introduction" defaultValue={current.introduction ?? ""} rows={2} /></Field>
                  <FormGrid cols={2}>
                    <Field label="Scope" htmlFor="scope"><Textarea id="scope" name="scope" defaultValue={current.scope ?? ""} rows={4} /></Field>
                    <Field label="Timeline" htmlFor="timeline"><Textarea id="timeline" name="timeline" defaultValue={current.timeline ?? ""} rows={4} /></Field>
                    <Field label="Exclusions" htmlFor="exclusions"><Textarea id="exclusions" name="exclusions" defaultValue={current.exclusions ?? ""} /></Field>
                    <Field label="Assumptions" htmlFor="assumptions"><Textarea id="assumptions" name="assumptions" defaultValue={current.assumptions ?? ""} /></Field>
                  </FormGrid>
                  <Field label="Terms" htmlFor="terms"><Textarea id="terms" name="terms" defaultValue={current.terms ?? ""} rows={2} /></Field>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Pricing" description="Clear a description to remove a line." />
                <CardBody className="space-y-2">
                  {[...current.lines, ...Array.from({ length: blankLines }, () => ({ description: "", quantity: "", unitPrice: "" }))].map((l, i) => (
                    <div key={i} className="grid grid-cols-[1fr_90px_140px] gap-2">
                      <Input name={`lines.${i}.description`} defaultValue={l.description} placeholder="Description" aria-label={`Line ${i + 1} description`} />
                      <Input name={`lines.${i}.quantity`} defaultValue={l.quantity ? String(Number(l.quantity)) : ""} placeholder="Qty" aria-label={`Line ${i + 1} quantity`} />
                      <Input name={`lines.${i}.unitPrice`} defaultValue={l.unitPrice} placeholder="Unit price" aria-label={`Line ${i + 1} unit price`} />
                    </div>
                  ))}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Deliverables" description="Due offsets are days from the start date. Group deliverables under milestones for milestone billing." />
                <CardBody className="space-y-2">
                  {[...current.deliverables, ...Array.from({ length: 2 }, () => ({ name: "", dueOffsetDays: undefined, milestone: "", description: "" }))].map((dl, i) => (
                    <div key={i} className="grid grid-cols-[1fr_110px_160px] gap-2">
                      <Input name={`deliverables.${i}.name`} defaultValue={dl.name} placeholder="Deliverable" aria-label={`Deliverable ${i + 1}`} />
                      <Input name={`deliverables.${i}.dueOffsetDays`} defaultValue={dl.dueOffsetDays ?? ""} placeholder="Due +days" aria-label={`Deliverable ${i + 1} due offset`} />
                      <Input name={`deliverables.${i}.milestone`} defaultValue={dl.milestone ?? ""} placeholder="Milestone" aria-label={`Deliverable ${i + 1} milestone`} />
                    </div>
                  ))}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Payment schedule" description="Use percentages (must total 100%) or fixed amounts (must equal the total). Tie items to a milestone or days after start." />
                <CardBody className="space-y-2">
                  {[...current.paymentSchedule, ...Array.from({ length: 2 }, () => ({ label: "", percent: "", amount: "", dueAfterDays: null, milestone: "" }))].map((s, i) => (
                    <div key={i} className="grid grid-cols-[1fr_90px_120px_110px_150px] gap-2">
                      <Input name={`schedule.${i}.label`} defaultValue={s.label} placeholder="Label" aria-label={`Payment ${i + 1} label`} />
                      <Input name={`schedule.${i}.percent`} defaultValue={s.percent ?? ""} placeholder="%" aria-label={`Payment ${i + 1} percent`} />
                      <Input name={`schedule.${i}.amount`} defaultValue={s.amount ?? ""} placeholder="Amount" aria-label={`Payment ${i + 1} amount`} />
                      <Input name={`schedule.${i}.dueAfterDays`} defaultValue={s.dueAfterDays ?? ""} placeholder="+days" aria-label={`Payment ${i + 1} days`} />
                      <Input name={`schedule.${i}.milestone`} defaultValue={s.milestone ?? ""} placeholder="Milestone" aria-label={`Payment ${i + 1} milestone`} />
                    </div>
                  ))}
                </CardBody>
              </Card>
            </ActionForm>
          ) : (
            <VersionView v={shown} />
          )}
          <DocumentsPanel actor={actor} link={{ proposalId: id }} defaultType="proposal" title="Proposal files & acceptance evidence" />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Totals" />
            <CardBody className="space-y-1 text-[13px]">
              <p className="flex justify-between"><span className="text-muted">Subtotal</span><Money value={shown.subtotal} currency={shown.currency} /></p>
              <p className="flex justify-between"><span className="text-muted">Discount</span><Money value={shown.discountAmount} currency={shown.currency} /></p>
              <p className="flex justify-between"><span className="text-muted">Tax ({Number(shown.taxRatePercent)}%)</span><Money value={shown.taxAmount} currency={shown.currency} /></p>
              <p className="flex justify-between border-t border-line pt-1 font-semibold"><span>Total</span><Money value={shown.total} currency={shown.currency} /></p>
            </CardBody>
          </Card>
          {canWrite ? (
            <Card>
              <CardHeader title="Workflow" description="Draft → internal approval → sent → accepted / rejected / expired." />
              <CardBody className="space-y-2">
                {!current.locked ? <ActionForm action={proposalWorkflowAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="submit" /><SubmitButton size="sm">Submit for internal approval</SubmitButton></ActionForm> : null}
                {current.approvalStatus === "pending" && approvers ? (
                  <ActionForm action={proposalWorkflowAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    <Input name="note" placeholder="Approval note (required to return)" aria-label="Approval note" />
                    <div className="flex gap-2"><SubmitButton size="sm" name="op" value="approve">Approve</SubmitButton><SubmitButton size="sm" variant="secondary" name="op" value="return">Return for changes</SubmitButton></div>
                  </ActionForm>
                ) : current.approvalStatus === "pending" ? <p className="text-[12.5px] text-muted">Waiting for an approver (proposals.approve).</p> : null}
                {current.approvalStatus === "approved" && ["approved"].includes(p.status) ? (
                  <ActionForm action={proposalWorkflowAction} className="flex gap-2">
                    <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="sent" />
                    <Input name="sentOn" type="date" defaultValue={today} aria-label="Sent on" className="w-40" />
                    <SubmitButton size="sm">Mark sent</SubmitButton>
                  </ActionForm>
                ) : null}
                {current.locked && !["accepted"].includes(p.status) ? (
                  <ActionForm action={proposalWorkflowAction} className="space-y-1">
                    <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="revise" />
                    <Input name="note" placeholder="What changes in the new version?" aria-label="Revision summary" required />
                    <SubmitButton size="sm" variant="secondary">Create revision v{current.versionNumber + 1}</SubmitButton>
                  </ActionForm>
                ) : null}
                {p.status === "sent" ? (
                  <ActionForm action={proposalWorkflowAction} className="space-y-1">
                    <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="reject" />
                    <Input name="note" placeholder="Client's reason" aria-label="Rejection reason" />
                    <SubmitButton size="sm" variant="ghost">Client rejected</SubmitButton>
                  </ActionForm>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
          {canWrite && p.status === "sent" ? (
            <Card>
              <CardHeader title="Record client acceptance" description="A manual record is labelled as such — it is never shown as a verified e-signature." />
              <CardBody>
                <ActionForm action={proposalAcceptAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <Field label="Accepted on" htmlFor="acceptedAt"><Input id="acceptedAt" name="acceptedAt" type="date" defaultValue={today} required /></Field>
                  <Field label="Accepted by (name)" htmlFor="acceptedByName"><Input id="acceptedByName" name="acceptedByName" required /></Field>
                  <Field label="Contact" htmlFor="acceptedByContactId"><Select id="acceptedByContactId" name="acceptedByContactId" placeholder="—" options={cts.map((c) => ({ value: c.id, label: c.fullName }))} /></Field>
                  <Field label="Method" htmlFor="method"><Select id="method" name="method" options={[{ value: "email_confirmation", label: "Email confirmation" }, { value: "signed_document", label: "Signed document (upload as evidence)" }, { value: "manual_record", label: "Manual record (verbal / meeting)" }]} /></Field>
                  <Field label="Evidence" htmlFor="evidenceNote" hint="e.g. 'Email from CFO, 12 Oct, subject …'"><Textarea id="evidenceNote" name="evidenceNote" rows={2} /></Field>
                  <SubmitButton size="sm">Record acceptance</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Version history" />
            <ul className="divide-y divide-line">
              {versions.map((v) => (
                <li key={v.id} className="px-4 py-2 text-[12.5px]">
                  <Link href={`/crm/proposals/${id}?v=${v.versionNumber}`} className={`font-medium hover:underline ${v.id === shown.id ? "text-accent" : ""}`}>v{v.versionNumber}</Link> · <Money value={v.total} currency={v.currency} /> · <StatusBadge status={v.approvalStatus === "not_requested" ? "draft" : v.approvalStatus} label={v.approvalStatus.replace("_", " ")} />
                  {v.id === p.acceptedVersionId ? <Badge tone="success" className="ml-1">accepted</Badge> : null}
                  <p className="text-muted">{formatDateTime(v.createdAt)}{v.changeSummary ? ` · ${v.changeSummary}` : ""}</p>
                </li>
              ))}
            </ul>
          </Card>
          {row.opp.status === "open" && p.status === "accepted" ? <LinkButton href={`/crm/opportunities/${p.opportunityId}`} variant="primary">Mark opportunity won →</LinkButton> : null}
          <AuditPanel actor={actor} entityType="proposal" entityId={id} />
        </div>
      </div>
    </>
  );
}

function VersionView({ v }: { v: typeof proposalVersions.$inferSelect }) {
  return (
    <Card>
      <CardHeader title={`Version ${v.versionNumber}`} description={v.locked ? "Locked — submitted or sent versions are preserved unchanged." : "Draft"} />
      <CardBody className="space-y-4">
        <DefinitionList columns={2} items={[
          { label: "Pricing model", value: v.pricingModel },
          { label: "Dates", value: <><DateText value={v.startDate} /> – <DateText value={v.endDate} /></> },
          { label: "Introduction", value: v.introduction, full: true },
          { label: "Scope", value: <span className="whitespace-pre-line">{v.scope}</span>, full: true },
          { label: "Exclusions", value: v.exclusions, full: true },
          { label: "Assumptions", value: v.assumptions, full: true },
          { label: "Timeline", value: v.timeline, full: true },
          { label: "Terms", value: v.terms, full: true },
        ]} />
        <Table>
          <THead><tr><TH>Line</TH><TH align="right">Qty</TH><TH align="right">Unit</TH><TH align="right">Amount</TH></tr></THead>
          <tbody>{v.lines.map((l, i) => <TR key={i}><TD>{l.description}</TD><TD align="right">{Number(l.quantity)}</TD><TD align="right"><Money value={l.unitPrice} currency={v.currency} /></TD><TD align="right"><Money value={(Number(l.quantity) * Number(l.unitPrice)).toFixed(2)} currency={v.currency} /></TD></TR>)}</tbody>
        </Table>
        {v.deliverables.length ? <div><p className="mb-1 text-[12.5px] font-medium">Deliverables</p><ul className="list-disc pl-5 text-[13px]">{v.deliverables.map((d, i) => <li key={i}>{d.name}{d.milestone ? ` (${d.milestone})` : ""}{d.dueOffsetDays != null ? ` · +${d.dueOffsetDays}d` : ""}</li>)}</ul></div> : null}
        {v.paymentSchedule.length ? <div><p className="mb-1 text-[12.5px] font-medium">Payment schedule</p><ul className="list-disc pl-5 text-[13px]">{v.paymentSchedule.map((s, i) => <li key={i}>{s.label}: {s.percent ? `${s.percent}%` : s.amount}{s.milestone ? ` on ${s.milestone}` : s.dueAfterDays != null ? ` at +${s.dueAfterDays}d` : ""}{s.recurring ? " (monthly)" : ""}</li>)}</ul></div> : null}
      </CardBody>
    </Card>
  );
}

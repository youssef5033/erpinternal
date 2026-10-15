import { AiPanel } from "@/components/ai/ai-panel";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db/client";
import { accounts, campaigns, contacts, engagements, opportunities, opportunityContacts, opportunityServices, opportunityStageHistory, pipelineStages, proposalTemplates, proposalVersions, proposals, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { opportunityVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO, formatDateTime } from "@/lib/dates";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input, Select, Textarea } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel, TasksPanel, TimelinePanel, listUsers } from "@/components/records/panels";
import { createProposalAction, opportunityLostAction, opportunityNextActionAction, opportunityReopenAction, opportunityStageAction, opportunityWonAction, scheduleEventAction } from "@/server/actions/crm";

export default async function OpportunityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await guard("crm.read");
  const { id } = await params;
  const sp = await searchParams;
  const [row] = await db
    .select({ o: opportunities, accountName: accounts.name, stage: pipelineStages, ownerName: user.name, campaignName: campaigns.name })
    .from(opportunities)
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .leftJoin(user, eq(user.id, opportunities.ownerId))
    .leftJoin(campaigns, eq(campaigns.id, opportunities.campaignId))
    .where(and(eq(opportunities.id, id), opportunityVisibility(actor)));
  if (!row) notFound();
  const o = row.o;
  const tab = ["overview", "proposals", "history", "activity", "documents"].includes(sp.tab ?? "") ? sp.tab! : "overview";
  const fromStage = alias(pipelineStages, "from_stage");
  const [stages, svc, cts, hist, props, templates, eng, L, users, today] = await Promise.all([
    db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, o.pipelineId)).orderBy(asc(pipelineStages.sortOrder)),
    db.select({ s: services }).from(opportunityServices).innerJoin(services, eq(services.id, opportunityServices.serviceId)).where(eq(opportunityServices.opportunityId, id)),
    db.select({ c: contacts, role: opportunityContacts.role }).from(opportunityContacts).innerJoin(contacts, eq(contacts.id, opportunityContacts.contactId)).where(eq(opportunityContacts.opportunityId, id)),
    db.select({ h: opportunityStageHistory, to: pipelineStages.name, from: fromStage.name, by: user.name }).from(opportunityStageHistory).innerJoin(pipelineStages, eq(pipelineStages.id, opportunityStageHistory.toStageId)).leftJoin(fromStage, eq(fromStage.id, opportunityStageHistory.fromStageId)).leftJoin(user, eq(user.id, opportunityStageHistory.changedBy)).where(eq(opportunityStageHistory.opportunityId, id)).orderBy(desc(opportunityStageHistory.changedAt)),
    db.select({ p: proposals, v: proposalVersions }).from(proposals).leftJoin(proposalVersions, eq(proposalVersions.id, proposals.currentVersionId)).where(eq(proposals.opportunityId, id)).orderBy(desc(proposals.createdAt)),
    db.select().from(proposalTemplates).where(eq(proposalTemplates.active, true)),
    db.select().from(engagements).where(eq(engagements.opportunityId, id)),
    crmLookups(),
    listUsers(),
    agencyToday(db),
  ]);
  const canWrite = can(actor, "crm.write");
  const open = o.status === "open";
  const prob = o.probabilityOverride ?? row.stage.probability;
  const href = (t: string) => `/crm/opportunities/${id}${t === "overview" ? "" : `?tab=${t}`}`;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Opportunities", href: "/crm/opportunities" }, { label: o.number }]}
        title={o.name}
        description={<><Link href={`/crm/accounts/${o.accountId}`} className="text-accent hover:underline">{row.accountName}</Link> · {o.kind.replace("_", " ")} · owner {row.ownerName ?? "—"}</>}
        meta={
          <>
            <StatusBadge status={o.status === "open" ? "open" : o.status} label={row.stage.name} />
            <span className="text-[13px]"><Money value={o.value} currency={o.currency} /> · {prob}% · weighted <Money value={(Number(o.value) * prob / 100).toFixed(2)} currency={o.currency} /></span>
            {svc.map(({ s }) => <Badge key={s.id} tone={s.key as "creative"}>{s.shortName}</Badge>)}
          </>
        }
        actions={canWrite ? <>{open ? <LinkButton href={`/crm/opportunities/${id}/edit`}>Edit</LinkButton> : null}{o.status === "won" && !eng.length ? <LinkButton href={`/crm/opportunities/${id}/handover`} variant="primary">Review handover</LinkButton> : null}</> : null}
      />
      {o.status === "won" ? (
        <Notice tone="success" title={`Won ${o.wonAt ? formatDateTime(o.wonAt) : ""} — booking of ${o.currency} ${o.closedValue}`} className="mb-4">
          A booking is not revenue or cash: revenue is recognised as work is delivered; cash when invoices are paid.{" "}
          {eng.length ? <>Handed over to <Link className="font-medium underline" href={`/delivery/engagements/${eng[0].id}`}>{eng[0].number}</Link>.</> : <>Not yet handed over — <Link className="font-medium underline" href={`/crm/opportunities/${id}/handover`}>review the handover</Link>.</>}
        </Notice>
      ) : null}
      {o.status === "lost" ? <Notice tone="danger" title={`Lost: ${o.lostReason}`} className="mb-4">{o.lostNotes}</Notice> : null}
      <div className="mb-4 flex flex-wrap gap-1" aria-label="Pipeline stages">
        {stages.filter((s) => s.kind === "open").map((s) => (
          <span key={s.id} className={`rounded px-2 py-1 text-[12px] ${s.id === o.stageId ? "bg-accent text-white" : s.sortOrder < row.stage.sortOrder ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted"}`}>{s.name}</span>
        ))}
      </div>
      <Tabs tabs={[{ key: "overview", label: "Overview", href: href("overview") }, { key: "proposals", label: "Proposals", href: href("proposals"), count: props.length }, { key: "history", label: "Stage history", href: href("history") }, { key: "activity", label: "Activity", href: href("activity") }, { key: "documents", label: "Documents", href: href("documents") }]} current={tab} />

      {tab === "overview" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="Deal details" />
              <CardBody>
                <DefinitionList columns={3} items={[
                  { label: "Pricing model", value: o.pricingModel },
                  { label: "Expected close", value: <DateText value={o.expectedCloseDate} overdue={open && !!o.expectedCloseDate && o.expectedCloseDate < today} /> },
                  { label: "Acquisition source", value: L.channelLabel(o.acquisitionChannel) },
                  { label: "Campaign", value: row.campaignName },
                  { label: "Competitors", value: o.competitors },
                  { label: "Source lead", value: o.sourceLeadId ? <Link className="text-accent hover:underline" href={`/crm/leads/${o.sourceLeadId}`}>View research</Link> : null },
                  { label: "Business problem", value: o.businessProblem, full: true },
                  { label: "Desired outcome", value: o.desiredOutcome, full: true },
                  { label: "Scope summary", value: o.scopeSummary, full: true },
                  { label: "Discovery notes", value: o.discoveryNotes, full: true },
                  { label: "Objections", value: o.objections, full: true },
                ]} />
              </CardBody>
            </Card>
            <TasksPanel actor={actor} link={{ opportunityId: id }} users={users} />
          </div>
          <div className="space-y-4">
            {canWrite && open ? (
              <Card>
                <CardHeader title="Next action" description="Every open deal should have one." />
                <CardBody>
                  <ActionForm action={opportunityNextActionAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    <Input name="nextAction" defaultValue={o.nextAction ?? ""} aria-label="Next action" required />
                    <Input name="nextActionDate" type="date" defaultValue={o.nextActionDate ?? ""} aria-label="Next action date" />
                    <SubmitButton size="sm">Save</SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            ) : null}
            {canWrite && open ? (
              <Card>
                <CardHeader title="Move stage" />
                <CardBody className="space-y-3">
                  <ActionForm action={opportunityStageAction} className="space-y-2">
                    <input type="hidden" name="id" value={id} />
                    <Select name="stageId" defaultValue={o.stageId} aria-label="Stage" options={stages.filter((s) => s.kind === "open").map((s) => ({ value: s.id, label: `${s.name} (${s.probability}%)` }))} />
                    <Input name="note" placeholder="Note (optional)" aria-label="Stage note" />
                    <SubmitButton size="sm" variant="secondary">Move</SubmitButton>
                  </ActionForm>
                  <details>
                    <summary className="cursor-pointer text-[13px] font-medium text-success">Mark won…</summary>
                    <ActionForm action={opportunityWonAction} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={id} />
                      <Field label="Closed value" htmlFor="closedValue"><Input id="closedValue" name="closedValue" defaultValue={o.value} /></Field>
                      <Input name="note" placeholder="Note" aria-label="Note" />
                      <SubmitButton size="sm">Mark won and review handover</SubmitButton>
                    </ActionForm>
                  </details>
                  <details>
                    <summary className="cursor-pointer text-[13px] font-medium text-danger">Mark lost…</summary>
                    <ActionForm action={opportunityLostAction} className="mt-2 space-y-2">
                      <input type="hidden" name="id" value={id} />
                      <Select name="lostReason" aria-label="Lost reason" options={L.lostReasons.map((r) => ({ value: r, label: r }))} />
                      <Textarea name="lostNotes" placeholder="What happened?" aria-label="Lost notes" rows={2} />
                      <SubmitButton size="sm" variant="danger">Mark lost</SubmitButton>
                    </ActionForm>
                  </details>
                </CardBody>
              </Card>
            ) : null}
            {canWrite && o.status === "lost" ? (
              <ActionForm action={opportunityReopenAction} className="flex gap-1">
                <input type="hidden" name="id" value={id} />
                <Select name="stageId" aria-label="Reopen in stage" options={stages.filter((s) => s.kind === "open").map((s) => ({ value: s.id, label: s.name }))} />
                <SubmitButton size="sm" variant="secondary">Reopen</SubmitButton>
              </ActionForm>
            ) : null}
            <Card>
              <CardHeader title="Contacts" />
              <ul className="divide-y divide-line">
                {cts.map(({ c, role }) => <li key={c.id} className="px-4 py-2 text-[13px]"><Link href={`/crm/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link> {o.primaryContactId === c.id ? <Badge>primary</Badge> : null}<p className="text-[12px] text-muted">{c.jobTitle}{role ? ` · ${role}` : ""}</p></li>)}
                {!cts.length ? <li className="px-4 py-3 text-[13px] text-muted">No contacts linked.</li> : null}
              </ul>
            </Card>
            {canWrite && open ? (
              <Card>
                <CardHeader title="Book a meeting" />
                <CardBody>
                  <ActionForm action={scheduleEventAction} className="space-y-2">
                    <input type="hidden" name="opportunityId" value={id} />
                    <input type="hidden" name="accountId" value={o.accountId} />
                    {o.primaryContactId ? <input type="hidden" name="contactId" value={o.primaryContactId} /> : null}
                    <Select name="kind" aria-label="Kind" options={[{ value: "discovery", label: "Discovery call" }, { value: "meeting", label: "Meeting" }, { value: "call", label: "Call" }]} />
                    <Input name="title" defaultValue={`${row.accountName} — discovery`} aria-label="Title" required />
                    <div className="flex gap-2">
                      <Input name="date" type="date" defaultValue={addDaysISO(today, 2)} aria-label="Date" required />
                      <Input name="startTime" type="time" defaultValue="10:00" aria-label="Start time" required />
                    </div>
                    <div className="flex gap-2">
                      <Input name="durationMinutes" type="number" defaultValue={45} aria-label="Duration (minutes)" />
                      <Input name="timeZone" defaultValue={actor.timeZone ?? "UTC"} aria-label="Time zone" />
                    </div>
                    <SubmitButton size="sm">Schedule</SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            ) : null}
            <AiPanel actor={actor} kind="followup_draft" entityId={id} title="Draft a follow-up" description="A first draft of a follow-up email from this opportunity's recorded activity. Copy, edit and send it yourself." />
            <AuditPanel actor={actor} entityType="opportunity" entityId={id} />
          </div>
        </div>
      ) : null}

      {tab === "proposals" ? (
        <div className="space-y-4">
          {canWrite && open ? (
            <Card>
              <CardHeader title="New proposal" description="Start from a template or from this opportunity's scope and value." />
              <CardBody>
                <ActionForm action={createProposalAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="opportunityId" value={id} />
                  <Field label="Title" htmlFor="ptitle" className="min-w-[240px] flex-1"><Input id="ptitle" name="title" defaultValue={o.name} required /></Field>
                  <Field label="Template" htmlFor="ptemplate"><Select id="ptemplate" name="templateId" placeholder="None" options={templates.map((t) => ({ value: t.id, label: t.name }))} /></Field>
                  <Field label="Valid until" htmlFor="pvalid"><Input id="pvalid" name="validUntil" type="date" defaultValue={addDaysISO(today, 30)} /></Field>
                  <SubmitButton>Create proposal</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}
          <Card>
            {props.length ? (
              <Table>
                <THead><tr><TH>Proposal</TH><TH>Status</TH><TH>Current version</TH><TH>Approval</TH><TH>Valid until</TH><TH align="right">Total</TH></tr></THead>
                <tbody>
                  {props.map(({ p, v }) => (
                    <TR key={p.id}>
                      <TD><Link className="font-medium hover:underline" href={`/crm/proposals/${p.id}`}>{p.number} {p.title}</Link></TD>
                      <TD><StatusBadge status={p.status} /></TD>
                      <TD>v{v?.versionNumber}</TD>
                      <TD><StatusBadge status={v?.approvalStatus === "not_requested" ? "draft" : v?.approvalStatus} label={v?.approvalStatus.replace("_", " ")} /></TD>
                      <TD><DateText value={p.validUntil} /></TD>
                      <TD align="right"><Money value={v?.total} currency={v?.currency} /></TD>
                    </TR>
                  ))}
                </tbody>
              </Table>
            ) : <EmptyState title="No proposals yet" />}
          </Card>
        </div>
      ) : null}

      {tab === "history" ? (
        <Card>
          <CardHeader title="Stage history" description="Every stage change with time spent in the previous stage." />
          <Table>
            <THead><tr><TH>When</TH><TH>From</TH><TH>To</TH><TH align="right">Time in previous stage</TH><TH>By</TH><TH>Note</TH></tr></THead>
            <tbody>
              {hist.map(({ h, to, from, by }) => (
                <TR key={h.id}>
                  <TD>{formatDateTime(h.changedAt)}</TD>
                  <TD>{from ?? "—"}</TD>
                  <TD>{to}</TD>
                  <TD align="right">{h.secondsInPreviousStage != null ? `${(h.secondsInPreviousStage / 86400).toFixed(1)} days` : "—"}</TD>
                  <TD>{by ?? "System"}</TD>
                  <TD className="text-[12.5px]">{h.note}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
      {tab === "activity" ? <TimelinePanel actor={actor} filter={{ opportunityId: id }} /> : null}
      {tab === "documents" ? <DocumentsPanel actor={actor} link={{ opportunityId: id }} defaultType="proposal" /> : null}
    </>
  );
}

import Link from "next/link";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { campaignMembers, campaigns, contacts, leadContacts, leads, outreachMessages, outreachTemplates, sequenceEnrollments, sequences, sequenceSteps, services, suppressions, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { sendingIntegration } from "@/server/crm/outreach";
import { crmLookups } from "@/server/crm/lookups";
import { draftAction, generateDraftsAction, liftSuppressionAction } from "@/server/actions/crm";
import { qs } from "@/lib/utils";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input, Textarea } from "@/components/forms/fields";
import { CampaignForm, SequenceForm, TemplateForm } from "@/components/crm/outreach-forms";

export const metadata = { title: "Outreach & campaigns" };

const TABS = [
  { key: "queue", label: "Draft queue" },
  { key: "sequences", label: "Sequences" },
  { key: "templates", label: "Templates" },
  { key: "campaigns", label: "Campaigns" },
  { key: "suppressions", label: "Opt-outs & suppressions" },
];

export default async function OutreachPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "queue";
  const L = await crmLookups();
  const canWrite = can(actor, "crm.write");
  const canSend = can(actor, "outreach.send");
  const integration = await sendingIntegration(db, "email");
  const [counts] = await db.select({ drafts: sql<number>`count(*) filter (where ${outreachMessages.status} in ('draft','approved'))`, blocked: sql<number>`count(*) filter (where ${outreachMessages.status} = 'blocked')` }).from(outreachMessages);
  const href = (t: string) => `/crm/outreach${qs({ tab: t === "queue" ? null : t })}`;
  const templateOpts = (await db.select({ id: outreachTemplates.id, name: outreachTemplates.name }).from(outreachTemplates).where(eq(outreachTemplates.active, true)).orderBy(outreachTemplates.name)).map((t) => ({ value: t.id, label: t.name }));
  const channelOpts = L.channels.length ? L.channels : [{ value: "email", label: "Email" }];

  return (
    <>
      <PageHeader crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Outreach & campaigns" }]} title="Outreach & campaigns" description="Sequences create drafts. People review, send from their own mailbox or LinkedIn, and record the send here. Replies are logged by people, never simulated." />
      <Notice tone={integration ? "success" : "info"} className="mb-4" title={integration ? "Verified email integration" : "Manual / draft mode"}>
        {integration
          ? `Email integration "${integration.displayName}" is connected and authorised for sending. Sending still requires approval by someone with outreach permission.`
          : "No email provider is connected and verified, so nothing is sent from this system. Copy each draft, send it yourself, then press “Mark sent manually” to log it on the timeline. LinkedIn steps are always manual."}
      </Notice>
      <Tabs current={tab} tabs={TABS.map((t) => ({ ...t, href: href(t.key), count: t.key === "queue" ? Number(counts.drafts) : null }))} />
      <div className="mt-4">
        {tab === "queue" ? <Queue canWrite={canWrite} canSend={canSend} blocked={Number(counts.blocked)} showAll={sp.show === "all"} /> : null}
        {tab === "sequences" ? <Sequences canWrite={canWrite} services={L.services} channels={channelOpts} templates={templateOpts} /> : null}
        {tab === "templates" ? <Templates canWrite={canWrite} services={L.services} channels={channelOpts} editId={sp.edit} channelLabel={L.channelLabel} /> : null}
        {tab === "campaigns" ? <Campaigns canWrite={canWrite} L={L} channels={channelOpts} /> : null}
        {tab === "suppressions" ? <Suppressions canLift={canSend} /> : null}
      </div>
    </>
  );
}

async function Queue({ canWrite, canSend, blocked, showAll }: { canWrite: boolean; canSend: boolean; blocked: number; showAll: boolean }) {
  const statuses = showAll ? (["draft", "approved", "blocked", "sent_manually", "sent", "cancelled"] as const) : (["draft", "approved", "blocked"] as const);
  const rows = await db
    .select({ m: outreachMessages, contactName: contacts.fullName, leadContactName: leadContacts.fullName, company: leads.companyName, seqName: sequences.name, stepNo: sequenceSteps.stepNumber })
    .from(outreachMessages)
    .leftJoin(contacts, eq(contacts.id, outreachMessages.contactId))
    .leftJoin(leadContacts, eq(leadContacts.id, outreachMessages.leadContactId))
    .leftJoin(leads, eq(leads.id, outreachMessages.leadId))
    .leftJoin(sequenceEnrollments, eq(sequenceEnrollments.id, outreachMessages.enrollmentId))
    .leftJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId))
    .leftJoin(sequenceSteps, eq(sequenceSteps.id, outreachMessages.stepId))
    .where(inArray(outreachMessages.status, [...statuses]))
    .orderBy(desc(outreachMessages.createdAt))
    .limit(60);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">{blocked ? `${blocked} draft(s) blocked by an opt-out or suppression. ` : ""}Drafts are generated when a sequence step is due (job runs hourly).</p>
        <div className="flex items-center gap-3">
          <Link className="text-[13px] text-accent hover:underline" href={`/crm/outreach${qs({ show: showAll ? null : "all" })}`}>{showAll ? "Show open drafts only" : "Show sent and cancelled too"}</Link>
          {canWrite ? (
            <ActionForm action={generateDraftsAction}>
              <SubmitButton variant="secondary" size="sm">Generate due drafts now</SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      </div>
      {rows.length ? (
        <div className="space-y-3">
          {rows.map(({ m, contactName, leadContactName, company, seqName, stepNo }) => {
            const open = m.status === "draft" || m.status === "approved";
            return (
              <Card key={m.id}>
                <CardHeader
                  title={<span className="flex flex-wrap items-center gap-2">{contactName ?? leadContactName ?? m.toAddress ?? "Unknown recipient"}{company ? <span className="text-[12.5px] font-normal text-muted">· {company}</span> : null}<Badge>{m.channel}</Badge><StatusBadge status={m.status} />{m.aiAssisted ? <Badge tone="info">AI-assisted draft</Badge> : null}</span>}
                  description={<>{seqName ? `${seqName} · step ${stepNo}` : "One-off draft"}{m.toAddress ? ` · to ${m.toAddress}` : ""}{m.sentAt ? <> · sent <DateTimeText value={m.sentAt} /></> : null}</>}
                  actions={<>{m.contactId ? <Link className="text-[12.5px] text-accent hover:underline" href={`/crm/contacts/${m.contactId}`}>Contact</Link> : m.leadId ? <Link className="text-[12.5px] text-accent hover:underline" href={`/crm/leads/${m.leadId}`}>Lead</Link> : null}</>}
                />
                <CardBody>
                  {m.status === "blocked" ? <Notice tone="warning" className="mb-3">Blocked: {m.blockedReason ?? "recipient is suppressed"}. This message cannot be sent.</Notice> : null}
                  {open && canWrite ? (
                    <ActionForm action={draftAction}>
                      <input type="hidden" name="id" value={m.id} />
                      {m.channel === "email" ? <Field label="Subject"><Input name="subject" defaultValue={m.subject ?? ""} /></Field> : null}
                      <Field label="Message" className="mt-2"><Textarea name="body" rows={6} defaultValue={m.body} /></Field>
                      {m.body.includes("[missing:") ? <p className="mt-1 text-[12px] text-warning">Fill in the [missing: …] placeholders before sending — the system will not guess them.</p> : null}
                      {canSend ? <Field label="Send note (optional)" className="mt-2"><Input name="note" placeholder="e.g. Sent from Gmail" /></Field> : null}
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        <SubmitButton variant="ghost" name="op" value="cancel" confirm="Cancel this draft?">Cancel draft</SubmitButton>
                        <SubmitButton variant="secondary" name="op" value="save">Save edits</SubmitButton>
                        {canSend ? <SubmitButton name="op" value="sent" confirm="Confirm you have sent this message yourself. It will be logged on the timeline.">Mark sent manually</SubmitButton> : <span className="self-center text-[12px] text-muted">Someone with outreach permission must record the send.</span>}
                      </div>
                    </ActionForm>
                  ) : (
                    <div className="whitespace-pre-wrap text-[13px] text-ink-2">{m.subject ? <p className="mb-1 font-medium">{m.subject}</p> : null}{m.body}</div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      ) : <Card><EmptyState title="No drafts waiting" description="Enroll contacts in a sequence from a contact or lead record. Drafts appear here when each step is due." /></Card>}
    </>
  );
}

async function Sequences({ canWrite, services: svc, channels, templates }: { canWrite: boolean; services: { value: string; label: string }[]; channels: { value: string; label: string }[]; templates: { value: string; label: string }[] }) {
  const rows = await db
    .select({ s: sequences, serviceName: services.name, steps: sql<number>`(select count(*) from sequence_steps st where st.sequence_id = ${sql.raw('"sequences"."id"')})`, active: sql<number>`(select count(*) from sequence_enrollments e where e.sequence_id = ${sql.raw('"sequences"."id"')} and e.status = 'active')`, replied: sql<number>`(select count(*) from sequence_enrollments e where e.sequence_id = ${sql.raw('"sequences"."id"')} and e.stopped_reason = 'replied')`, total: sql<number>`(select count(*) from sequence_enrollments e where e.sequence_id = ${sql.raw('"sequences"."id"')})` })
    .from(sequences)
    .leftJoin(services, eq(services.id, sequences.serviceId))
    .orderBy(asc(sequences.status), asc(sequences.name));
  return (
    <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader title="Sequences" description="Reply rate = enrollments stopped because a reply was logged ÷ all enrollments." />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Service</TH><TH align="right">Steps</TH><TH align="right">Active</TH><TH align="right">Replied</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ s, serviceName, steps, active, replied, total }) => (
                <TR key={s.id}>
                  <TD><Link className="font-medium hover:underline" href={`/crm/outreach/sequences/${s.id}`}>{s.name}</Link>{s.segment ? <div className="text-[12px] text-muted">{s.segment}</div> : null}</TD>
                  <TD>{serviceName ?? "—"}</TD>
                  <TD align="right">{Number(steps)}</TD>
                  <TD align="right">{Number(active)}</TD>
                  <TD align="right">{Number(replied)}/{Number(total)}</TD>
                  <TD><StatusBadge status={s.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No sequences yet" />}
      </Card>
      {canWrite ? (
        <Card>
          <CardHeader title="New sequence" />
          <CardBody><SequenceForm services={svc} channels={channels} templates={templates} /></CardBody>
        </Card>
      ) : null}
    </div>
  );
}

async function Templates({ canWrite, services: svc, channels, editId, channelLabel }: { canWrite: boolean; services: { value: string; label: string }[]; channels: { value: string; label: string }[]; editId?: string; channelLabel: (k: string | null) => string }) {
  const rows = await db.select({ t: outreachTemplates, serviceName: services.name }).from(outreachTemplates).leftJoin(services, eq(services.id, outreachTemplates.serviceId)).orderBy(asc(outreachTemplates.name));
  const editing = editId ? rows.find((r) => r.t.id === editId)?.t : undefined;
  return (
    <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader title="Message templates" />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Channel</TH><TH>Service / segment</TH><TH>Status</TH><TH /></tr></THead>
            <tbody>
              {rows.map(({ t, serviceName }) => (
                <TR key={t.id}>
                  <TD><span className="font-medium">{t.name}</span>{t.subject ? <div className="text-[12px] text-muted">{t.subject}</div> : null}</TD>
                  <TD>{channelLabel(t.channel)}</TD>
                  <TD>{serviceName ?? "Any"}{t.segment ? ` · ${t.segment}` : ""}</TD>
                  <TD>{t.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>}</TD>
                  <TD align="right">{canWrite ? <Link className="text-[12.5px] text-accent hover:underline" href={`/crm/outreach?tab=templates&edit=${t.id}`}>Edit</Link> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No templates yet" />}
      </Card>
      {canWrite ? (
        <Card>
          <CardHeader title={editing ? `Edit “${editing.name}”` : "New template"} actions={editing ? <Link className="text-[12.5px] text-accent hover:underline" href="/crm/outreach?tab=templates">New instead</Link> : null} />
          <CardBody><TemplateForm key={editing?.id ?? "new"} services={svc} channels={channels} t={editing} /></CardBody>
        </Card>
      ) : null}
    </div>
  );
}

async function Campaigns({ canWrite, L, channels }: { canWrite: boolean; L: Awaited<ReturnType<typeof crmLookups>>; channels: { value: string; label: string }[] }) {
  const rows = await db
    .select({ c: campaigns, ownerName: user.name, members: sql<number>`(select count(*) from ${campaignMembers} cm where cm.campaign_id = ${sql.raw('"campaigns"."id"')})`, leadsN: sql<number>`(select count(*) from leads l where l.campaign_id = ${sql.raw('"campaigns"."id"')} and l.status <> 'merged')`, opps: sql<number>`(select count(*) from opportunities o where o.campaign_id = ${sql.raw('"campaigns"."id"')})`, won: sql<number>`(select count(*) from opportunities o where o.campaign_id = ${sql.raw('"campaigns"."id"')} and o.status = 'won')` })
    .from(campaigns)
    .leftJoin(user, eq(user.id, campaigns.ownerId))
    .orderBy(desc(campaigns.startDate));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Campaigns" description="Leads and opportunities are attributed by the campaign recorded on them (first touch)." />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Campaign</TH><TH>Channel</TH><TH>Dates</TH><TH>Owner</TH><TH align="right">Members</TH><TH align="right">Leads</TH><TH align="right">Opps</TH><TH align="right">Won</TH><TH align="right">Cost</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ c, ownerName, members, leadsN, opps, won }) => (
                <TR key={c.id}>
                  <TD><Link className="font-medium hover:underline" href={`/crm/outreach/campaigns/${c.id}`}>{c.name}</Link>{c.targetSegment ? <div className="text-[12px] text-muted">{c.targetSegment}</div> : null}</TD>
                  <TD>{L.channelLabel(c.channel)}</TD>
                  <TD className="text-[12.5px]"><DateText value={c.startDate} /> – <DateText value={c.endDate} /></TD>
                  <TD>{ownerName ?? "—"}</TD>
                  <TD align="right">{Number(members)}</TD>
                  <TD align="right"><Link className="hover:underline" href={`/crm/leads?include=all&campaign=${c.id}`}>{Number(leadsN)}</Link></TD>
                  <TD align="right"><Link className="hover:underline" href={`/crm/opportunities?status=all&campaign=${c.id}`}>{Number(opps)}</Link></TD>
                  <TD align="right">{Number(won)}</TD>
                  <TD align="right">{c.cost ? <Money value={c.cost} currency={c.currency} /> : <span className="text-faint">not recorded</span>}</TD>
                  <TD><StatusBadge status={c.status} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No campaigns yet" />}
      </Card>
      {canWrite ? (
        <Card>
          <CardHeader title="New campaign" />
          <CardBody><CampaignForm services={L.services} offers={L.offers.map((o) => ({ value: o.id, label: o.name }))} users={L.users} channels={channels} /></CardBody>
        </Card>
      ) : null}
    </div>
  );
}

async function Suppressions({ canLift }: { canLift: boolean }) {
  const rows = await db
    .select({ s: suppressions, contactName: contacts.fullName, by: user.name })
    .from(suppressions)
    .leftJoin(contacts, eq(contacts.id, suppressions.contactId))
    .leftJoin(user, eq(user.id, suppressions.createdBy))
    .where(isNull(suppressions.liftedAt))
    .orderBy(desc(suppressions.createdAt))
    .limit(200);
  return (
    <Card>
      <CardHeader title="Active opt-outs and suppressions" description="Suppressed people are never enrolled or drafted. Record new opt-outs from the contact or lead record." />
      {rows.length ? (
        <Table>
          <THead><tr><TH>Who</TH><TH>Channel</TH><TH>Reason</TH><TH>Source</TH><TH>Recorded</TH>{canLift ? <TH>Lift (with reason)</TH> : null}</tr></THead>
          <tbody>
            {rows.map(({ s, contactName, by }) => (
              <TR key={s.id}>
                <TD>{s.contactId ? <Link className="hover:underline" href={`/crm/contacts/${s.contactId}`}>{contactName}</Link> : s.normalizedEmail ?? s.domain ?? "—"}{s.note ? <div className="text-[12px] text-muted">{s.note}</div> : null}</TD>
                <TD>{s.channel}</TD>
                <TD><Badge tone="danger">{s.reason.replace("_", " ")}</Badge></TD>
                <TD>{s.source}</TD>
                <TD className="text-[12.5px]"><DateTimeText value={s.createdAt} />{by ? <div className="text-muted">{by}</div> : null}</TD>
                {canLift ? (
                  <TD>
                    <ActionForm action={liftSuppressionAction} className="flex gap-2">
                      <input type="hidden" name="id" value={s.id} />
                      <Input name="note" aria-label="Reason for lifting" placeholder="Reason" required className="h-8 min-w-[140px]" />
                      <SubmitButton size="sm" variant="secondary" confirm="Lift this suppression? Only do this with documented consent.">Lift</SubmitButton>
                    </ActionForm>
                  </TD>
                ) : null}
              </TR>
            ))}
          </tbody>
        </Table>
      ) : <EmptyState title="No active suppressions" />}
    </Card>
  );
}

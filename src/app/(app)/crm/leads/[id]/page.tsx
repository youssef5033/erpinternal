import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { campaigns, leadContacts, leadEvidence, leadServiceFits, leadStatusHistory, leads, sequenceEnrollments, sequences, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { leadVisibility } from "@/server/auth/scope";
import { findLeadDuplicates, LEAD_TRANSITIONS } from "@/server/crm/leads";
import { suppressionFor } from "@/server/crm/outreach";
import { crmLookups } from "@/server/crm/lookups";
import { agencyToday } from "@/server/system/settings";
import { formatDate, formatDateTime } from "@/lib/dates";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, LinkButton, Notice, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { AuditPanel, TasksPanel, TimelinePanel, listUsers } from "@/components/records/panels";
import { enrollAction, leadContactAction, leadEvidenceAction, leadStatusAction, optOutAction } from "@/server/actions/crm";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.read");
  const { id } = await params;
  const [row] = await db.select({ l: leads, ownerName: user.name, campaignName: campaigns.name }).from(leads).leftJoin(user, eq(user.id, leads.ownerId)).leftJoin(campaigns, eq(campaigns.id, leads.campaignId)).where(and(eq(leads.id, id), leadVisibility(actor)));
  if (!row) notFound();
  const l = row.l;
  const [contactsRows, evidence, fits, history, L, users, today, seqs] = await Promise.all([
    db.select().from(leadContacts).where(eq(leadContacts.leadId, id)).orderBy(desc(leadContacts.isPrimary)),
    db.select({ e: leadEvidence, by: user.name }).from(leadEvidence).leftJoin(user, eq(user.id, leadEvidence.createdBy)).where(eq(leadEvidence.leadId, id)).orderBy(desc(leadEvidence.createdAt)),
    db.select({ f: leadServiceFits, s: services }).from(leadServiceFits).innerJoin(services, eq(services.id, leadServiceFits.serviceId)).where(eq(leadServiceFits.leadId, id)),
    db.select({ h: leadStatusHistory, by: user.name }).from(leadStatusHistory).leftJoin(user, eq(user.id, leadStatusHistory.changedBy)).where(eq(leadStatusHistory.leadId, id)).orderBy(desc(leadStatusHistory.changedAt)),
    crmLookups(),
    listUsers(),
    agencyToday(db),
    db.select().from(sequences).where(eq(sequences.status, "active")),
  ]);
  const dups = l.status === "merged" || l.status === "converted" ? [] : await findLeadDuplicates(db, { companyName: l.companyName, website: l.website, emails: contactsRows.map((c) => c.email) }, l.id);
  const suppressed = await Promise.all(contactsRows.map((c) => suppressionFor(db, { leadContactId: c.id, contactId: c.convertedContactId, email: c.email })));
  const enrollments = await db.select({ e: sequenceEnrollments, name: sequences.name }).from(sequenceEnrollments).innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId)).where(eq(sequenceEnrollments.leadId, id));
  const canWrite = can(actor, "crm.write") && l.status !== "merged" && l.status !== "converted";
  const due = l.nextActionDate ?? l.followUpDate;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Leads", href: "/crm/leads" }, { label: l.companyName }]}
        title={l.companyName}
        description={l.observedNeeds ?? undefined}
        meta={
          <>
            <StatusBadge status={l.status} />
            {fits.map(({ s }) => <Badge key={s.id} tone={s.key as "creative"}>{s.shortName}</Badge>)}
            <span className="text-[12.5px] text-muted">Owner: {row.ownerName ?? "Unassigned"}</span>
          </>
        }
        actions={
          canWrite ? (
            <>
              <LinkButton href={`/crm/leads/${id}/edit`}>Edit</LinkButton>
              {l.status !== "disqualified" ? <LinkButton href={`/crm/leads/${id}/convert`} variant="primary">Convert</LinkButton> : null}
            </>
          ) : null
        }
      />
      {l.status === "merged" ? <Notice tone="info" title="This lead was merged" className="mb-4">Its records now live on <Link className="underline" href={`/crm/leads/${l.mergedIntoId}`}>the surviving lead</Link>. This page is kept for history.</Notice> : null}
      {l.status === "converted" ? (
        <Notice tone="success" title="Converted" className="mb-4">
          Converted {l.convertedAt ? formatDate(l.convertedAt) : ""} to{" "}
          {l.convertedAccountId ? <Link className="underline" href={`/crm/accounts/${l.convertedAccountId}`}>the account</Link> : null}
          {l.convertedOpportunityId ? <> and <Link className="underline" href={`/crm/opportunities/${l.convertedOpportunityId}`}>an opportunity</Link></> : null}. Research history below is preserved and also visible on the account timeline.
        </Notice>
      ) : null}
      {dups.length ? (
        <Notice tone="warning" title={`${dups.length} possible duplicate${dups.length > 1 ? "s" : ""}`} className="mb-4">
          <ul className="mt-1 space-y-0.5">
            {dups.map((d) => (
              <li key={`${d.type}-${d.id}`}>
                <Link className="underline" href={d.type === "lead" ? `/crm/leads/${d.id}` : d.type === "account" ? `/crm/accounts/${d.id}` : `/crm/contacts/${d.id}`}>
                  {d.type}: {d.label}
                </Link>{" "}
                — {d.reason}
                {d.type === "lead" && can(actor, "crm.import") && canWrite ? (
                  <> · <Link className="font-medium underline" href={`/crm/leads/${id}/merge?target=${d.id}`}>Review merge</Link></>
                ) : null}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Profile" />
            <CardBody>
              <DefinitionList
                columns={3}
                items={[
                  { label: "Website", value: l.website ? <a className="text-accent hover:underline" href={l.website} target="_blank" rel="noopener noreferrer">{l.domain}</a> : null },
                  { label: "Industry", value: l.industry },
                  { label: "Geography", value: [l.country, l.region].filter(Boolean).join(", ") || null },
                  { label: "Company size", value: l.sizeBand },
                  { label: "Acquisition source", value: `${L.channelLabel(l.acquisitionChannel)}${l.acquisitionDetail ? ` — ${l.acquisitionDetail}` : ""}` },
                  { label: "Campaign", value: row.campaignName },
                  { label: "Date added", value: <DateText value={l.dateAdded} /> },
                  { label: "Estimated value", value: <Money value={l.estimatedValue} currency={l.currency} /> },
                  { label: "Last interaction", value: l.lastInteractionAt ? formatDateTime(l.lastInteractionAt) : null },
                  { label: "Next action", value: l.nextAction ? <>{l.nextAction} · <DateText value={due} overdue={!!due && due < today} /></> : null },
                  { label: "Tags", value: l.tags.length ? l.tags.map((t) => `#${t}`).join(" ") : null },
                  ...L.customFields.filter((cf) => cf.entityType === "lead").map((cf) => ({ label: cf.label, value: String((l.customFields as Record<string, string>)?.[cf.key] ?? "") || null })),
                  { label: "Research summary", value: l.researchNotes, full: true },
                ]}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Research & evidence" description="Notes, sources and observed needs. Preserved when the lead is converted." />
            {canWrite ? (
              <CardBody className="border-b border-line bg-[#fbfbf9]">
                <ActionForm action={leadEvidenceAction} resetOnSuccess className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <FormGrid cols={4}>
                    <Field label="Kind" htmlFor="ev-kind">
                      <Select id="ev-kind" name="kind" options={[{ value: "note", label: "Research note" }, { value: "source", label: "Source / evidence" }, { value: "need", label: "Observed need" }, { value: "signal", label: "Buying signal" }]} />
                    </Field>
                    <Field label="Source URL" htmlFor="ev-url" className="sm:col-span-3">
                      <Input id="ev-url" name="url" placeholder="https://" />
                    </Field>
                  </FormGrid>
                  <Field label="Content" htmlFor="ev-content">
                    <Textarea id="ev-content" name="content" rows={2} required />
                  </Field>
                  <SubmitButton size="sm">Add</SubmitButton>
                </ActionForm>
              </CardBody>
            ) : null}
            {evidence.length ? (
              <ul className="divide-y divide-line">
                {evidence.map(({ e, by }) => (
                  <li key={e.id} className="px-4 py-2.5 text-[13px]">
                    <div className="flex items-center gap-2">
                      <Badge tone={e.kind === "signal" ? "success" : e.kind === "need" ? "warning" : "neutral"}>{e.kind}</Badge>
                      <span className="text-[11.5px] text-muted">{by ?? "Import"} · {formatDate(e.createdAt)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-line text-ink-2">{e.content}</p>
                    {e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-accent hover:underline">{e.url}</a> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No research yet" />
            )}
          </Card>

          <TimelinePanel actor={actor} filter={{ leadId: id }} allowLog={canWrite} />
          <TasksPanel actor={actor} link={{ leadId: id }} users={users} />
        </div>

        <div className="space-y-4">
          {canWrite ? (
            <Card>
              <CardHeader title="Qualification" description="New → Researching → Qualified / Nurture / Disqualified." />
              <CardBody>
                <ActionForm action={leadStatusAction} className="space-y-2">
                  <input type="hidden" name="id" value={id} />
                  <Field label="Move to" htmlFor="lead-status">
                    <Select id="lead-status" name="status" options={LEAD_TRANSITIONS[l.status].map((s) => ({ value: s, label: s }))} />
                  </Field>
                  <Field label="Note / reason" htmlFor="lead-note" hint="Required when disqualifying.">
                    <Input id="lead-note" name="note" />
                  </Field>
                  <SubmitButton size="sm">Update status</SubmitButton>
                </ActionForm>
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Contacts" description="Public business details with sources." />
            <ul className="divide-y divide-line">
              {contactsRows.map((c, i) => (
                <li key={c.id} className="px-4 py-2.5 text-[13px]">
                  <p className="font-medium text-ink">
                    {c.fullName} {c.isPrimary ? <Badge>primary</Badge> : null} {suppressed[i] ? <Badge tone="danger" title={suppressed[i]!}>do not contact</Badge> : null}
                  </p>
                  <p className="text-[12px] text-muted">{c.jobTitle}</p>
                  <p className="text-[12px]">{[c.email, c.phone].filter(Boolean).join(" · ")}</p>
                  {c.linkedinUrl ? <a className="text-[12px] text-accent hover:underline" href={c.linkedinUrl} target="_blank" rel="noopener noreferrer">LinkedIn</a> : null}
                  {c.sourceUrl ? <p className="text-[11.5px] text-faint">Source: <a className="hover:underline" href={c.sourceUrl} target="_blank" rel="noopener noreferrer">{c.sourceUrl}</a></p> : null}
                  {c.convertedContactId ? <Link href={`/crm/contacts/${c.convertedContactId}`} className="text-[12px] text-accent hover:underline">Contact record →</Link> : null}
                  {canWrite && !suppressed[i] ? (
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {seqs.length ? (
                        <ActionForm action={enrollAction} className="flex gap-1">
                          <input type="hidden" name="leadContactId" value={c.id} />
                          <Select name="sequenceId" aria-label="Sequence" className="h-7 py-0 text-[12px]" options={seqs.map((s) => ({ value: s.id, label: s.name }))} />
                          <SubmitButton size="sm" variant="secondary">Enroll</SubmitButton>
                        </ActionForm>
                      ) : null}
                      <ActionForm action={optOutAction}>
                        <input type="hidden" name="leadContactId" value={c.id} />
                        <input type="hidden" name="note" value="Recorded from lead page" />
                        <SubmitButton size="sm" variant="ghost" confirm={`Record that ${c.fullName} opted out? Active sequences stop and future outreach is blocked.`}>Record opt-out</SubmitButton>
                      </ActionForm>
                    </div>
                  ) : null}
                </li>
              ))}
              {!contactsRows.length ? <li className="px-4 py-3 text-[13px] text-muted">No contacts yet.</li> : null}
            </ul>
            {canWrite ? (
              <CardBody className="border-t border-line">
                <details>
                  <summary className="cursor-pointer text-[13px] font-medium text-accent">Add contact</summary>
                  <ActionForm action={leadContactAction} resetOnSuccess className="mt-2 space-y-2">
                    <input type="hidden" name="id" value={id} />
                    <Input name="fullName" placeholder="Full name" aria-label="Full name" required />
                    <Input name="jobTitle" placeholder="Role / title" aria-label="Role" />
                    <Input name="email" type="email" placeholder="Business email" aria-label="Email" />
                    <Input name="phone" placeholder="Phone" aria-label="Phone" />
                    <Input name="linkedinUrl" placeholder="LinkedIn URL" aria-label="LinkedIn" />
                    <Input name="sourceUrl" placeholder="Source URL" aria-label="Source URL" />
                    <SubmitButton size="sm">Add contact</SubmitButton>
                  </ActionForm>
                </details>
              </CardBody>
            ) : null}
          </Card>

          {enrollments.length ? (
            <Card>
              <CardHeader title="Outreach sequences" />
              <ul className="divide-y divide-line">
                {enrollments.map(({ e, name }) => (
                  <li key={e.id} className="flex items-center justify-between px-4 py-2 text-[13px]">
                    <Link href={`/crm/outreach/sequences/${e.sequenceId}`} className="hover:underline">{name}</Link>
                    <span className="flex items-center gap-1"><StatusBadge status={e.status} />{e.stoppedReason ? <span className="text-[11.5px] text-muted">{e.stoppedReason.replace("_", " ")}</span> : null}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Qualification history" />
            <ol className="divide-y divide-line">
              {history.map(({ h, by }) => (
                <li key={h.id} className="px-4 py-2 text-[12.5px]">
                  <p>
                    {h.fromStatus ? <><StatusBadge status={h.fromStatus} /> → </> : null}
                    <StatusBadge status={h.toStatus} />
                  </p>
                  <p className="mt-0.5 text-muted">{by ?? "System"} · {formatDateTime(h.changedAt)}{h.note ? ` · ${h.note}` : ""}</p>
                </li>
              ))}
            </ol>
          </Card>
          <AuditPanel actor={actor} entityType="lead" entityId={id} />
        </div>
      </div>
    </>
  );
}

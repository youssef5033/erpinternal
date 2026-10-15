import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contactAccountLinks, contacts, opportunityContacts, opportunities, sequenceEnrollments, sequences, suppressions, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { assertAccountAccess } from "@/server/auth/scope";
import { suppressionFor } from "@/server/crm/outreach";
import { crmLookups } from "@/server/crm/lookups";
import { formatDate } from "@/lib/dates";
import { Badge, Card, CardBody, CardHeader, DefinitionList, LinkButton, Notice, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input, Select } from "@/components/forms/fields";
import { AuditPanel, TasksPanel, TimelinePanel, listUsers } from "@/components/records/panels";
import { archiveContactAction, enrollAction, liftSuppressionAction, linkContactAction, logReplyAction, optOutAction } from "@/server/actions/crm";
import { ForbiddenError } from "@/server/errors";
import { forbidden } from "next/navigation";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.read");
  const { id } = await params;
  const [row] = await db.select({ c: contacts, accountName: accounts.name, ownerName: user.name }).from(contacts).leftJoin(accounts, eq(accounts.id, contacts.primaryAccountId)).leftJoin(user, eq(user.id, contacts.ownerId)).where(eq(contacts.id, id));
  if (!row) notFound();
  const c = row.c;
  if (c.primaryAccountId) {
    try { await assertAccountAccess(db, actor, c.primaryAccountId); } catch (e) { if (e instanceof ForbiddenError) forbidden(); throw e; }
  }
  const [L, users, suppressed, sups, links, opps, enrs, seqs, accs] = await Promise.all([
    crmLookups(),
    listUsers(),
    suppressionFor(db, { contactId: id, email: c.email }),
    db.select().from(suppressions).where(and(eq(suppressions.contactId, id), isNull(suppressions.liftedAt))),
    db.select({ l: contactAccountLinks, name: accounts.name }).from(contactAccountLinks).innerJoin(accounts, eq(accounts.id, contactAccountLinks.accountId)).where(eq(contactAccountLinks.contactId, id)),
    db.select({ o: opportunities, role: opportunityContacts.role }).from(opportunityContacts).innerJoin(opportunities, eq(opportunities.id, opportunityContacts.opportunityId)).where(eq(opportunityContacts.contactId, id)).orderBy(desc(opportunities.createdAt)),
    db.select({ e: sequenceEnrollments, name: sequences.name }).from(sequenceEnrollments).innerJoin(sequences, eq(sequences.id, sequenceEnrollments.sequenceId)).where(eq(sequenceEnrollments.contactId, id)),
    db.select().from(sequences).where(eq(sequences.status, "active")),
    db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(isNull(accounts.archivedAt)).orderBy(accounts.name),
  ]);
  const canWrite = can(actor, "crm.write");
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Contacts", href: "/crm/contacts" }, { label: c.fullName }]}
        title={c.fullName}
        description={[c.jobTitle, row.accountName].filter(Boolean).join(" at ")}
        meta={<>{c.buyingRoles.map((r) => <Badge key={r} tone="accent">{L.contactRoles.find((x) => x.value === r)?.label ?? r}</Badge>)}{suppressed ? <Badge tone="danger">{suppressed}</Badge> : null}{c.archivedAt ? <Badge>archived</Badge> : null}</>}
        actions={canWrite ? <LinkButton href={`/crm/contacts/${id}/edit`} variant="primary">Edit</LinkButton> : null}
      />
      {suppressed ? <Notice tone="warning" title="Outreach is suppressed for this contact" className="mb-4">All sequences are stopped and new outreach is blocked. {c.optedOutAt ? `Opted out ${formatDate(c.optedOutAt)}.` : ""}</Notice> : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={3} items={[
                { label: "Primary account", value: c.primaryAccountId ? <Link className="text-accent hover:underline" href={`/crm/accounts/${c.primaryAccountId}`}>{row.accountName}</Link> : null },
                { label: "Email", value: c.email },
                { label: "Phone", value: c.phone },
                { label: "LinkedIn", value: c.linkedinUrl ? <a className="text-accent hover:underline" href={c.linkedinUrl} target="_blank" rel="noopener noreferrer">Profile</a> : null },
                { label: "Preferred channel", value: c.preferredChannel },
                { label: "Time zone", value: c.timeZone },
                { label: "Owner", value: row.ownerName },
                { label: "Restrictions", value: c.contactRestrictions },
                { label: "Source", value: c.sourceUrl },
                { label: "Relationship notes", value: c.relationshipNotes, full: true },
              ]} />
            </CardBody>
          </Card>
          <TimelinePanel actor={actor} filter={{ contactId: id }} />
          <TasksPanel actor={actor} link={{ contactId: id }} users={users} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Opportunities" />
            <ul className="divide-y divide-line">
              {opps.map(({ o, role }) => <li key={o.id} className="px-4 py-2 text-[13px]"><Link href={`/crm/opportunities/${o.id}`} className="hover:underline">{o.number} {o.name}</Link> <StatusBadge status={o.status} />{role ? <span className="text-muted"> · {role}</span> : null}</li>)}
              {!opps.length ? <li className="px-4 py-3 text-[13px] text-muted">None.</li> : null}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Additional accounts" />
            <CardBody className="space-y-2 text-[13px]">
              {links.map(({ l, name }) => <p key={l.accountId}><Link className="hover:underline" href={`/crm/accounts/${l.accountId}`}>{name}</Link>{l.relationship ? ` — ${l.relationship}` : ""}</p>)}
              {canWrite ? (
                <ActionForm action={linkContactAction} className="flex flex-wrap gap-1">
                  <input type="hidden" name="id" value={id} />
                  <Select name="accountId" aria-label="Account" className="h-8 w-44 py-0" options={accs.filter((a) => a.id !== c.primaryAccountId).map((a) => ({ value: a.id, label: a.name }))} />
                  <Input name="relationship" placeholder="Relationship" aria-label="Relationship" className="h-8 w-32 py-0" />
                  <SubmitButton size="sm" variant="secondary">Link</SubmitButton>
                </ActionForm>
              ) : null}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Outreach & consent" />
            <CardBody className="space-y-3 text-[13px]">
              {enrs.map(({ e, name }) => <p key={e.id}>{name}: <StatusBadge status={e.status} />{e.stoppedReason ? ` (${e.stoppedReason.replace("_", " ")})` : ""}</p>)}
              {canWrite && !suppressed && seqs.length ? (
                <ActionForm action={enrollAction} className="flex gap-1">
                  <input type="hidden" name="contactId" value={id} />
                  <Select name="sequenceId" aria-label="Sequence" className="h-8 py-0" options={seqs.map((s) => ({ value: s.id, label: s.name }))} />
                  <SubmitButton size="sm" variant="secondary">Enroll</SubmitButton>
                </ActionForm>
              ) : null}
              {canWrite ? (
                <details>
                  <summary className="cursor-pointer text-accent">Log a reply</summary>
                  <ActionForm action={logReplyAction} resetOnSuccess className="mt-2 space-y-2">
                    <input type="hidden" name="contactId" value={id} />
                    <Select name="channel" aria-label="Channel" options={[{ value: "email", label: "Email" }, { value: "linkedin", label: "LinkedIn" }, { value: "call", label: "Call" }, { value: "message", label: "Other message" }]} />
                    <Select name="sentiment" aria-label="Sentiment" options={[{ value: "positive", label: "Positive — interested" }, { value: "neutral", label: "Neutral" }, { value: "negative", label: "Negative" }, { value: "not_interested", label: "Not interested" }, { value: "opt_out", label: "Asked to opt out" }]} />
                    <Input name="body" placeholder="Summary of the reply" aria-label="Reply summary" />
                    <SubmitButton size="sm">Log reply</SubmitButton>
                  </ActionForm>
                </details>
              ) : null}
              {canWrite && !suppressed ? (
                <ActionForm action={optOutAction} className="space-y-2 border-t border-line pt-2">
                  <input type="hidden" name="contactId" value={id} />
                  <Field label="Record opt-out" htmlFor="oo-note"><Input id="oo-note" name="note" placeholder="How did they opt out?" required /></Field>
                  <SubmitButton size="sm" variant="danger" confirm="Stop all sequences and block future outreach to this contact?">Record opt-out</SubmitButton>
                </ActionForm>
              ) : null}
              {sups.map((s) => (
                <div key={s.id} className="rounded border border-line p-2 text-[12.5px]">
                  <p>Suppressed ({s.reason.replace("_", " ")}, {s.channel}) since {formatDate(s.createdAt)}{s.note ? ` — ${s.note}` : ""}</p>
                  {can(actor, "outreach.send") ? (
                    <ActionForm action={liftSuppressionAction} className="mt-1 flex gap-1">
                      <input type="hidden" name="id" value={s.id} />
                      <Input name="note" placeholder="Evidence of renewed consent" aria-label="Consent evidence" className="h-7 py-0" required />
                      <SubmitButton size="sm" variant="ghost">Lift</SubmitButton>
                    </ActionForm>
                  ) : null}
                </div>
              ))}
            </CardBody>
          </Card>
          {canWrite ? (
            <ActionForm action={archiveContactAction}>
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="archived" value={c.archivedAt ? "false" : "true"} />
              <SubmitButton size="sm" variant="ghost">{c.archivedAt ? "Restore contact" : "Archive contact"}</SubmitButton>
            </ActionForm>
          ) : null}
          <AuditPanel actor={actor} entityType="contact" entityId={id} />
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { contacts, accounts, leadContacts, leads, outreachTemplates, sequenceEnrollments, sequences, sequenceSteps } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { enrollAction, enrollmentStatusAction, sequenceStatusAction } from "@/server/actions/crm";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Select } from "@/components/forms/fields";
import { SequenceForm } from "@/components/crm/outreach-forms";

export const metadata = { title: "Sequence" };

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [seq] = await db.select().from(sequences).where(eq(sequences.id, id));
  if (!seq) notFound();
  const L = await crmLookups();
  const canWrite = can(actor, "crm.write");
  const steps = await db.select({ st: sequenceSteps, tpl: outreachTemplates.name }).from(sequenceSteps).leftJoin(outreachTemplates, eq(outreachTemplates.id, sequenceSteps.templateId)).where(eq(sequenceSteps.sequenceId, id)).orderBy(asc(sequenceSteps.stepNumber));
  const enrollments = await db
    .select({ e: sequenceEnrollments, contactName: contacts.fullName, leadContactName: leadContacts.fullName, company: leads.companyName })
    .from(sequenceEnrollments)
    .leftJoin(contacts, eq(contacts.id, sequenceEnrollments.contactId))
    .leftJoin(leadContacts, eq(leadContacts.id, sequenceEnrollments.leadContactId))
    .leftJoin(leads, eq(leads.id, sequenceEnrollments.leadId))
    .where(eq(sequenceEnrollments.sequenceId, id))
    .orderBy(desc(sequenceEnrollments.enrolledAt));
  const templates = (await db.select({ id: outreachTemplates.id, name: outreachTemplates.name }).from(outreachTemplates).orderBy(outreachTemplates.name)).map((t) => ({ value: t.id, label: t.name }));
  const contactOpts = canWrite
    ? (await db.select({ id: contacts.id, name: contacts.fullName, account: accounts.name }).from(contacts).leftJoin(accounts, eq(accounts.id, contacts.primaryAccountId)).where(and(isNull(contacts.archivedAt), eq(contacts.doNotContact, false), accountVisibility(actor))).orderBy(contacts.fullName).limit(500)).map((c) => ({ value: c.id, label: c.account ? `${c.name} — ${c.account}` : c.name }))
    : [];
  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Outreach", href: "/crm/outreach?tab=sequences" }, { label: seq.name }]}
        title={seq.name}
        meta={<StatusBadge status={seq.status} />}
        description={seq.description ?? undefined}
        actions={canWrite ? (
          <ActionForm action={sequenceStatusAction} className="flex gap-2" hideSuccess>
            <input type="hidden" name="id" value={seq.id} />
            {seq.status !== "active" ? <SubmitButton variant="secondary" name="status" value="active">Activate</SubmitButton> : <SubmitButton variant="secondary" name="status" value="paused">Pause</SubmitButton>}
            {seq.status !== "archived" ? <SubmitButton variant="ghost" name="status" value="archived" confirm="Archive this sequence? Active enrollments stop receiving drafts.">Archive</SubmitButton> : null}
          </ActionForm>
        ) : null}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Steps" />
          {steps.length ? (
            <Table>
              <THead><tr><TH>#</TH><TH>After</TH><TH>Channel</TH><TH>Template / instructions</TH></tr></THead>
              <tbody>
                {steps.map(({ st, tpl }) => (
                  <TR key={st.id}><TD>{st.stepNumber}</TD><TD>{st.dayOffset} day(s)</TD><TD>{L.channelLabel(st.channel)}</TD><TD>{tpl ?? <span className="text-muted">No template</span>}{st.instructions ? <div className="text-[12px] text-muted">{st.instructions}</div> : null}</TD></TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No steps" />}
        </Card>
        {canWrite ? (
          <Card>
            <CardHeader title="Enroll a contact" description="Opted-out and suppressed people cannot be enrolled. Leads are enrolled from the lead record." />
            <CardBody>
              <ActionForm action={enrollAction} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="sequenceId" value={seq.id} />
                <Field label="Contact" className="min-w-[260px] flex-1"><Select name="contactId" options={contactOpts} placeholder="Choose a contact" required /></Field>
                <SubmitButton>Enroll</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        ) : null}
      </div>
      <Card className="mt-4">
        <CardHeader title="Enrollments" description="A logged reply or opt-out stops the enrollment automatically." />
        {enrollments.length ? (
          <Table>
            <THead><tr><TH>Recipient</TH><TH>Step</TH><TH>Next due</TH><TH>Status</TH><TH>Enrolled</TH>{canWrite ? <TH /> : null}</tr></THead>
            <tbody>
              {enrollments.map(({ e, contactName, leadContactName, company }) => (
                <TR key={e.id}>
                  <TD>{e.contactId ? <Link className="hover:underline" href={`/crm/contacts/${e.contactId}`}>{contactName}</Link> : e.leadId ? <Link className="hover:underline" href={`/crm/leads/${e.leadId}`}>{leadContactName} · {company}</Link> : "—"}</TD>
                  <TD>{e.currentStep}</TD>
                  <TD>{e.nextDueAt ? <DateTimeText value={e.nextDueAt} /> : e.status === "active" ? <span className="text-muted">awaiting send of current draft</span> : "—"}</TD>
                  <TD><StatusBadge status={e.status} />{e.stoppedReason ? <span className="ml-1 text-[12px] text-muted">({e.stoppedReason})</span> : null}</TD>
                  <TD><DateTimeText value={e.enrolledAt} /></TD>
                  {canWrite ? (
                    <TD align="right">
                      {e.status === "active" || e.status === "paused" ? (
                        <ActionForm action={enrollmentStatusAction} className="flex justify-end gap-1" hideSuccess>
                          <input type="hidden" name="id" value={e.id} />
                          {e.status === "active" ? <SubmitButton size="sm" variant="ghost" name="status" value="paused">Pause</SubmitButton> : <SubmitButton size="sm" variant="ghost" name="status" value="active">Resume</SubmitButton>}
                          <SubmitButton size="sm" variant="ghost" name="status" value="stopped">Stop</SubmitButton>
                        </ActionForm>
                      ) : null}
                    </TD>
                  ) : null}
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="Nobody enrolled yet" />}
      </Card>
      {canWrite && enrollments.length ? <p className="mt-4 text-[12.5px] text-muted">Steps are locked because people have been enrolled — create a new sequence to change the cadence, so existing recipients are not affected.</p> : null}
      {canWrite && !enrollments.length ? (
        <Card className="mt-4">
          <CardHeader title="Edit sequence" />
          <CardBody>
            <SequenceForm services={L.services} channels={L.channels} templates={templates} s={{ id: seq.id, name: seq.name, serviceId: seq.serviceId, segment: seq.segment, description: seq.description, steps: steps.map(({ st }) => ({ dayOffset: st.dayOffset, channel: st.channel, templateId: st.templateId, instructions: st.instructions })) }} />
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

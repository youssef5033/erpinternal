import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, engagements, eventAttendees, events, leads, opportunities, tasks, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { eventVisibility } from "@/server/auth/scope";
import { completeEventAction } from "@/server/actions/crm";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO } from "@/lib/dates";
import { Badge, Card, CardBody, CardHeader, DefinitionList, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { DateText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { EventForm, EVENT_KINDS } from "@/components/calendar/event-form";
import { eventLookups } from "@/components/calendar/lookups";

export const metadata = { title: "Event" };

function wall(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("operations.view");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db
    .select({ e: events, accountName: accounts.name, contactName: contacts.fullName, leadName: leads.companyName, oppName: opportunities.name, engName: engagements.name, organizer: user.name })
    .from(events)
    .leftJoin(accounts, eq(accounts.id, events.accountId))
    .leftJoin(contacts, eq(contacts.id, events.contactId))
    .leftJoin(leads, eq(leads.id, events.leadId))
    .leftJoin(opportunities, eq(opportunities.id, events.opportunityId))
    .leftJoin(engagements, eq(engagements.id, events.engagementId))
    .leftJoin(user, eq(user.id, events.organizerId))
    .where(and(eq(events.id, id), eventVisibility(actor)));
  if (!row) notFound();
  const e = row.e;
  const attendees = await db.select({ a: eventAttendees, userName: user.name, contactName: contacts.fullName }).from(eventAttendees).leftJoin(user, eq(user.id, eventAttendees.userId)).leftJoin(contacts, eq(contacts.id, eventAttendees.contactId)).where(eq(eventAttendees.eventId, id));
  const followUps = await db.select({ t: tasks, ownerName: user.name }).from(tasks).leftJoin(user, eq(user.id, tasks.ownerId)).where(eq(tasks.eventId, id));
  const canEdit = can(actor, "crm.write") || can(actor, "delivery.write");
  const today = await agencyToday(db);
  const L = canEdit ? await eventLookups(actor) : null;
  const tz = e.timeZone;
  const start = wall(e.startsAt, tz);
  const end = wall(e.endsAt, tz);
  const viewerTz = actor.timeZone;
  return (
    <>
      <PageHeader
        crumbs={[{ label: "Operations", href: "/operations" }, { label: "Agency calendar", href: `/operations/calendar?view=week&date=${start.date}` }, { label: e.title }]}
        title={e.title}
        meta={<><StatusBadge status={e.status} /><Badge>{EVENT_KINDS.find((k) => k.value === e.kind)?.label ?? e.kind}</Badge></>}
        description={`${start.date} ${start.time}–${end.time} (${tz})${viewerTz && viewerTz !== tz ? ` · ${(() => { const s = wall(e.startsAt, viewerTz); return `${s.date} ${s.time} your time (${viewerTz})`; })()}` : ""}`}
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <DefinitionList
              items={[
                { label: "Organiser", value: row.organizer ?? "—" },
                { label: "Location", value: e.location ?? "—" },
                { label: "Account", value: e.accountId ? <Link className="hover:underline" href={`/crm/accounts/${e.accountId}`}>{row.accountName}</Link> : "—" },
                { label: "Contact", value: e.contactId ? <Link className="hover:underline" href={`/crm/contacts/${e.contactId}`}>{row.contactName}</Link> : "—" },
                { label: "Opportunity", value: e.opportunityId ? <Link className="hover:underline" href={`/crm/opportunities/${e.opportunityId}`}>{row.oppName}</Link> : "—" },
                { label: "Lead", value: e.leadId ? <Link className="hover:underline" href={`/crm/leads/${e.leadId}`}>{row.leadName}</Link> : "—" },
                { label: "Engagement", value: e.engagementId ? <Link className="hover:underline" href={`/delivery/engagements/${e.engagementId}`}>{row.engName}</Link> : "—" },
                { label: "Reminder", value: e.reminderMinutes ? `${e.reminderMinutes} min before (in-app)` : "None" },
                { label: "Attendees", value: attendees.length ? attendees.map((a) => a.userName ?? a.contactName).filter(Boolean).join(", ") : "—", full: true },
                { label: "Agenda", value: e.agenda ? <span className="whitespace-pre-wrap">{e.agenda}</span> : "—", full: true },
                { label: "Calendar sync", value: e.syncStatus === "local_only" ? "Agency calendar only (not synced to an external calendar)" : e.syncStatus, full: true },
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={e.status === "scheduled" ? "Record outcome" : "Outcome"} description={e.status === "scheduled" ? "Notes and decisions are logged on the linked records' timelines. Follow-ups become tasks with owners and due dates." : undefined} />
          <CardBody>
            {e.status !== "scheduled" ? (
              <DefinitionList columns={1} items={[{ label: "Outcome", value: e.outcome ?? e.status }, { label: "Notes", value: <span className="whitespace-pre-wrap">{e.notes ?? "—"}</span> }, { label: "Decisions", value: <span className="whitespace-pre-wrap">{e.decisions ?? "—"}</span> }]} />
            ) : canEdit ? (
              <ActionForm action={completeEventAction}>
                <input type="hidden" name="id" value={e.id} />
                <FormGrid cols={2}>
                  <Field label="Status"><Select name="status" options={[{ value: "completed", label: "Held" }, { value: "no_show", label: "No-show" }, { value: "cancelled", label: "Cancelled" }]} /></Field>
                  <Field label="Outcome"><Input name="outcome" placeholder="e.g. Agreed to receive a proposal" /></Field>
                </FormGrid>
                <Field label="Notes" className="mt-3"><Textarea name="notes" rows={4} /></Field>
                <Field label="Decisions" className="mt-3"><Textarea name="decisions" rows={2} /></Field>
                <p className="mt-3 text-[12.5px] font-medium">Follow-ups</p>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="mt-1 grid gap-2 sm:grid-cols-[1fr_160px_150px]">
                    <Input name={`followUps.${i}.title`} aria-label={`Follow-up ${i + 1}`} placeholder="Follow-up task" />
                    <Select name={`followUps.${i}.ownerId`} aria-label={`Follow-up ${i + 1} owner`} options={L!.users} defaultValue={actor.userId} />
                    <Input name={`followUps.${i}.dueDate`} aria-label={`Follow-up ${i + 1} due`} type="date" defaultValue={addDaysISO(today, 2)} />
                  </div>
                ))}
                <div className="mt-3 flex justify-end"><SubmitButton>Save outcome</SubmitButton></div>
              </ActionForm>
            ) : <p className="text-[13px] text-muted">Not recorded yet.</p>}
            {followUps.length ? (
              <ul className="mt-4 space-y-1 border-t border-line pt-3 text-[13px]">
                {followUps.map(({ t, ownerName }) => <li key={t.id} className="flex justify-between gap-2"><Link className="hover:underline" href={`/people/tasks/${t.id}`}>{t.title}</Link><span className="text-muted">{ownerName} · <DateText value={t.dueDate} /> · <StatusBadge status={t.status} /></span></li>)}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      </div>
      {canEdit && e.status === "scheduled" && L ? (
        <Card className="mt-4">
          <CardHeader title="Reschedule or edit" />
          <CardBody>
            <EventForm users={L.users} accounts={L.accounts} engagements={L.engagements} defaults={{ date: start.date, timeZone: tz }} event={{ id: e.id, kind: e.kind, title: e.title, date: start.date, startTime: start.time, durationMinutes: Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60000), timeZone: tz, location: e.location, agenda: e.agenda, accountId: e.accountId, engagementId: e.engagementId, opportunityId: e.opportunityId, leadId: e.leadId, contactId: e.contactId, reminderMinutes: e.reminderMinutes, attendeeUserIds: attendees.map((a) => a.a.userId).filter((x): x is string => !!x) }} />
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

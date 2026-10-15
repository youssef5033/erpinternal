import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";
import { scheduleEventAction, updateEventAction } from "@/server/actions/crm";

type Opt = { value: string; label: string };

export const EVENT_KINDS: Opt[] = [
  { value: "meeting", label: "Meeting" },
  { value: "call", label: "Call" },
  { value: "discovery", label: "Discovery call" },
  { value: "account_review", label: "Account review" },
  { value: "workshop", label: "Workshop" },
  { value: "internal", label: "Internal" },
];

export function EventForm({
  users,
  accounts,
  engagements,
  defaults,
  event,
}: {
  users: Opt[];
  accounts: Opt[];
  engagements: Opt[];
  defaults: { date: string; startTime?: string; timeZone: string; accountId?: string; engagementId?: string; opportunityId?: string; leadId?: string; contactId?: string; kind?: string };
  event?: { id: string; kind: string; title: string; date: string; startTime: string; durationMinutes: number; timeZone: string; location: string | null; agenda: string | null; accountId: string | null; engagementId: string | null; opportunityId: string | null; leadId: string | null; contactId: string | null; reminderMinutes: number | null; attendeeUserIds: string[] };
}) {
  const v = event;
  return (
    <ActionForm action={v ? updateEventAction : scheduleEventAction}>
      {v ? <input type="hidden" name="id" value={v.id} /> : null}
      {(v?.opportunityId ?? defaults.opportunityId) ? <input type="hidden" name="opportunityId" value={v?.opportunityId ?? defaults.opportunityId} /> : null}
      {(v?.leadId ?? defaults.leadId) ? <input type="hidden" name="leadId" value={v?.leadId ?? defaults.leadId} /> : null}
      {(v?.contactId ?? defaults.contactId) ? <input type="hidden" name="contactId" value={v?.contactId ?? defaults.contactId} /> : null}
      <FormGrid cols={3}>
        <Field label="Type"><Select name="kind" options={EVENT_KINDS} defaultValue={v?.kind ?? defaults.kind ?? "meeting"} disabled={!!v} /></Field>
        {v ? <input type="hidden" name="kind" value={v.kind} /> : null}
        <Field label="Title" required className="sm:col-span-2"><Input name="title" defaultValue={v?.title} required /></Field>
        <Field label="Date" required><Input type="date" name="date" defaultValue={v?.date ?? defaults.date} required /></Field>
        <Field label="Start time" required><Input type="time" name="startTime" defaultValue={v?.startTime ?? defaults.startTime ?? "10:00"} required /></Field>
        <Field label="Duration (minutes)" required><Input type="number" min={5} step={5} name="durationMinutes" defaultValue={v?.durationMinutes ?? 45} required /></Field>
        <Field label="Time zone" hint="IANA name, e.g. Europe/London"><Input name="timeZone" defaultValue={v?.timeZone ?? defaults.timeZone} required /></Field>
        <Field label="Location / link"><Input name="location" defaultValue={v?.location ?? ""} /></Field>
        <Field label="Reminder (minutes before)"><Input type="number" min={0} name="reminderMinutes" defaultValue={v?.reminderMinutes ?? 15} /></Field>
        <Field label="Account"><Select name="accountId" options={accounts} placeholder="—" defaultValue={v?.accountId ?? defaults.accountId ?? ""} disabled={!!v} /></Field>
        <Field label="Engagement"><Select name="engagementId" options={engagements} placeholder="—" defaultValue={v?.engagementId ?? defaults.engagementId ?? ""} disabled={!!v} /></Field>
      </FormGrid>
      {v?.accountId ? <input type="hidden" name="accountId" value={v.accountId} /> : null}
      {v?.engagementId ? <input type="hidden" name="engagementId" value={v.engagementId} /> : null}
      <Field label="Agenda" className="mt-3"><Textarea name="agenda" rows={3} defaultValue={v?.agenda ?? ""} /></Field>
      {!v ? (
        <fieldset className="mt-3">
          <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Internal attendees (you are added automatically)</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {users.map((u) => (
              <label key={u.value} className="flex items-center gap-1.5 text-[13px]">
                <input type="checkbox" name="attendeeUserIds[]" value={u.value} className="h-4 w-4 accent-[var(--color-accent)]" />
                {u.label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <p className="mt-3 text-[12px] text-muted">Events are stored in the agency calendar only — calendar sync is not part of this version, so no invitations are sent. Send invites from your own calendar if needed.</p>
      <div className="mt-3 flex justify-end"><SubmitButton>{v ? "Save changes" : "Schedule"}</SubmitButton></div>
    </ActionForm>
  );
}

import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select, Textarea, Checkbox, CURRENCIES } from "@/components/forms/fields";
import { saveCampaignAction, saveSequenceAction, saveTemplateAction } from "@/server/actions/crm";

type Opt = { value: string; label: string };

export function TemplateForm({ services, channels, t }: { services: Opt[]; channels: Opt[]; t?: { id: string; name: string; serviceId: string | null; segment: string | null; channel: string; subject: string | null; body: string; active: boolean } }) {
  return (
    <ActionForm action={saveTemplateAction} resetOnSuccess={!t}>
      {t ? <input type="hidden" name="id" value={t.id} /> : null}
      <FormGrid cols={2}>
        <Field label="Name" required><Input name="name" defaultValue={t?.name} required /></Field>
        <Field label="Channel" required><Select name="channel" options={channels} defaultValue={t?.channel ?? "email"} /></Field>
        <Field label="Service"><Select name="serviceId" options={services} placeholder="Any service" defaultValue={t?.serviceId ?? ""} /></Field>
        <Field label="Segment"><Input name="segment" defaultValue={t?.segment ?? ""} placeholder="e.g. Hospitality CMOs" /></Field>
      </FormGrid>
      <Field label="Subject" className="mt-3"><Input name="subject" defaultValue={t?.subject ?? ""} /></Field>
      <Field label="Body" required className="mt-3" hint={<>Merge fields: {"{{first_name}}"}, {"{{full_name}}"}, {"{{company}}"}, {"{{sender_name}}"}. A missing value is shown as [missing: field] so it is never silently invented.</>}>
        <Textarea name="body" rows={7} defaultValue={t?.body} required />
      </Field>
      <div className="mt-3 flex items-center justify-between">
        <Checkbox name="active" label="Active" defaultChecked={t?.active ?? true} />
        <SubmitButton>{t ? "Save template" : "Create template"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function SequenceForm({ services, channels, templates, s }: { services: Opt[]; channels: Opt[]; templates: Opt[]; s?: { id: string; name: string; serviceId: string | null; segment: string | null; description: string | null; steps: { dayOffset: number; channel: string; templateId: string | null; instructions: string | null }[] } }) {
  const rows = Math.max(5, (s?.steps.length ?? 0) + 2);
  return (
    <ActionForm action={saveSequenceAction}>
      {s ? <input type="hidden" name="id" value={s.id} /> : null}
      <FormGrid cols={3}>
        <Field label="Name" required><Input name="name" defaultValue={s?.name} required /></Field>
        <Field label="Service"><Select name="serviceId" options={services} placeholder="Any service" defaultValue={s?.serviceId ?? ""} /></Field>
        <Field label="Segment"><Input name="segment" defaultValue={s?.segment ?? ""} /></Field>
      </FormGrid>
      <Field label="Description" className="mt-3"><Textarea name="description" rows={2} defaultValue={s?.description ?? ""} /></Field>
      <p className="mt-4 text-[13px] font-medium">Steps</p>
      <p className="mb-2 text-[12px] text-muted">Day offsets count from the previous step. Leave the channel empty to drop a row. Each step produces a draft for a person to review and send — nothing is sent automatically.</p>
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => {
          const st = s?.steps[i];
          return (
            <div key={i} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[80px_140px_1fr_1.4fr]">
              <Input aria-label={`Step ${i + 1} day offset`} name={`steps.${i}.dayOffset`} type="number" min={0} defaultValue={st?.dayOffset ?? (i === 0 ? 0 : 3)} />
              <Select aria-label={`Step ${i + 1} channel`} name={`steps.${i}.channel`} options={channels} placeholder="— none —" defaultValue={st?.channel ?? ""} />
              <Select aria-label={`Step ${i + 1} template`} name={`steps.${i}.templateId`} options={templates} placeholder="No template" defaultValue={st?.templateId ?? ""} />
              <Input aria-label={`Step ${i + 1} instructions`} name={`steps.${i}.instructions`} placeholder="Instructions for the person doing this step" defaultValue={st?.instructions ?? ""} />
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end"><SubmitButton>{s ? "Save sequence" : "Create sequence"}</SubmitButton></div>
    </ActionForm>
  );
}

export function CampaignForm({ services, offers, users, channels, c }: { services: Opt[]; offers: Opt[]; users: Opt[]; channels: Opt[]; c?: { id: string; name: string; channel: string; targetSegment: string | null; serviceId: string | null; offerId: string | null; ownerId: string | null; startDate: string | null; endDate: string | null; cost: string | null; currency: string | null; status: string; goal: string | null; outcomeNotes: string | null } }) {
  return (
    <ActionForm action={saveCampaignAction}>
      {c ? <input type="hidden" name="id" value={c.id} /> : null}
      <FormGrid cols={3}>
        <Field label="Name" required><Input name="name" defaultValue={c?.name} required /></Field>
        <Field label="Channel" required><Select name="channel" options={channels} defaultValue={c?.channel ?? ""} placeholder="Choose" required /></Field>
        <Field label="Status"><Select name="status" options={["planned", "active", "paused", "completed", "cancelled"].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} defaultValue={c?.status ?? "planned"} /></Field>
        <Field label="Service"><Select name="serviceId" options={services} placeholder="—" defaultValue={c?.serviceId ?? ""} /></Field>
        <Field label="Offer"><Select name="offerId" options={offers} placeholder="—" defaultValue={c?.offerId ?? ""} /></Field>
        <Field label="Owner"><Select name="ownerId" options={users} placeholder="—" defaultValue={c?.ownerId ?? ""} /></Field>
        <Field label="Start"><Input type="date" name="startDate" defaultValue={c?.startDate ?? ""} /></Field>
        <Field label="End"><Input type="date" name="endDate" defaultValue={c?.endDate ?? ""} /></Field>
        <Field label="Target segment"><Input name="targetSegment" defaultValue={c?.targetSegment ?? ""} /></Field>
        <Field label="Recorded cost" hint="Leave empty if unknown — cost per win is only shown where a cost is recorded."><Input name="cost" inputMode="decimal" defaultValue={c?.cost ?? ""} /></Field>
        <Field label="Cost currency"><Select name="currency" options={CURRENCIES} placeholder="—" defaultValue={c?.currency ?? ""} /></Field>
        <Field label="Goal"><Input name="goal" defaultValue={c?.goal ?? ""} /></Field>
      </FormGrid>
      <Field label="Outcome notes" className="mt-3"><Textarea name="outcomeNotes" rows={3} defaultValue={c?.outcomeNotes ?? ""} /></Field>
      <div className="mt-3 flex justify-end"><SubmitButton>{c ? "Save campaign" : "Create campaign"}</SubmitButton></div>
    </ActionForm>
  );
}

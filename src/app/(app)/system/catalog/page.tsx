import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { channels, contactRoleDefinitions, lookupValues, offers, services } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { saveListItemAction, saveOfferAction, saveServiceAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, PageHeader, ServiceBadge } from "@/components/ui/primitives";
import { Money, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, CURRENCIES, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";

export const metadata = { title: "Services & offers" };

const LISTS = [
  { key: "lost_reason", label: "Lost reasons" },
  { key: "industry", label: "Industries" },
  { key: "size_band", label: "Company size bands" },
];

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("system.settings");
  const sp = await searchParams;
  const tab = ["services", "offers", "lists"].includes(sp.tab ?? "") ? sp.tab! : "services";
  const svcs = await db.select().from(services).orderBy(asc(services.sortOrder));
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Services & offers" }]} title="Services & offers" description="The three service streams, packaged offers under them, and the lists used across CRM. Deactivating hides an item from new records but keeps history intact." />
      <Tabs current={tab} tabs={[{ key: "services", label: "Service streams", href: "/system/catalog" }, { key: "offers", label: "Offers", href: "/system/catalog?tab=offers" }, { key: "lists", label: "Channels, roles & lists", href: "/system/catalog?tab=lists" }]} />
      <div className="mt-4 space-y-4">
        {tab === "services" ? svcs.map((s) => (
          <Card key={s.id}>
            <CardHeader title={<ServiceBadge serviceKey={s.key} name={s.name} />} description={`Key "${s.key}" · workspace template: ${s.templateKind}`} />
            <CardBody>
              <ActionForm action={saveServiceAction}>
                <input type="hidden" name="id" value={s.id} />
                <FormGrid cols={3}>
                  <Field label="Name"><Input name="name" defaultValue={s.name} required /></Field>
                  <Field label="Short name"><Input name="shortName" defaultValue={s.shortName} required /></Field>
                  <Field label="Colour"><Input name="color" defaultValue={s.color} pattern="#[0-9a-fA-F]{6}" /></Field>
                </FormGrid>
                <Field label="Description" className="mt-2"><Textarea name="description" rows={2} defaultValue={s.description ?? ""} /></Field>
                <div className="mt-2 flex items-center justify-between"><Checkbox name="active" label="Active" defaultChecked={s.active} /><SubmitButton size="sm">Save</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
        )) : null}
        {tab === "offers" ? <Offers svcs={svcs} /> : null}
        {tab === "lists" ? <Lists /> : null}
      </div>
    </>
  );
}

async function Offers({ svcs }: { svcs: (typeof services.$inferSelect)[] }) {
  const rows = await db.select().from(offers).orderBy(asc(offers.name));
  const svcOpts = svcs.map((s) => ({ value: s.id, label: s.name }));
  const Form = ({ o }: { o?: typeof offers.$inferSelect }) => (
    <ActionForm action={saveOfferAction} resetOnSuccess={!o}>
      {o ? <input type="hidden" name="id" value={o.id} /> : null}
      <FormGrid cols={4}>
        <Field label="Name"><Input name="name" defaultValue={o?.name} required /></Field>
        <Field label="Service"><Select name="serviceId" options={svcOpts} defaultValue={o?.serviceId} /></Field>
        <Field label="Pricing model"><Select name="pricingModel" options={[{ value: "fixed", label: "Fixed fee" }, { value: "retainer", label: "Retainer" }, { value: "milestone", label: "Milestones" }, { value: "hourly", label: "Hourly" }]} defaultValue={o?.pricingModel ?? "fixed"} /></Field>
        <Field label="Default price"><Input name="defaultPrice" inputMode="decimal" defaultValue={o?.defaultPrice ?? ""} /></Field>
        <Field label="Currency"><Select name="currency" options={CURRENCIES} placeholder="—" defaultValue={o?.currency ?? ""} /></Field>
        <Field label="Typical duration (weeks)"><Input type="number" min={0} name="defaultDurationWeeks" defaultValue={o?.defaultDurationWeeks ?? ""} /></Field>
        <Field label="Included revisions"><Input type="number" min={0} name="includedRevisions" defaultValue={o?.includedRevisions ?? ""} /></Field>
        <div className="self-end pb-2"><Checkbox name="active" label="Active" defaultChecked={o?.active ?? true} /></div>
      </FormGrid>
      <FormGrid cols={2} className="mt-2">
        <Field label="Description"><Textarea name="description" rows={2} defaultValue={o?.description ?? ""} /></Field>
        <Field label="Standard deliverables (one per line)"><Textarea name="deliverablesText" rows={2} defaultValue={(o?.deliverableTemplate ?? []).map((x) => x.name).join("\n")} /></Field>
      </FormGrid>
      <div className="mt-2 flex justify-end"><SubmitButton size="sm">{o ? "Save offer" : "Add offer"}</SubmitButton></div>
    </ActionForm>
  );
  return (
    <>
      {rows.map((o) => {
        const svc = svcs.find((s) => s.id === o.serviceId);
        return (
          <Card key={o.id}>
            <CardHeader title={<span className="flex items-center gap-2">{o.name}{svc ? <ServiceBadge serviceKey={svc.key} name={svc.shortName} /> : null}{!o.active ? <Badge>inactive</Badge> : null}</span>} description={<>{o.pricingModel} · {o.defaultPrice ? <Money value={o.defaultPrice} currency={o.currency} /> : "no default price"}</>} />
            <CardBody><details><summary className="cursor-pointer text-[13px] text-accent">Edit</summary><div className="mt-2"><Form o={o} /></div></details></CardBody>
          </Card>
        );
      })}
      <Card><CardHeader title="New offer" /><CardBody><Form /></CardBody></Card>
    </>
  );
}

async function Lists() {
  const ch = await db.select().from(channels).orderBy(asc(channels.sortOrder));
  const roles = await db.select().from(contactRoleDefinitions).orderBy(asc(contactRoleDefinitions.sortOrder));
  const lookups = await db.select().from(lookupValues).orderBy(asc(lookupValues.listKey), asc(lookupValues.sortOrder));
  const Item = ({ list, id, label, active, sortOrder, listKey }: { list: "channel" | "contact_role" | "lookup"; id?: string; label?: string; active?: boolean; sortOrder?: number; listKey?: string }) => (
    <ActionForm action={saveListItemAction} hideSuccess={!!id} resetOnSuccess={!id} className="flex flex-wrap items-center gap-2 px-4 py-1.5">
      <input type="hidden" name="list" value={list} />
      {id ? <input type="hidden" name="id" value={id} /> : null}
      {listKey ? <input type="hidden" name="listKey" value={listKey} /> : null}
      <Input name="label" aria-label="Label" defaultValue={label} placeholder={id ? undefined : "Add new…"} required className="h-8 max-w-xs" />
      {id ? <Input type="number" name="sortOrder" aria-label="Order" defaultValue={sortOrder} className="h-8 w-20" /> : null}
      {id ? <Checkbox name="active" label="Active" defaultChecked={active} /> : <input type="hidden" name="active" value="true" />}
      <SubmitButton size="sm" variant={id ? "ghost" : "secondary"}>{id ? "Save" : "Add"}</SubmitButton>
    </ActionForm>
  );
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader title="Acquisition & outreach channels" description="Used for first-touch attribution. Unknown sources stay unknown." />{ch.map((c) => <Item key={c.id} list="channel" id={c.id} label={c.label} active={c.active} sortOrder={c.sortOrder} />)}<Item list="channel" /></Card>
      <Card><CardHeader title="Buying roles" />{roles.map((r) => <Item key={r.id} list="contact_role" id={r.id} label={r.label} active={r.active} sortOrder={r.sortOrder} />)}<Item list="contact_role" /></Card>
      {LISTS.map((l) => (
        <Card key={l.key}><CardHeader title={l.label} />{lookups.filter((x) => x.listKey === l.key).map((x) => <Item key={x.id} list="lookup" listKey={l.key} id={x.id} label={x.value} active={x.active} sortOrder={x.sortOrder} />)}<Item list="lookup" listKey={l.key} /></Card>
      ))}
    </div>
  );
}

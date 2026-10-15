import Link from "next/link";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { offers, outreachTemplates, proposalTemplates, services } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { TEMPLATES } from "@/server/delivery/templates";
import { saveProposalTemplateAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";

export const metadata = { title: "Templates" };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("system.settings");
  const sp = await searchParams;
  const tab = ["proposals", "outreach", "workspace"].includes(sp.tab ?? "") ? sp.tab! : "proposals";
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Templates" }]} title="Templates" description="Starting points for proposals, outreach messages and service workspaces." />
      <Tabs current={tab} tabs={[{ key: "proposals", label: "Proposal templates", href: "/system/templates" }, { key: "outreach", label: "Outreach templates", href: "/system/templates?tab=outreach" }, { key: "workspace", label: "Service workspaces", href: "/system/templates?tab=workspace" }]} />
      <div className="mt-4 space-y-4">
        {tab === "proposals" ? <Proposals /> : null}
        {tab === "outreach" ? <Outreach /> : null}
        {tab === "workspace" ? <Workspace /> : null}
      </div>
    </>
  );
}

async function Proposals() {
  const rows = await db.select().from(proposalTemplates).orderBy(asc(proposalTemplates.name));
  const svcs = await db.select({ value: services.id, label: services.name }).from(services).orderBy(services.sortOrder);
  const ofs = await db.select({ value: offers.id, label: offers.name }).from(offers).orderBy(offers.name);
  const Form = ({ t }: { t?: typeof proposalTemplates.$inferSelect }) => (
    <ActionForm action={saveProposalTemplateAction} resetOnSuccess={!t}>
      {t ? <input type="hidden" name="id" value={t.id} /> : null}
      <FormGrid cols={4}>
        <Field label="Name"><Input name="name" defaultValue={t?.name} required /></Field>
        <Field label="Service"><Select name="serviceId" options={svcs} placeholder="Any" defaultValue={t?.serviceId ?? ""} /></Field>
        <Field label="Offer"><Select name="offerId" options={ofs} placeholder="Any" defaultValue={t?.offerId ?? ""} /></Field>
        <Field label="Pricing model"><Select name="pricingModel" options={[{ value: "fixed", label: "Fixed" }, { value: "retainer", label: "Retainer" }, { value: "milestone", label: "Milestones" }, { value: "hourly", label: "Hourly" }]} placeholder="—" defaultValue={t?.pricingModel ?? ""} /></Field>
      </FormGrid>
      <FormGrid cols={2} className="mt-2">
        <Field label="Introduction"><Textarea name="introduction" rows={3} defaultValue={t?.introduction ?? ""} /></Field>
        <Field label="Scope"><Textarea name="scope" rows={3} defaultValue={t?.scope ?? ""} /></Field>
        <Field label="Deliverables (one per line)"><Textarea name="deliverablesText" rows={3} defaultValue={(t?.deliverables ?? []).map((d) => d.name).join("\n")} /></Field>
        <Field label="Timeline"><Textarea name="timeline" rows={3} defaultValue={t?.timeline ?? ""} /></Field>
        <Field label="Exclusions"><Textarea name="exclusions" rows={2} defaultValue={t?.exclusions ?? ""} /></Field>
        <Field label="Assumptions"><Textarea name="assumptions" rows={2} defaultValue={t?.assumptions ?? ""} /></Field>
      </FormGrid>
      <Field label="Terms" className="mt-2"><Textarea name="terms" rows={3} defaultValue={t?.terms ?? ""} /></Field>
      <div className="mt-2 flex items-center justify-between"><Checkbox name="active" label="Active" defaultChecked={t?.active ?? true} /><SubmitButton size="sm">{t ? "Save template" : "Add template"}</SubmitButton></div>
    </ActionForm>
  );
  return (
    <>
      {rows.length ? rows.map((t) => (
        <Card key={t.id}>
          <CardHeader title={<span className="flex items-center gap-2">{t.name}{!t.active ? <Badge>inactive</Badge> : null}</span>} description={`${svcs.find((s) => s.value === t.serviceId)?.label ?? "Any service"} · ${(t.deliverables ?? []).length} deliverable(s)`} />
          <CardBody><details><summary className="cursor-pointer text-[13px] text-accent">Edit</summary><div className="mt-2"><Form t={t} /></div></details></CardBody>
        </Card>
      )) : <Card><EmptyState title="No proposal templates" /></Card>}
      <Card><CardHeader title="New proposal template" description="Prices are not part of templates — they come from the opportunity and are reviewed on each proposal." /><CardBody><Form /></CardBody></Card>
    </>
  );
}

async function Outreach() {
  const rows = await db.select().from(outreachTemplates).orderBy(asc(outreachTemplates.name));
  return (
    <Card>
      <CardHeader title="Outreach templates" actions={<Link className="text-[13px] text-accent hover:underline" href="/crm/outreach?tab=templates">Manage in Outreach</Link>} />
      {rows.length ? <Table><THead><tr><TH>Name</TH><TH>Channel</TH><TH>Subject</TH><TH>Status</TH></tr></THead><tbody>{rows.map((t) => <TR key={t.id}><TD>{t.name}</TD><TD>{t.channel}</TD><TD className="text-[12.5px]">{t.subject ?? "—"}</TD><TD>{t.active ? <Badge tone="success">active</Badge> : <Badge>inactive</Badge>}</TD></TR>)}</tbody></Table> : <EmptyState title="No outreach templates" />}
    </Card>
  );
}

function Workspace() {
  const names = { creative: "Creative Direction", advisory: "Strategy, Financial & Operational Advisory", executive: "Executive Communication" };
  return (
    <>
      <p className="text-[13px] text-muted">Workspace item types are defined in code (src/server/delivery/templates.ts) so their validation rules stay consistent. Each engagement gets the workspace of its service stream.</p>
      {(Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]).map((k) => (
        <Card key={k}>
          <CardHeader title={names[k]} />
          <Table>
            <THead><tr><TH>Item type</TH><TH>Statuses</TH><TH>Fields</TH><TH>Rules</TH></tr></THead>
            <tbody>{TEMPLATES[k].map((d) => <TR key={d.key}><TD className="font-medium">{d.plural}<div className="text-[12px] font-normal text-muted">{d.description}</div></TD><TD className="text-[12px]">{d.statuses.map((s) => s.replace(/_/g, " ")).join(" → ")}</TD><TD className="text-[12px]">{d.fields.map((f) => `${f.label}${f.required ? "*" : ""}`).join(", ")}</TD><TD className="text-[12px]">{[d.scheduled && "scheduled date", d.channel && "channel", d.requiresSource && "must cite source"].filter(Boolean).join(", ") || "—"}</TD></TR>)}</tbody>
          </Table>
        </Card>
      ))}
    </>
  );
}

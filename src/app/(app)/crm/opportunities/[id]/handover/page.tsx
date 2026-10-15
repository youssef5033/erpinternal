import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { opportunities, services } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { opportunityVisibility } from "@/server/auth/scope";
import { previewHandover } from "@/server/crm/handover";
import { listUsers } from "@/components/records/panels";
import { Badge, Card, CardBody, CardHeader, DefinitionList, Notice, PageHeader } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { handoverAction } from "@/server/actions/crm";

export const metadata = { title: "Handover" };

export default async function HandoverPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("delivery.write");
  const { id } = await params;
  const [o] = await db.select().from(opportunities).where(and(eq(opportunities.id, id), opportunityVisibility(actor)));
  if (!o) notFound();
  const plan = await previewHandover(db, id);
  const users = await listUsers();
  const [svc] = await db.select().from(services).where(eq(services.id, plan.engagement.serviceId));
  const e = plan.engagement;
  return (
    <>
      <PageHeader crumbs={[{ label: "Opportunities", href: "/crm/opportunities" }, { label: o.number, href: `/crm/opportunities/${id}` }, { label: "Handover" }]} title="Review handover to delivery" description="Check everything below, adjust what you need, then create the engagement. The existing account and contacts are reused; nothing is created twice." />
      {plan.existingEngagement ? (
        <Notice tone="success" title="Already handed over" className="mb-4">This opportunity is linked to <Link className="font-medium underline" href={`/delivery/engagements/${plan.existingEngagement.id}`}>{plan.existingEngagement.number}</Link>. A second engagement cannot be created.</Notice>
      ) : o.status !== "won" ? (
        <Notice tone="warning" title="Mark the opportunity won first" className="mb-4"><Link className="underline" href={`/crm/opportunities/${id}`}>Back to the opportunity</Link></Notice>
      ) : null}
      {plan.warnings.length ? <Notice tone="warning" title="Check before continuing" className="mb-4"><ul className="list-disc pl-5">{plan.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Notice> : null}
      <ActionForm action={handoverAction} className="space-y-4">
        <input type="hidden" name="id" value={id} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Account & commercial basis" />
            <CardBody>
              <DefinitionList items={[
                { label: "Account (reused)", value: <Link className="text-accent hover:underline" href={`/crm/accounts/${plan.account.id}`}>{plan.account.name}</Link> },
                { label: "Contacts (reused)", value: plan.contacts.map((c) => c.fullName).join(", ") || "—" },
                { label: "Accepted proposal", value: plan.acceptedVersion ? `${plan.acceptedVersion.proposalNumber} v${plan.acceptedVersion.versionNumber} · ${plan.acceptedVersion.currency} ${plan.acceptedVersion.total}` : "None recorded" },
                { label: "Acceptance evidence", value: plan.acceptance ? <>{plan.acceptance.acceptedByName}, <DateText value={plan.acceptance.acceptedAt} /> ({plan.acceptance.method.replace(/_/g, " ")})</> : "—" },
                { label: "Contracts to link", value: plan.contractsToLink.map((c) => `${c.number} (${c.status})`).join(", ") || "None" },
                { label: "Service", value: <Badge tone={svc?.key as "creative"}>{svc?.name}</Badge> },
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Engagement" />
            <CardBody>
              <FormGrid cols={2}>
                <Field label="Name" htmlFor="name" className="sm:col-span-2"><Input id="name" name="name" defaultValue={e.name} required /></Field>
                <Field label="Delivery owner" htmlFor="ownerId"><Select id="ownerId" name="ownerId" defaultValue={e.ownerId ?? actor.userId} options={users.map((u) => ({ value: u.id, label: u.name }))} /></Field>
                <Field label="Billing model" htmlFor="bm"><Input id="bm" value={`${e.billingModel} · recognition: ${e.recognitionMethod.replace(/_/g, " ")}`} disabled /></Field>
                <Field label="Start date" htmlFor="startDate"><Input id="startDate" name="startDate" type="date" defaultValue={e.startDate} required /></Field>
                <Field label="End date" htmlFor="endDate"><Input id="endDate" name="endDate" type="date" defaultValue={e.endDate ?? ""} /></Field>
                <Field label="Budget hours" htmlFor="budgetHours"><Input id="budgetHours" name="budgetHours" defaultValue={e.budgetHours ?? ""} /></Field>
                <Field label={`Budget direct cost (${e.currency})`} htmlFor="budgetCost"><Input id="budgetCost" name="budgetCost" /></Field>
              </FormGrid>
              <p className="mt-2 text-[12.5px] text-muted">Contract value <Money value={e.contractValue} currency={e.currency} />{e.retainerAmount ? <> · retainer <Money value={e.retainerAmount} currency={e.currency} />/month for {e.retainerPeriodMonths} months</> : null}{e.hourlyRate ? <> · rate <Money value={e.hourlyRate} currency={e.currency} />/h</> : null}</p>
              <fieldset className="mt-3">
                <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Team members</legend>
                <div className="flex flex-wrap gap-3">{users.map((u) => <Checkbox key={u.id} name="memberIds[]" value={u.id} label={u.name} />)}</div>
              </fieldset>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Approved scope (from the accepted proposal)" />
            <CardBody>
              <DefinitionList columns={1} items={[{ label: "In scope", value: plan.scope.inScope }, { label: "Exclusions", value: plan.scope.exclusions }, { label: "Assumptions", value: plan.scope.assumptions }, { label: "Discovery notes (transferred)", value: plan.scope.discoveryNotes }]} />
              <p className="mt-3 text-[12.5px] font-medium text-ink-2">Milestones & deliverables</p>
              <ul className="mt-1 space-y-0.5 text-[13px]">
                {plan.milestones.map((m) => <li key={m.name}>◆ {m.name} {m.dueDate ? <>· due <DateText value={m.dueDate} /></> : null}</li>)}
                {plan.deliverables.map((x) => <li key={x.name} className="pl-4">• {x.name}{x.milestone ? ` (${x.milestone})` : ""} {x.dueDate ? <>· <DateText value={x.dueDate} /></> : null}</li>)}
                {!plan.deliverables.length ? <li className="text-muted">No deliverables in the proposal — add them on the engagement.</li> : null}
              </ul>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Onboarding tasks" />
            <CardBody className="space-y-1">
              {plan.onboardingTasks.map((t) => <Checkbox key={t.title} name="includeTaskTitles[]" value={t.title} defaultChecked label={<>{t.title} <span className="text-muted">· due <DateText value={t.dueDate} /></span></>} />)}
            </CardBody>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader title="Draft billing schedule" description={e.billingModel === "retainer" ? "Retainers get one planned billing item per month of the service period (created automatically)." : "Created as DRAFT items. Milestone items become invoiceable when the milestone is accepted. Nothing is invoiced yet."} />
            <CardBody className="space-y-2">
              {e.billingModel !== "retainer" ? plan.billingSchedule.map((b, i) => (
                <FormGrid key={i} cols={4}>
                  <Field label="Label" htmlFor={`b${i}l`}><Input id={`b${i}l`} name={`billing.${i}.label`} defaultValue={b.label} /></Field>
                  <Field label="Planned date" htmlFor={`b${i}d`} hint={b.milestone ? `On acceptance of ${b.milestone}` : undefined}><Input id={`b${i}d`} name={`billing.${i}.plannedDate`} type="date" defaultValue={b.plannedDate ?? ""} /></Field>
                  <Field label={`Amount (${e.currency})`} htmlFor={`b${i}a`}><Input id={`b${i}a`} name={`billing.${i}.amount`} defaultValue={b.amount} /></Field>
                  <input type="hidden" name={`billing.${i}.milestone`} value={b.milestone ?? ""} />
                  {b.isDeposit ? <input type="hidden" name={`billing.${i}.isDeposit`} value="true" /> : null}
                </FormGrid>
              )) : <p className="text-[13px] text-muted">Monthly items will be generated for the first service period.</p>}
              {e.billingModel === "hourly" ? <p className="text-[13px] text-muted">Hourly engagements are billed from approved time; no fixed schedule.</p> : null}
            </CardBody>
          </Card>
        </div>
        {!plan.existingEngagement && o.status === "won" ? <SubmitButton>Create engagement and onboarding tasks</SubmitButton> : null}
      </ActionForm>
    </>
  );
}

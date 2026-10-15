import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { engagementMembers, people, tasks, timeEntries, user } from "@/db/schema";
import type { engagements } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { canSeeCost } from "@/server/delivery/time";
import { engagementProfitability } from "@/server/finance/profitability";
import { engagementMembersAction, logTimeAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, MetricCard, Money, Progress } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from "@/components/forms/fields";

type Eng = typeof engagements.$inferSelect;

export async function TimeTab({ actor, e, today }: { actor: Actor; e: Eng; today: string }) {
  const showCost = canSeeCost(actor);
  const entries = await db
    .select({ t: timeEntries, person: people.fullName, taskTitle: tasks.title })
    .from(timeEntries)
    .innerJoin(people, eq(people.id, timeEntries.personId))
    .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(eq(timeEntries.engagementId, e.id))
    .orderBy(desc(timeEntries.workDate))
    .limit(200);
  const openTasks = await db.select({ value: tasks.id, label: tasks.title }).from(tasks).where(and(eq(tasks.engagementId, e.id), inArray(tasks.status, ["backlog", "ready", "in_progress", "internal_review", "client_review", "blocked"])));
  const approved = entries.filter((x) => x.t.status === "approved").reduce((a, x) => a + Number(x.t.hours), 0);
  const pending = entries.filter((x) => x.t.status === "submitted").reduce((a, x) => a + Number(x.t.hours), 0);
  const budget = e.budgetHours ? Number(e.budgetHours) : null;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Approved hours" value={approved.toFixed(1)} currency={null} href={`/people/timesheets?engagement=${e.id}`} basis="Sum of approved time entries on this engagement." range="Engagement to date" detail={[{ label: "Awaiting approval", value: pending.toFixed(1) }]} />
        <MetricCard label="Budget hours used" value={budget ? ((approved / budget) * 100).toFixed(0) : null} suffix="%" currency={null} href={`/delivery/engagements/${e.id}?tab=scope`} basis="Approved hours ÷ budget hours on the current scope." range="Engagement to date" unavailableReason={budget ? undefined : "No hours budget recorded."} />
        <MetricCard label="Remaining hours" value={budget ? (budget - approved).toFixed(1) : null} currency={null} href={`/delivery/engagements/${e.id}?tab=scope`} basis="Budget hours − approved hours (pending entries not included)." range="Engagement to date" unavailableReason={budget ? undefined : "No hours budget recorded."} />
      </div>
      {budget ? <Progress value={approved} max={budget} tone={approved > budget ? "danger" : approved > budget * 0.85 ? "warning" : "accent"} /> : null}

      {can(actor, "time.write") ? (
        <Card>
          <CardHeader title="Log time" description={showCost ? "Cost is snapshotted from the person's cost rate on the work date." : undefined} />
          <CardBody>
            <ActionForm action={logTimeAction} resetOnSuccess>
              <input type="hidden" name="engagementId" value={e.id} />
              <FormGrid cols={4}>
                <Field label="Date" required><Input type="date" name="workDate" defaultValue={today} max={today} required /></Field>
                <Field label="Hours" required><Input name="hours" inputMode="decimal" placeholder="1.5" required /></Field>
                <Field label="Task"><Select name="taskId" options={openTasks} placeholder="—" /></Field>
                <div className="self-end pb-2"><Checkbox name="billable" label="Billable" defaultChecked /></div>
              </FormGrid>
              <Field label="What did you do?" className="mt-3"><Textarea name="description" rows={2} /></Field>
              <div className="mt-3 flex justify-end"><SubmitButton>Log time</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Time entries" />
        {entries.length ? (
          <Table>
            <THead><tr><TH>Date</TH><TH>Person</TH><TH>Task / description</TH><TH align="right">Hours</TH>{showCost ? <TH align="right">Cost</TH> : null}<TH>Status</TH></tr></THead>
            <tbody>
              {entries.map(({ t, person, taskTitle }) => (
                <TR key={t.id}>
                  <TD><DateText value={t.workDate} /></TD>
                  <TD>{person}</TD>
                  <TD className="text-[12.5px]">{taskTitle ? <Link className="hover:underline" href={`/people/tasks/${t.taskId}`}>{taskTitle}</Link> : null}{t.description ? <div className="text-muted">{t.description}</div> : null}</TD>
                  <TD align="right">{Number(t.hours).toFixed(2)}{!t.billable ? <Badge className="ml-1">non-billable</Badge> : null}</TD>
                  {showCost ? <TD align="right">{t.costAmount ? <Money value={t.costAmount} currency={t.costCurrency ?? null} /> : <span className="text-warning" title="No cost rate on the work date">no rate</span>}</TD> : null}
                  <TD><StatusBadge status={t.status} />{t.rejectionReason ? <div className="text-[12px] text-muted">{t.rejectionReason}</div> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No time logged yet" />}
      </Card>
    </div>
  );
}

export async function TeamCard({ actor, e }: { actor: Actor; e: Eng }) {
  const members = await db.select({ m: engagementMembers, name: user.name }).from(engagementMembers).innerJoin(user, eq(user.id, engagementMembers.userId)).where(eq(engagementMembers.engagementId, e.id));
  const users = await db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name);
  const canWrite = can(actor, "delivery.write");
  const rows = [...members.map((m) => ({ userId: m.m.userId, role: m.m.role, hours: m.m.allocationHoursPerWeek })), { userId: "", role: "contributor", hours: null }, { userId: "", role: "contributor", hours: null }];
  return (
    <Card>
      <CardHeader title="Team" description="Members can see this engagement; contractors see only engagements they are on." />
      {members.length ? (
        <ul className="divide-y divide-line text-[13px]">{members.map((m) => <li key={m.m.userId} className="flex justify-between px-4 py-2"><span>{m.name} <span className="text-muted">· {m.m.role}</span></span><span className="text-muted">{m.m.allocationHoursPerWeek ? `${Number(m.m.allocationHoursPerWeek).toFixed(0)} h/week` : "—"}</span></li>)}</ul>
      ) : <EmptyState title="Nobody assigned" />}
      {canWrite ? (
        <CardBody className="border-t border-line">
          <details>
            <summary className="cursor-pointer text-[13px] font-medium text-accent">Edit team</summary>
            <ActionForm action={engagementMembersAction} className="mt-2 space-y-2">
              <input type="hidden" name="id" value={e.id} />
              {rows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_110px_90px] gap-2">
                  <Select aria-label={`Member ${i + 1}`} name={`members.${i}.userId`} options={users} placeholder="—" defaultValue={r.userId} />
                  <Input aria-label={`Member ${i + 1} role`} name={`members.${i}.role`} defaultValue={r.role} />
                  <Input aria-label={`Member ${i + 1} hours per week`} name={`members.${i}.allocationHoursPerWeek`} inputMode="decimal" placeholder="h/week" defaultValue={r.hours ?? ""} />
                </div>
              ))}
              <SubmitButton size="sm">Save team</SubmitButton>
            </ActionForm>
          </details>
        </CardBody>
      ) : null}
    </Card>
  );
}

export async function BudgetTab({ actor, e }: { actor: Actor; e: Eng }) {
  if (!canSeeCost(actor) || !can(actor, "finance.read")) {
    return <Notice>Budget and margin figures need cost-rate and finance access. Hours against budget are on the Time tab.</Notice>;
  }
  const { baseCurrency, rows } = await engagementProfitability(db, { engagementIds: [e.id] });
  const p = rows[0];
  if (!p) return <EmptyState title="No financial activity yet" />;
  const range = "Engagement to date (posted ledger entries)";
  return (
    <div className="space-y-4">
      {Number(p.missingCostRateHours) > 0 ? <Notice tone="warning" title="Incomplete labour cost">{Number(p.missingCostRateHours).toFixed(1)} approved hours have no cost rate on their work date, so labour cost and margin are understated. Add cost rates in People.</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Recognised revenue" value={p.revenue} currency={baseCurrency} href={`/delivery/engagements/${e.id}?tab=billing`} basis="Revenue posted to the ledger for this engagement (recognition, not invoicing)." range={range} detail={[{ label: "Invoiced (net of tax)", value: p.invoicedNet, currency: baseCurrency }]} />
        <MetricCard label="Direct cost" value={p.directCost} currency={baseCurrency} href={`/delivery/engagements/${e.id}?tab=time`} basis="Approved labour at cost rate + contractor bills + other direct costs tagged to this engagement." range={range} detail={[{ label: "Labour", value: p.laborCost, currency: baseCurrency }, { label: "Contractors", value: p.contractorCost, currency: baseCurrency }, { label: "Other direct", value: p.otherDirectCost, currency: baseCurrency }]} />
        <MetricCard label="Gross margin" value={p.grossMargin} currency={baseCurrency} href={`/finance/margins`} basis="Recognised revenue − direct cost." range={range} detail={p.marginPct ? [{ label: "Margin %", value: `${p.marginPct}%` }] : []} />
        <MetricCard label="Budget cost used" value={p.costUsedPct} suffix="%" currency={null} href={`/delivery/engagements/${e.id}?tab=scope`} basis="Direct cost ÷ budget cost on the engagement." range={range} unavailableReason={p.budgetCost ? undefined : "No cost budget recorded."} detail={p.overBudget ? [{ label: "Status", value: "Over budget" }] : []} />
      </div>
    </div>
  );
}

import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { leaveRequests, people } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { workingDays } from "@/server/people/people";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO } from "@/lib/dates";
import { decideLeaveAction, requestLeaveAction } from "@/server/actions/people";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input, Select } from "@/components/forms/fields";

export const metadata = { title: "Leave" };

const TYPES = [{ value: "annual", label: "Annual leave" }, { value: "sick", label: "Sick leave" }, { value: "unpaid", label: "Unpaid leave" }, { value: "parental", label: "Parental leave" }, { value: "other", label: "Other" }];

export default async function LeavePage() {
  const actor = await guard("people.read");
  const today = await agencyToday(db);
  const [me] = await db.select().from(people).where(eq(people.userId, actor.userId));
  const canDecide = can(actor, "people.write");
  const mine = me ? await db.select().from(leaveRequests).where(eq(leaveRequests.personId, me.id)).orderBy(desc(leaveRequests.startDate)) : [];
  const pending = canDecide ? await db.select({ l: leaveRequests, name: people.fullName, userId: people.userId }).from(leaveRequests).innerJoin(people, eq(people.id, leaveRequests.personId)).where(eq(leaveRequests.status, "requested")).orderBy(asc(leaveRequests.startDate)) : [];
  const upcoming = await db.select({ l: leaveRequests, name: people.fullName }).from(leaveRequests).innerJoin(people, eq(people.id, leaveRequests.personId)).where(and(inArray(leaveRequests.status, ["approved", "requested"]), gte(leaveRequests.endDate, today))).orderBy(asc(leaveRequests.startDate)).limit(100);
  const year = today.slice(0, 4);
  const usedThisYear = mine.filter((l) => l.status === "approved" && l.leaveType === "annual" && l.startDate.startsWith(year)).reduce((a, l) => a + workingDays(l.startDate, l.endDate), 0);
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Leave" }]} title="Leave" description="Requests, approvals and who is away. Others see availability only — leave type and reasons are visible to the person and HR." />
      <Notice className="mb-4">Leave entitlements and accrual rules depend on contracts and jurisdiction and are not calculated. Track agreed allowances with HR; working days shown are Monday–Friday.</Notice>
      <div className="grid gap-4 xl:grid-cols-2">
        {me ? (
          <Card>
            <CardHeader title="Request leave" description={`${usedThisYear} working day(s) of approved annual leave in ${year}.`} />
            <CardBody>
              <ActionForm action={requestLeaveAction} resetOnSuccess>
                <input type="hidden" name="personId" value={me.id} />
                <FormGrid cols={3}>
                  <Field label="Type"><Select name="leaveType" options={TYPES} /></Field>
                  <Field label="From"><Input type="date" name="startDate" defaultValue={addDaysISO(today, 7)} required /></Field>
                  <Field label="To"><Input type="date" name="endDate" defaultValue={addDaysISO(today, 7)} required /></Field>
                </FormGrid>
                <Field label="Note (optional, private)" className="mt-2"><Input name="reason" /></Field>
                <div className="mt-2 flex justify-end"><SubmitButton size="sm">Request</SubmitButton></div>
              </ActionForm>
            </CardBody>
            {mine.length ? (
              <Table>
                <THead><tr><TH>Dates</TH><TH>Type</TH><TH align="right">Days</TH><TH>Status</TH><TH /></tr></THead>
                <tbody>{mine.map((l) => <TR key={l.id}><TD><DateText value={l.startDate} /> – <DateText value={l.endDate} /></TD><TD>{l.leaveType}</TD><TD align="right">{workingDays(l.startDate, l.endDate)}</TD><TD><StatusBadge status={l.status} />{l.decisionNote ? <div className="text-[12px] text-muted">{l.decisionNote}</div> : null}</TD><TD align="right">{["requested", "approved"].includes(l.status) && l.endDate >= today ? <ActionForm action={decideLeaveAction} hideSuccess><input type="hidden" name="id" value={l.id} /><SubmitButton size="sm" variant="ghost" name="decision" value="cancelled" confirm="Cancel this leave?">Cancel</SubmitButton></ActionForm> : null}</TD></TR>)}</tbody>
              </Table>
            ) : null}
          </Card>
        ) : <Notice tone="warning">Your login is not linked to a person record, so you cannot request leave.</Notice>}
        {canDecide ? (
          <Card>
            <CardHeader title={`Awaiting decision (${pending.length})`} description="You cannot decide on your own requests." />
            {pending.length ? (
              <ul className="divide-y divide-line">
                {pending.map(({ l, name, userId }) => (
                  <li key={l.id} className="px-4 py-3">
                    <p className="text-[13.5px] font-medium">{name} · {l.leaveType}</p>
                    <p className="text-[12.5px] text-muted"><DateText value={l.startDate} /> – <DateText value={l.endDate} /> · {workingDays(l.startDate, l.endDate)} working day(s){l.reason ? ` · ${l.reason}` : ""}</p>
                    {userId !== actor.userId ? (
                      <ActionForm action={decideLeaveAction} className="mt-2 flex flex-wrap gap-2">
                        <input type="hidden" name="id" value={l.id} />
                        <Input name="note" aria-label="Note" placeholder="Note (required to reject)" className="h-8 max-w-xs" />
                        <SubmitButton size="sm" name="decision" value="approved">Approve</SubmitButton>
                        <SubmitButton size="sm" variant="secondary" name="decision" value="rejected">Reject</SubmitButton>
                      </ActionForm>
                    ) : <p className="mt-1 text-[12px] text-muted">Your own request — another approver must decide.</p>}
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No pending requests" />}
          </Card>
        ) : null}
        <Card className="xl:col-span-2">
          <CardHeader title="Who is away" description="Approved and requested leave from today." />
          {upcoming.length ? (
            <Table>
              <THead><tr><TH>Person</TH><TH>From</TH><TH>To</TH><TH align="right">Working days</TH><TH>Status</TH></tr></THead>
              <tbody>{upcoming.map(({ l, name }) => <TR key={l.id}><TD>{name}</TD><TD><DateText value={l.startDate} /></TD><TD><DateText value={l.endDate} /></TD><TD align="right">{workingDays(l.startDate, l.endDate)}</TD><TD>{l.status === "requested" ? <Badge tone="warning">requested</Badge> : <Badge tone="info">approved</Badge>}{l.startDate <= today ? <Badge className="ml-1">away now</Badge> : null}</TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="Nobody is scheduled to be away" />}
        </Card>
      </div>
    </>
  );
}

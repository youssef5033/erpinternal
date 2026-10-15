import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { roles, user, userRoles } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { createUserAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input } from "@/components/forms/fields";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  await guard("users.manage");
  const rows = await db
    .select({ u: user, roleNames: sql<string[]>`coalesce(array_agg(${roles.name} order by ${roles.name}) filter (where ${roles.id} is not null), '{}')`, lastSeen: sql<string | null>`(select max(s.updated_at)::text from session s where s.user_id = "user"."id")`, personId: sql<string | null>`(select p.id::text from people p where p.user_id = "user"."id" limit 1)` })
    .from(user)
    .leftJoin(userRoles, eq(userRoles.userId, user.id))
    .leftJoin(roles, eq(roles.id, userRoles.roleId))
    .groupBy(user.id)
    .orderBy(asc(user.name));
  const allRoles = await db.select().from(roles).orderBy(asc(roles.name));
  return (
    <>
      <PageHeader crumbs={[{ label: "Users & Permissions" }, { label: "Users" }]} title="Users" description="Who can sign in and what they can do. Sign-up is disabled: accounts are created here. No invitation email is sent." />
      <Card className="mb-4">
        <Table>
          <THead><tr><TH>User</TH><TH>Roles</TH><TH>Person record</TH><TH>Last active</TH><TH>Status</TH></tr></THead>
          <tbody>
            {rows.map(({ u, roleNames, lastSeen, personId }) => (
              <TR key={u.id}>
                <TD><Link className="font-medium hover:underline" href={`/admin/users/${u.id}`}>{u.name}</Link><div className="text-[12px] text-muted">{u.email}</div></TD>
                <TD><div className="flex flex-wrap gap-1">{roleNames.length ? roleNames.map((r) => <Badge key={r}>{r}</Badge>) : <Badge tone="warning">no role</Badge>}</div></TD>
                <TD>{personId ? <Link className="text-[12.5px] text-accent hover:underline" href={`/people/${personId}`}>Linked</Link> : <span className="text-[12.5px] text-muted">Not linked</span>}</TD>
                <TD className="text-[12.5px]">{lastSeen ? <DateTimeText value={lastSeen} /> : "Never"}</TD>
                <TD><StatusBadge status={u.status} /></TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card className="max-w-4xl">
        <CardHeader title="Create a user" description="Set a temporary password (12+ characters, letters and numbers) and share it securely. Link the login to a person record under People so they can log time." />
        <CardBody>
          <ActionForm action={createUserAction} resetOnSuccess>
            <FormGrid cols={3}>
              <Field label="Name" required><Input name="name" required /></Field>
              <Field label="Email" required><Input type="email" name="email" required autoComplete="off" /></Field>
              <Field label="Temporary password" required><Input type="password" name="password" required minLength={12} autoComplete="new-password" /></Field>
              <Field label="Job title"><Input name="title" /></Field>
              <Field label="Time zone"><Input name="timeZone" placeholder="e.g. Europe/London" /></Field>
            </FormGrid>
            <fieldset className="mt-3">
              <legend className="mb-1 text-[12.5px] font-medium text-ink-2">Roles</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1">{allRoles.map((r) => <label key={r.id} className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" name="roleIds[]" value={r.id} className="h-4 w-4 accent-[var(--color-accent)]" />{r.name}</label>)}</div>
            </fieldset>
            <div className="mt-3 flex justify-end"><SubmitButton>Create user</SubmitButton></div>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}

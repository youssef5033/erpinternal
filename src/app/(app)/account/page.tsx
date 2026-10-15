import { headers } from "next/headers";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { session, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { auth } from "@/server/auth/auth";
import { PERMISSION_GROUPS, PERMISSIONS } from "@/server/auth/permissions";
import { changePasswordAction, revokeOtherSessionsAction, updateProfileAction } from "@/server/actions/account";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input } from "@/components/forms/fields";

export const metadata = { title: "My account" };

export default async function AccountPage() {
  const actor = await guard();
  const [u] = await db.select().from(user).where(eq(user.id, actor.userId));
  const current = await auth.api.getSession({ headers: await headers() });
  const sessions = await db.select().from(session).where(eq(session.userId, actor.userId)).orderBy(desc(session.updatedAt));
  return (
    <>
      <PageHeader title="My account" description={`${actor.email} · ${actor.roleNames.join(", ")}`} />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Profile" />
            <CardBody>
              <ActionForm action={updateProfileAction}>
                <FormGrid cols={3}>
                  <Field label="Name"><Input name="name" defaultValue={u.name} required /></Field>
                  <Field label="Title"><Input name="title" defaultValue={u.title ?? ""} /></Field>
                  <Field label="Time zone" hint="Used to show times; blank = agency default"><Input name="timeZone" defaultValue={u.timeZone ?? ""} /></Field>
                </FormGrid>
                <div className="mt-3 flex justify-end"><SubmitButton size="sm">Save</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Change password" />
            <CardBody>
              <ActionForm action={changePasswordAction} resetOnSuccess>
                <FormGrid cols={3}>
                  <Field label="Current password"><Input type="password" name="currentPassword" autoComplete="current-password" required /></Field>
                  <Field label="New password"><Input type="password" name="newPassword" autoComplete="new-password" minLength={12} required /></Field>
                  <Field label="Confirm"><Input type="password" name="confirm" autoComplete="new-password" required /></Field>
                </FormGrid>
                <div className="mt-3 flex justify-end"><SubmitButton size="sm">Change password</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Sessions" actions={sessions.length > 1 ? <ActionForm action={revokeOtherSessionsAction} hideSuccess><SubmitButton size="sm" variant="secondary">Sign out other sessions</SubmitButton></ActionForm> : null} />
            <ul className="divide-y divide-line text-[12.5px]">{sessions.map((s) => <li key={s.id} className="flex justify-between gap-2 px-4 py-2"><span className="truncate">{s.userAgent ?? "Unknown device"}{s.ipAddress ? ` · ${s.ipAddress}` : ""}</span><span className="whitespace-nowrap text-muted">{s.id === current?.session.id ? <Badge tone="success">this session</Badge> : <DateTimeText value={s.updatedAt} />}</span></li>)}</ul>
          </Card>
        </div>
        <Card>
          <CardHeader title="What I can do" description="Granted by your roles. 'Assigned' means only records you own or are assigned to." />
          <CardBody>
            {PERMISSION_GROUPS.map((g) => {
              const list = g.permissions.filter((p) => actor.grants.has(p));
              return list.length ? (
                <div key={g.label} className="mb-3">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{g.label}</p>
                  <ul className="mt-1 space-y-0.5 text-[13px]">{list.map((p) => <li key={p} className="flex justify-between gap-2"><span>{PERMISSIONS[p]}</span><Badge tone={actor.grants.get(p) === "all" ? "success" : "warning"}>{actor.grants.get(p)}</Badge></li>)}</ul>
                </div>
              ) : null;
            })}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

import { notFound } from "next/navigation";
import { asc, desc, eq, or } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, roles, user, userRoles } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { loadActor } from "@/server/auth/actor";
import { PERMISSION_GROUPS, PERMISSIONS } from "@/server/auth/permissions";
import { userAccessAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input } from "@/components/forms/fields";

export const metadata = { title: "User" };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("users.manage");
  const { id } = await params;
  const [u] = await db.select().from(user).where(eq(user.id, id));
  if (!u) notFound();
  const mine = await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id));
  const allRoles = await db.select().from(roles).orderBy(asc(roles.name));
  const effective = u.status === "active" ? await loadActor(db, id) : null;
  const history = await db.select().from(auditEvents).where(or(eq(auditEvents.entityId, id), eq(auditEvents.actorId, id))).orderBy(desc(auditEvents.createdAt)).limit(15);
  const self = id === actor.userId;
  return (
    <>
      <PageHeader crumbs={[{ label: "Users & Permissions" }, { label: "Users", href: "/admin/users" }, { label: u.name }]} title={u.name} meta={<StatusBadge status={u.status} />} description={u.email} />
      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Roles" description="Changing roles signs the user out so the new permissions apply on their next request." />
            <CardBody>
              <ActionForm action={userAccessAction}>
                <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="roles" />
                <div className="grid gap-2 sm:grid-cols-2">
                  {allRoles.map((r) => (
                    <label key={r.id} className="flex items-start gap-2 rounded-md border border-line p-2 text-[13px]">
                      <input type="checkbox" name="roleIds[]" value={r.id} defaultChecked={mine.some((m) => m.roleId === r.id)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                      <span><span className="font-medium">{r.name}</span>{r.description ? <span className="block text-[12px] text-muted">{r.description}</span> : null}</span>
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex justify-end"><SubmitButton>Save roles</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Effective permissions" description="The broadest scope across all roles wins. 'Assigned' means only records the user owns or is assigned to." />
            {effective ? (
              <CardBody>
                {PERMISSION_GROUPS.map((g) => {
                  const list = g.permissions.filter((p) => effective.grants.has(p));
                  return list.length ? (
                    <div key={g.label} className="mb-2">
                      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{g.label}</p>
                      <ul className="mt-1 space-y-0.5 text-[13px]">{list.map((p) => <li key={p} className="flex justify-between gap-2"><span>{PERMISSIONS[p]}</span><Badge tone={effective.grants.get(p) === "all" ? "success" : "warning"}>{effective.grants.get(p)}</Badge></li>)}</ul>
                    </div>
                  ) : null;
                })}
              </CardBody>
            ) : <EmptyState title="Disabled users have no permissions" />}
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Account" />
            <CardBody>
              <DefinitionList columns={1} items={[{ label: "Title", value: u.title ?? "—" }, { label: "Time zone", value: u.timeZone ?? "Agency default" }, { label: "Created", value: <DateTimeText value={u.createdAt} /> }]} />
              {!self ? (
                <ActionForm action={userAccessAction} className="mt-3">
                  <input type="hidden" name="id" value={id} />
                  {u.status === "active" ? <SubmitButton variant="danger" name="op" value="disable" confirm="Disable this user? They are signed out immediately.">Disable user</SubmitButton> : <SubmitButton variant="secondary" name="op" value="enable">Re-enable user</SubmitButton>}
                </ActionForm>
              ) : <p className="mt-3 text-[12.5px] text-muted">You cannot disable your own account.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Reset password" description="Ends all of the user's sessions. Share the new password securely; it is not emailed or recorded." />
            <CardBody>
              <ActionForm action={userAccessAction} resetOnSuccess className="space-y-2">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="password" />
                <Field label="New password"><Input type="password" name="password" minLength={12} autoComplete="new-password" required /></Field>
                <SubmitButton size="sm" variant="secondary">Reset password</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recent activity" />
            {history.length ? <ul className="divide-y divide-line text-[12.5px]">{history.map((h) => <li key={h.id} className="px-4 py-2"><span className="text-muted"><DateTimeText value={h.createdAt} /></span> · {h.summary}</li>)}</ul> : <EmptyState title="No recorded activity" />}
          </Card>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import { Fragment } from "react";
import { asc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { rolePermissions, roles, userRoles } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { PERMISSION_GROUPS, PERMISSIONS } from "@/server/auth/permissions";
import { saveRoleAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, FormGrid, Input } from "@/components/forms/fields";
import { cn } from "@/lib/utils";

export const metadata = { title: "Roles & permissions" };

export default async function RolesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("users.manage");
  const sp = await searchParams;
  const rs = await db.select({ r: roles, users: sql<number>`(select count(*) from ${userRoles} ur where ur.role_id = "roles"."id")` }).from(roles).orderBy(asc(roles.name));
  const perms = await db.select().from(rolePermissions);
  const selected = sp.role === "new" ? null : rs.find((x) => x.r.id === sp.role)?.r ?? null;
  const editing = sp.role === "new" || !!selected;
  const grantOf = (roleId: string, p: string) => perms.find((x) => x.roleId === roleId && x.permission === p)?.scope ?? null;
  return (
    <>
      <PageHeader crumbs={[{ label: "Users & Permissions" }, { label: "Roles & permissions" }]} title="Roles & permissions" description="Permissions are enforced on the server for every page, action, export, search result and file download. 'All' covers every record; 'Assigned' only records the user owns or is assigned to." actions={<Link className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm text-white hover:bg-accent-hover" href="/admin/roles?role=new">New role</Link>} />
      <Card className="mb-4 overflow-x-auto">
        <Table>
          <THead>
            <tr><TH>Permission</TH>{rs.map(({ r, users }) => <TH key={r.id} align="center"><Link className={cn("hover:underline", selected?.id === r.id && "text-accent")} href={`/admin/roles?role=${r.id}`}>{r.name}</Link><div className="font-normal normal-case text-faint">{Number(users)} user(s)</div></TH>)}</tr>
          </THead>
          <tbody>
            {PERMISSION_GROUPS.map((g) => (
              <Fragment key={g.label}>
                <TR className="bg-sunken/60"><TD colSpan={rs.length + 1} className="text-[12px] font-semibold uppercase tracking-wide text-muted">{g.label}</TD></TR>
                {g.permissions.map((p) => (
                  <TR key={p}>
                    <TD className="text-[12.5px]">{PERMISSIONS[p]}<div className="font-mono text-[11px] text-faint">{p}</div></TD>
                    {rs.map(({ r }) => { const s = grantOf(r.id, p); return <TD key={r.id} align="center">{s === "all" ? <Badge tone="success">all</Badge> : s === "assigned" ? <Badge tone="warning">assigned</Badge> : <span className="text-faint">—</span>}</TD>; })}
                  </TR>
                ))}
              </Fragment>
            ))}
          </tbody>
        </Table>
      </Card>
      {editing ? (
        selected?.key === "owner" ? <Card><CardBody><p className="text-[13px]">The Owner role always has every permission and cannot be edited. At least one active Owner must exist.</p></CardBody></Card> : (
          <Card className="max-w-4xl">
            <CardHeader title={selected ? `Edit ${selected.name}` : "New role"} description="Saving signs out everyone with this role so the change applies immediately. Every change is audited." />
            <CardBody>
              <ActionForm action={saveRoleAction}>
                {selected ? <input type="hidden" name="id" value={selected.id} /> : null}
                <FormGrid cols={2}>
                  <Field label="Name"><Input name="name" defaultValue={selected?.name} required /></Field>
                  <Field label="Description"><Input name="description" defaultValue={selected?.description ?? ""} /></Field>
                </FormGrid>
                {PERMISSION_GROUPS.map((g) => (
                  <fieldset key={g.label} className="mt-4">
                    <legend className="text-[12px] font-semibold uppercase tracking-wide text-muted">{g.label}</legend>
                    <div className="mt-1 space-y-1">
                      {g.permissions.map((p) => {
                        const cur = selected ? grantOf(selected.id, p) : null;
                        return (
                          <div key={p} className="grid grid-cols-[1fr_auto] items-center gap-2 text-[13px]">
                            <span>{PERMISSIONS[p]}</span>
                            <span className="flex gap-3">
                              {(["none", "assigned", "all"] as const).map((s) => <label key={s} className="flex items-center gap-1"><input type="radio" name={`perm.${p}`} value={s} defaultChecked={(cur ?? "none") === s} className="accent-[var(--color-accent)]" />{s}</label>)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>
                ))}
                <div className="mt-4 flex justify-end"><SubmitButton confirm="Save this role? Users with it will be signed out.">Save role</SubmitButton></div>
              </ActionForm>
            </CardBody>
          </Card>
        )
      ) : <p className="text-[13px] text-muted">Select a role name in the matrix to edit it.</p>}
    </>
  );
}

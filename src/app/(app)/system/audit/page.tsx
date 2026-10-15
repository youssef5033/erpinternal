import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { qs } from "@/lib/utils";
import { Card, EmptyState, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateTimeText, Pagination } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("audit.read");
  const sp = await searchParams;
  const conds: (SQL | undefined)[] = [];
  if (sp.q) conds.push(or(ilike(auditEvents.summary, `%${sp.q}%`), ilike(auditEvents.action, `%${sp.q}%`)));
  if (sp.entity) conds.push(eq(auditEvents.entityType, sp.entity));
  if (sp.entityId) conds.push(eq(auditEvents.entityId, sp.entityId));
  if (sp.actor) conds.push(sp.actor === "system" ? sql`${auditEvents.actorId} is null` : eq(auditEvents.actorId, sp.actor));
  if (sp.from) conds.push(sql`${auditEvents.createdAt} >= ${sp.from}::date`);
  if (sp.to) conds.push(sql`${auditEvents.createdAt} < (${sp.to}::date + 1)`);
  const where = and(...conds);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(auditEvents).where(where);
  const rows = await db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.createdAt)).limit(100).offset((page - 1) * 100);
  const entities = (await db.selectDistinct({ e: auditEvents.entityType }).from(auditEvents).orderBy(auditEvents.entityType)).map((r) => ({ value: r.e, label: r.e.replace(/_/g, " ") }));
  const users = await db.select({ value: user.id, label: user.name }).from(user).orderBy(user.name);
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Audit log" }]} title="Audit log" description="Append-only record of material changes: who, what, when. Secrets, passwords and cost-rate values are never recorded." />
      <FilterBar fields={[{ type: "search", name: "q", label: "Search", placeholder: "Summary or action" }, { type: "select", name: "entity", label: "Record type", options: entities }, { type: "select", name: "actor", label: "Who", options: [{ value: "system", label: "System" }, ...users] }, { type: "date", name: "from", label: "From" }, { type: "date", name: "to", label: "To" }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>When</TH><TH>Who</TH><TH>Action</TH><TH>Record</TH><TH>Summary</TH></tr></THead>
            <tbody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD className="whitespace-nowrap text-[12.5px]"><DateTimeText value={r.createdAt} /></TD>
                  <TD className="text-[12.5px]">{r.actorLabel}</TD>
                  <TD className="font-mono text-[12px]">{r.action}</TD>
                  <TD className="text-[12px]">{r.entityType}{r.entityId ? <div className="font-mono text-muted">{r.entityId.slice(0, 8)}</div> : null}</TD>
                  <TD className="text-[13px]">{r.summary}{r.changes && Object.keys(r.changes).length ? <details className="mt-0.5"><summary className="cursor-pointer text-[12px] text-accent">Changes</summary><pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap text-[11.5px] text-muted">{JSON.stringify(r.changes, null, 2)}</pre></details> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No events match" />}
        <Pagination page={page} pageSize={100} total={Number(total)} hrefFor={(p) => `/system/audit${qs({ ...sp, page: p })}`} />
      </Card>
    </>
  );
}

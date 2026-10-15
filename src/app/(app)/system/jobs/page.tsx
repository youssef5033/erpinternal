import { desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { jobRuns } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { JOBS } from "@/server/jobs/registry";
import { systemHealth } from "@/server/ops/dashboard";
import { runJobNowAction } from "@/server/actions/ops";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";

export const metadata = { title: "Jobs & health" };

export default async function JobsPage() {
  await guard("audit.read");
  const last = (await db.execute<{ job_name: string; status: string; started_at: string; finished_at: string | null; error: string | null }>(sql`select distinct on (job_name) job_name, status, started_at::text, finished_at::text, error from job_runs order by job_name, started_at desc`)).rows;
  const runs = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);
  const health = await systemHealth(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Jobs & health" }]} title="Jobs & health" description="Background jobs run in the worker process (npm run worker) on the schedules below. Every run is idempotent: re-running the same period cannot duplicate invoices, recognition entries or drafts." />
      <Notice className="mb-4">Full system health (signals, integrations, data quality) is on the <a className="text-accent hover:underline" href="/operations?tab=health">daily dashboard → System health</a>.</Notice>
      <Card className="mb-4">
        <CardHeader title="Scheduled jobs" />
        <Table>
          <THead><tr><TH>Job</TH><TH>Schedule (cron, UTC)</TH><TH>Last run</TH><TH>Status</TH><TH /></tr></THead>
          <tbody>
            {JOBS.map((j) => {
              const l = last.find((x) => x.job_name === j.name);
              return (
                <TR key={j.name}>
                  <TD className="font-medium">{j.label}<div className="font-mono text-[11.5px] font-normal text-muted">{j.name}</div></TD>
                  <TD className="font-mono text-[12px]">{j.cron}</TD>
                  <TD className="text-[12.5px]">{l ? <DateTimeText value={l.started_at} /> : "Never"}</TD>
                  <TD>{l ? <StatusBadge status={l.status} /> : <Badge>not run</Badge>}{l?.error ? <div className="max-w-sm text-[12px] text-danger">{l.error}</div> : null}</TD>
                  <TD align="right"><ActionForm action={runJobNowAction}><input type="hidden" name="job" value={j.name} /><SubmitButton size="sm" variant="secondary">Run now</SubmitButton></ActionForm></TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
      <Card className="mb-4">
        <CardHeader title="Recent runs" />
        {runs.length ? (
          <Table>
            <THead><tr><TH>Job</TH><TH>Started</TH><TH>Finished</TH><TH>Status</TH><TH>Triggered by</TH><TH>Result</TH></tr></THead>
            <tbody>{runs.map((r) => <TR key={r.id}><TD className="font-mono text-[12px]">{r.jobName}</TD><TD className="text-[12.5px]"><DateTimeText value={r.startedAt} /></TD><TD className="text-[12.5px]">{r.finishedAt ? <DateTimeText value={r.finishedAt} /> : "—"}</TD><TD><StatusBadge status={r.status} />{r.attempts > 1 ? <span className="ml-1 text-[12px] text-muted">{r.attempts} attempts</span> : null}</TD><TD className="text-[12px]">{r.triggeredBy ?? "schedule"}</TD><TD className="max-w-md text-[12px] text-muted">{r.error ? <span className="text-danger">{r.error}</span> : r.result ? JSON.stringify(r.result) : ""}</TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No job runs yet" description="Start the worker or run a job manually." />}
      </Card>
      <Card>
        <CardHeader title="Data quality checks" />
        <ul className="divide-y divide-line">{health.dataQuality.map((q) => <li key={q.key} className="flex items-start justify-between gap-3 px-4 py-2 text-[13px]"><span><a className="hover:underline" href={q.href}>{q.label}</a>{q.detail ? <span className="block text-[12px] text-muted">{q.detail}</span> : null}</span>{q.count ? <Badge tone="warning">{q.count}</Badge> : <Badge tone="success">0</Badge>}</li>)}</ul>
      </Card>
    </>
  );
}

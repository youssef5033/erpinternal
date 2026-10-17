import { PgBoss } from "pg-boss";
import { db } from "@/db/client";
import { pgConfig } from "@/db/connection";
import { JOBS, runJob } from "./registry";

/**
 * Schedules and executes the recurring jobs with pg-boss (PostgreSQL-backed
 * queue with retries). Each job run is idempotent via job_runs.idempotency_key
 * and the generation keys used by the jobs, so running more than one worker
 * never duplicates work.
 *
 * Used by the standalone worker (`npm run worker`) and, when JOBS_IN_WEB=true,
 * by the web server itself (src/instrumentation.ts) for single-service hosting.
 */
export async function startWorker(log: (m: string) => void = console.log): Promise<(() => Promise<void>) | null> {
  if (process.env.JOBS_ENABLED === "false") {
    log("JOBS_ENABLED=false — worker not started.");
    return null;
  }
  const { connectionString, ssl } = pgConfig();
  const boss = new PgBoss({ connectionString, ssl, schema: "pgboss", max: Number(process.env.PGBOSS_POOL_MAX ?? 10) });
  boss.on("error", (e) => console.error("[pg-boss]", e));
  await boss.start();
  for (const job of JOBS) {
    await boss.createQueue(job.name, { retryLimit: 3, retryDelay: 60, retryBackoff: true });
    await boss.schedule(job.name, job.cron, {}, { tz: "UTC" });
    await boss.work(job.name, async (jobs) => {
      for (const j of jobs) {
        const res = await runJob(db, job.name, { triggeredBy: `pg-boss:${j.id}` });
        log(`[job] ${job.name} ${res.status} ${res.key}`);
      }
    });
    log(`[worker] scheduled ${job.name} (${job.cron})`);
  }
  // Catch up after downtime (deploys, or a free instance that was asleep): run each job for the
  // current period unless it already ran. Idempotent per period, so nothing runs twice.
  void (async () => {
    for (const job of JOBS) {
      try {
        const res = await runJob(db, job.name, { triggeredBy: "startup-catch-up" });
        if (res.status === "succeeded") log(`[worker] caught up ${job.name} (${res.key})`);
      } catch (e) {
        console.error(`[worker] catch-up of ${job.name} failed`, e);
      }
    }
  })();
  return async () => {
    log("[worker] stopping…");
    await boss.stop();
  };
}

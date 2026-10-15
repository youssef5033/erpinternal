/**
 * Background worker: schedules and executes recurring jobs with pg-boss
 * (PostgreSQL-backed queue with retries). Each job run is idempotent via
 * job_runs.idempotency_key and the generation keys used by the jobs.
 *
 *   npm run worker
 */
import "dotenv/config";
import { PgBoss } from "pg-boss";
import { db, pool } from "@/db/client";
import { JOBS, runJob } from "@/server/jobs/registry";

async function main() {
  if (process.env.JOBS_ENABLED === "false") {
    console.log("JOBS_ENABLED=false — worker not started.");
    return;
  }
  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema: "pgboss" });
  boss.on("error", (e) => console.error("[pg-boss]", e));
  await boss.start();
  for (const job of JOBS) {
    await boss.createQueue(job.name, { retryLimit: 3, retryDelay: 60, retryBackoff: true });
    await boss.schedule(job.name, job.cron, {}, { tz: "UTC" });
    await boss.work(job.name, async (jobs) => {
      for (const j of jobs) {
        const res = await runJob(db, job.name, { triggeredBy: `pg-boss:${j.id}` });
        console.log(`[job] ${job.name} ${res.status} ${res.key}`);
      }
    });
    console.log(`[worker] scheduled ${job.name} (${job.cron})`);
  }
  const shutdown = async () => {
    console.log("[worker] stopping…");
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});

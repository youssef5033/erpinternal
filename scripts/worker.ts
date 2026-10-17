/**
 * Background worker process (see src/server/jobs/worker.ts).
 *
 *   npm run worker
 */
import "dotenv/config";
import { pool } from "@/db/client";
import { startWorker } from "@/server/jobs/worker";

async function main() {
  const stop = await startWorker();
  if (!stop) return;
  const shutdown = async () => {
    await stop();
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

/**
 * Runs once when the server starts. With JOBS_IN_WEB=true the web server also
 * runs the background jobs, so a single hosted service is enough. Leave it
 * unset when a separate `npm run worker` process is deployed.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.JOBS_IN_WEB !== "true") return;
  const { startWorkerInWebProcess } = await import("./server/jobs/web-worker");
  await startWorkerInWebProcess();
}

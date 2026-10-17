/**
 * Runs once when the server starts. With JOBS_IN_WEB=true the web server also
 * runs the background jobs, so a single hosted service is enough. Leave it
 * unset when a separate `npm run worker` process is deployed.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.JOBS_IN_WEB !== "true") return;
  const { startWorker } = await import("./server/jobs/worker");
  try {
    const stop = await startWorker();
    if (stop) process.once("SIGTERM", () => void stop());
  } catch (e) {
    // The app stays usable without jobs; System → Jobs shows they have not run.
    console.error("[worker] failed to start in web process", e);
  }
}

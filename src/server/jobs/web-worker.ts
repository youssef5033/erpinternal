import { startWorker } from "./worker";

/** Runs the job worker inside the web server process (JOBS_IN_WEB=true); stops it on shutdown. */
export async function startWorkerInWebProcess() {
  try {
    const stop = await startWorker();
    if (stop) process.once("SIGTERM", () => void stop());
  } catch (e) {
    // The app stays usable without jobs; System → Jobs shows they have not run.
    console.error("[worker] failed to start in web process", e);
  }
}

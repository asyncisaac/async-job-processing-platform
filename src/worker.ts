import { redis } from "./lib/queue.js";
import { startWorker } from "./workerRuntime.js";
import { initTracing } from "./lib/tracing.js";

initTracing("ajpp-worker");

const { close } = startWorker();

async function shutdown() {
  await close();
  await redis.quit();
}

process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));


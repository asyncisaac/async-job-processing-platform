import { QueueEvents, Worker } from "bullmq";
import { env } from "./config.js";
import { logger } from "./lib/logger.js";
import { redis } from "./lib/queue.js";
import type { QueueJobData } from "./services/queueJob.js";
import { processQueueJob } from "./services/jobService.js";
import { handleWorkerFailed } from "./services/retryService.js";

export function startWorker(options?: { concurrency?: number }) {
  const queueEvents = new QueueEvents(env.QUEUE_NAME, { connection: redis });

  const worker = new Worker<QueueJobData>(env.QUEUE_NAME, processQueueJob, {
    connection: redis,
    concurrency: options?.concurrency ?? env.WORKER_CONCURRENCY,
    lockDuration: env.WORKER_LOCK_DURATION_MS,
    maxStalledCount: env.WORKER_MAX_STALLED_COUNT
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const data = job.data as QueueJobData | undefined;
    const jobId = data?.jobId ?? (job.id ? String(job.id) : undefined);
    if (!jobId) return;
    await handleWorkerFailed({
      jobId,
      requestId: data?.requestId,
      traceCarrier: data?.traceCarrier,
      attempt: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      err: err instanceof Error ? err : new Error("failed")
    });
  });

  worker.on("completed", async (job) => {
    const data = job.data as QueueJobData | undefined;
    logger.info({ requestId: data?.requestId, jobId: data?.jobId ?? job.id }, "queue_job_completed");
  });

  return {
    worker,
    queueEvents,
    async close() {
      await worker.close();
      await queueEvents.close();
    }
  };
}


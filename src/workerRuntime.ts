import { Job, QueueEvents, Worker } from "bullmq";
import { env } from "./config.js";
import { logger } from "./lib/logger.js";
import { dlqQueue, jobsQueue, redis } from "./lib/queue.js";
import { jobProcessingDurationMs, jobsProcessedTotal } from "./lib/metrics.js";
import { ensureTenantExists, getTenantMaxInFlightJobs, incJobsDlq, incJobsSucceeded } from "./lib/usage.js";
import { acquireTenantPermit, releaseTenantPermit } from "./lib/tenantConcurrency.js";
import { withTimeout } from "./lib/timeout.js";
import { context, trace } from "@opentelemetry/api";
import { extractContextFromCarrier, type TraceCarrier } from "./lib/tracePropagation.js";
import {
  claimStart,
  ensureEffectOnce,
  getJobById,
  markCancelled,
  markDlq,
  markRetrying,
  markSucceeded
} from "./lib/jobRepo.js";

export type QueueJobData = { jobId: string; requestId?: string; traceCarrier?: TraceCarrier };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldFail(payload: unknown, attempt: number) {
  const p = payload as Record<string, unknown> | null;
  const failUntilAttempt = typeof p?.failUntilAttempt === "number" ? p.failUntilAttempt : undefined;
  if (typeof failUntilAttempt === "number" && attempt <= failUntilAttempt) return true;
  return false;
}

async function processJob(job: Job<QueueJobData>) {
  const jobId = job.data?.jobId;
  if (!jobId) return;

  const parentCtx = extractContextFromCarrier(job.data?.traceCarrier);
  const tracer = trace.getTracer("ajpp");
  const startedAt = Date.now();
  const attempt = job.attemptsMade + 1;
  const baseLog = logger.child({
    requestId: job.data.requestId,
    jobId,
    attempt
  });

  const record = await getJobById(jobId);
  if (!record) {
    baseLog.warn("job_not_found_in_db");
    return;
  }
  await ensureTenantExists(record.tenantId);
  const log = baseLog.child({ tenantId: record.tenantId, jobType: record.type });

  const span = tracer.startSpan(
    "job.process",
    {
      attributes: {
        "ajpp.job_id": jobId,
        "ajpp.job_type": record.type,
        "ajpp.tenant_id": record.tenantId,
        "ajpp.attempt": attempt
      }
    },
    parentCtx
  );

  const maxInFlight = await getTenantMaxInFlightJobs(record.tenantId);
  const acquired = await acquireTenantPermit(record.tenantId, maxInFlight, env.WORKER_LOCK_DURATION_MS);
  if (!acquired) {
    const jitterMs = 250 + Math.floor(Math.random() * 500);
    try {
      await job.moveToDelayed(Date.now() + jitterMs, job.token);
      log.info({ delayMs: jitterMs, maxInFlight }, "tenant_throttled_delayed");
      span.addEvent("tenant_throttled_delayed", { delay_ms: jitterMs, max_in_flight: maxInFlight });
      span.end();
      return;
    } catch {
      log.warn({ delayMs: jitterMs, maxInFlight }, "tenant_throttled_fallback");
    }
    span.recordException(new Error("tenant_throttled"));
    span.setStatus({ code: 2, message: "tenant_throttled" });
    span.end();
    throw new Error("tenant_throttled");
  }

  try {
    await context.with(parentCtx, async () => {
      await withTimeout(
        (async () => {
          if (record.cancelRequested) {
            await markCancelled(jobId);
            log.info("job_cancelled_before_start");
            span.addEvent("job_cancelled_before_start");
            span.setStatus({ code: 1 });
            return;
          }

          const claimed = await claimStart(jobId);
          if (!claimed) {
            log.info({ status: record.status }, "job_not_claimed");
            span.addEvent("job_not_claimed");
            span.setStatus({ code: 1 });
            return;
          }

          if (shouldFail(record.payload, attempt)) {
            log.warn("job_forced_failure");
            throw new Error("forced_failure");
          }

          const shouldExecuteEffect = await ensureEffectOnce(jobId);
          if (shouldExecuteEffect) {
            log.info("side_effect_start");
            await sleep(10);
            log.info("side_effect_done");
          } else {
            log.info("side_effect_skipped_idempotent");
          }

          const durationMs = Date.now() - startedAt;
          jobsProcessedTotal.inc({ type: record.type, result: "succeeded" });
          jobProcessingDurationMs.observe({ type: record.type, result: "succeeded" }, durationMs);
          await markSucceeded(jobId, durationMs);
          await incJobsSucceeded(record.tenantId);
          log.info({ durationMs }, "job_succeeded");
          span.setAttribute("ajpp.duration_ms", durationMs);
          span.setStatus({ code: 1 });
        })(),
        env.JOB_TIMEOUT_MS
      );
    });
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: 2, message: (err as Error)?.message });
    throw err;
  } finally {
    await releaseTenantPermit(record.tenantId);
    span.end();
  }
}

export function startWorker(options?: { concurrency?: number }) {
  const queueEvents = new QueueEvents(env.QUEUE_NAME, { connection: redis });

  const worker = new Worker<QueueJobData>(env.QUEUE_NAME, processJob, {
    connection: redis,
    concurrency: options?.concurrency ?? env.WORKER_CONCURRENCY,
    lockDuration: env.WORKER_LOCK_DURATION_MS,
    maxStalledCount: env.WORKER_MAX_STALLED_COUNT
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const data = job.data as QueueJobData | undefined;
    const jobId = data?.jobId ?? job.id;
    const attempt = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 1;

    const baseLog = logger.child({
      requestId: data?.requestId,
      jobId,
      attempt
    });

    if (jobId) {
      const message = err instanceof Error ? err.message : "failed";
      const record = await getJobById(jobId);
      const type = record?.type ?? "unknown";
      const log = baseLog.child({ tenantId: record?.tenantId, jobType: type });
      const parentCtx = extractContextFromCarrier(data?.traceCarrier);
      const tracer = trace.getTracer("ajpp");
      const span = tracer.startSpan(
        "job.failed",
        {
          attributes: {
            "ajpp.job_id": jobId,
            "ajpp.job_type": type,
            "ajpp.tenant_id": record?.tenantId,
            "ajpp.attempt": attempt
          }
        },
        parentCtx
      );
      span.recordException(err);
      span.setStatus({ code: 2, message });
      try {
        if (attempt < maxAttempts) {
        await markRetrying(jobId, attempt, message);
        jobsProcessedTotal.inc({ type, result: "failed_retrying" });
        log.warn({ err: message }, "job_failed_retrying");
        span.addEvent("job_retrying");
        } else {
        jobsProcessedTotal.inc({ type, result: "dlq" });
        await markDlq(jobId, attempt, message);
        if (record) {
          await ensureTenantExists(record.tenantId);
          await incJobsDlq(record.tenantId);
        }
        try {
          await dlqQueue.add(
            "dlq",
            { jobId, requestId: data?.requestId, traceCarrier: data?.traceCarrier },
            { jobId, removeOnComplete: false, removeOnFail: false }
          );
        } catch {}
        log.error({ err: message }, "job_dlq");
        span.addEvent("job_dlq");

        if (job.id) {
          try {
            const jq = await jobsQueue.getJob(job.id);
            if (jq) await jq.remove();
          } catch {}
        }
        }
      } finally {
        span.end();
      }
    }
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


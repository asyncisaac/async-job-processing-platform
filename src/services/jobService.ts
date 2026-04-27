import { Job } from "bullmq";
import { context, trace } from "@opentelemetry/api";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { jobProcessingDurationMs, jobsProcessedTotal } from "../lib/metrics.js";
import { dlqQueue, jobsQueue } from "../lib/queue.js";
import { getJobTypeConfig } from "../lib/jobTypes.js";
import { extractContextFromCarrier, injectTraceCarrier, type TraceCarrier } from "../lib/tracePropagation.js";
import { acquireTenantPermit, releaseTenantPermit } from "../lib/tenantConcurrency.js";
import { withTimeout } from "../lib/timeout.js";
import { ensureTenantExists, getTenantMaxInFlightJobs, incJobsDlq, incJobsEnqueued, incJobsSucceeded } from "../lib/usage.js";
import { claimStart, ensureEffectOnce, getJobById, markCancelled, markDlq, markEnqueued, markSucceeded } from "../lib/jobRepo.js";
import type { QueueJobData } from "./queueJob.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldFail(payload: unknown, attempt: number) {
  const p = payload as Record<string, unknown> | null;
  const failUntilAttempt = typeof p?.failUntilAttempt === "number" ? p.failUntilAttempt : undefined;
  if (typeof failUntilAttempt === "number" && attempt <= failUntilAttempt) return true;
  return false;
}

export async function enqueueJob(input: {
  tenantId: string;
  job: { id: string; type: string; payloadHash: string; maxAttempts: number };
  requestId?: string;
  priority?: number;
  delayMs?: number;
  spanName?: string;
  parentTraceCarrier?: TraceCarrier;
}) {
  const cfg = getJobTypeConfig(input.job.type);
  const parentCtx = input.parentTraceCarrier ? extractContextFromCarrier(input.parentTraceCarrier) : context.active();
  const tracer = trace.getTracer("ajpp");
  const span = tracer.startSpan(
    input.spanName ?? "job.enqueue",
    {
      attributes: {
        "ajpp.job_id": input.job.id,
        "ajpp.job_type": input.job.type,
        "ajpp.tenant_id": input.tenantId
      }
    },
    parentCtx
  );

  try {
    const traceCarrier = await context.with(trace.setSpan(parentCtx, span), async () =>
      input.parentTraceCarrier ?? injectTraceCarrier()
    );

    await jobsQueue.add(
      "job",
      { jobId: input.job.id, requestId: input.requestId, traceCarrier },
      {
        jobId: input.job.id,
        attempts: cfg.maxAttempts,
        backoff: { type: "exponential", delay: cfg.backoffBaseMs, jitter: 0.2 },
        deduplication: {
          id: `${input.tenantId}:${input.job.payloadHash}`,
          ttl: env.JOB_DEDUP_TTL_MS,
          keepLastIfActive: true
        },
        priority: input.priority,
        delay: input.delayMs,
        removeOnComplete: true,
        removeOnFail: true
      }
    );

    await markEnqueued(input.job.id, { traceCarrier });
    await incJobsEnqueued(input.tenantId);
    span.setStatus({ code: 1 });
    return { traceCarrier };
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: 2, message: (err as Error)?.message });
    throw err;
  } finally {
    span.end();
  }
}

export async function processQueueJob(job: Job<QueueJobData>) {
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

export async function moveToDlq(input: { jobId: string; requestId?: string; traceCarrier?: TraceCarrier }) {
  try {
    await dlqQueue.add("dlq", input, { jobId: input.jobId, removeOnComplete: false, removeOnFail: false });
  } catch {}
}

export async function cleanupMainQueueJob(jobId: string) {
  try {
    const jq = await jobsQueue.getJob(jobId);
    if (jq) await jq.remove();
  } catch {}
}

export async function markJobDlqFromWorker(input: { jobId: string; attempt: number; message: string }) {
  const record = await getJobById(input.jobId);
  await markDlq(input.jobId, input.attempt, input.message);
  if (record) {
    await ensureTenantExists(record.tenantId);
    await incJobsDlq(record.tenantId);
  }
  jobsProcessedTotal.inc({ type: record?.type ?? "unknown", result: "dlq" });
}


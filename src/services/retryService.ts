import { trace } from "@opentelemetry/api";
import { logger } from "../lib/logger.js";
import { dlqQueue, jobsQueue } from "../lib/queue.js";
import { addJobEvent, getJobById, getLastJobTraceCarrier, markRetrying, resetForManualRetry } from "../lib/jobRepo.js";
import { extractContextFromCarrier, type TraceCarrier } from "../lib/tracePropagation.js";
import { jobsProcessedTotal } from "../lib/metrics.js";
import { assertDlqReplayAllowed, assertManualRetryAllowed } from "./jobState.js";
import { ServiceError } from "./serviceError.js";
import { cleanupMainQueueJob, enqueueJob, markJobDlqFromWorker, moveToDlq } from "./jobService.js";

export async function manualRetryJob(input: { tenantId: string; jobId: string; requestId?: string }) {
  const job = await getJobById(input.jobId);
  if (!job || job.tenantId !== input.tenantId) throw new ServiceError("not_found", 404);
  assertManualRetryAllowed(job);

  const existing = await jobsQueue.getJob(input.jobId);
  if (existing) {
    try {
      await existing.remove();
    } catch {}
  }

  const existingDlq = await dlqQueue.getJob(input.jobId);
  if (existingDlq) {
    try {
      await existingDlq.remove();
    } catch {}
  }

  await resetForManualRetry(input.jobId);

  const existingCarrier = await getLastJobTraceCarrier(input.jobId);
  const parentCtx = extractContextFromCarrier(existingCarrier);
  const tracer = trace.getTracer("ajpp");
  const span = tracer.startSpan(
    "job.retry_manual",
    {
      attributes: {
        "ajpp.job_id": input.jobId,
        "ajpp.job_type": job.type,
        "ajpp.tenant_id": input.tenantId
      }
    },
    parentCtx
  );

  try {
    const { traceCarrier } = await enqueueJob({
      tenantId: input.tenantId,
      job: { id: input.jobId, type: job.type, payloadHash: job.payloadHash, maxAttempts: job.maxAttempts },
      requestId: input.requestId,
      spanName: "job.enqueue",
      parentTraceCarrier: existingCarrier ?? undefined
    });
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

export async function replayDlqJob(input: { tenantId: string; jobId: string; requestId?: string }) {
  const job = await getJobById(input.jobId);
  if (!job || job.tenantId !== input.tenantId) throw new ServiceError("not_found", 404);
  assertDlqReplayAllowed(job);

  const existingDlq = await dlqQueue.getJob(input.jobId);
  if (existingDlq) {
    try {
      await existingDlq.remove();
    } catch {}
  }

  const existing = await jobsQueue.getJob(input.jobId);
  if (existing) {
    try {
      await existing.remove();
    } catch {}
  }

  await resetForManualRetry(input.jobId);

  const existingCarrier = await getLastJobTraceCarrier(input.jobId);
  const parentCtx = extractContextFromCarrier(existingCarrier);
  const tracer = trace.getTracer("ajpp");
  const span = tracer.startSpan(
    "job.dlq_replay",
    {
      attributes: {
        "ajpp.job_id": input.jobId,
        "ajpp.job_type": job.type,
        "ajpp.tenant_id": input.tenantId
      }
    },
    parentCtx
  );

  try {
    const { traceCarrier } = await enqueueJob({
      tenantId: input.tenantId,
      job: { id: input.jobId, type: job.type, payloadHash: job.payloadHash, maxAttempts: job.maxAttempts },
      requestId: input.requestId,
      spanName: "job.enqueue",
      parentTraceCarrier: existingCarrier ?? undefined
    });
    await addJobEvent(input.jobId, "job_dlq_replayed", { traceCarrier });
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

export async function handleWorkerFailed(input: {
  jobId: string;
  requestId?: string;
  traceCarrier?: TraceCarrier;
  attempt: number;
  maxAttempts: number;
  err: Error;
}) {
  const message = input.err instanceof Error ? input.err.message : "failed";
  const record = await getJobById(input.jobId);
  const type = record?.type ?? "unknown";
  const log = logger.child({ requestId: input.requestId, jobId: input.jobId, attempt: input.attempt, tenantId: record?.tenantId, jobType: type });

  const parentCtx = extractContextFromCarrier(input.traceCarrier);
  const tracer = trace.getTracer("ajpp");
  const span = tracer.startSpan(
    "job.failed",
    {
      attributes: {
        "ajpp.job_id": input.jobId,
        "ajpp.job_type": type,
        "ajpp.tenant_id": record?.tenantId,
        "ajpp.attempt": input.attempt
      }
    },
    parentCtx
  );

  span.recordException(input.err);
  span.setStatus({ code: 2, message });

  try {
    if (input.attempt < input.maxAttempts) {
      await markRetrying(input.jobId, input.attempt, message);
      jobsProcessedTotal.inc({ type, result: "failed_retrying" });
      log.warn({ err: message }, "job_failed_retrying");
      span.addEvent("job_retrying");
      return;
    }

    await markJobDlqFromWorker({ jobId: input.jobId, attempt: input.attempt, message });
    await moveToDlq({ jobId: input.jobId, requestId: input.requestId, traceCarrier: input.traceCarrier });
    log.error({ err: message }, "job_dlq");
    span.addEvent("job_dlq");
    await cleanupMainQueueJob(input.jobId);
  } finally {
    span.end();
  }
}


import { JobStatus, Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { getJobTypeConfig } from "./jobTypes.js";
import { sha256, stableStringify } from "./hash.js";

export type CreateJobInput = {
  tenantId: string;
  type: string;
  payload: unknown;
  idempotencyKey: string;
};

export async function getJobById(id: string) {
  return prisma.job.findUnique({ where: { id } });
}

export async function getJobByIdForTenant(tenantId: string, id: string) {
  return prisma.job.findFirst({ where: { id, tenantId } });
}

export async function listJobsForTenant(input: {
  tenantId: string;
  limit: number;
  status?: JobStatus;
  idempotencyKey?: string;
}) {
  return prisma.job.findMany({
    where: {
      tenantId: input.tenantId,
      status: input.status,
      idempotencyKey: input.idempotencyKey
    },
    take: input.limit,
    orderBy: { createdAt: "desc" }
  });
}

export async function createJobIdempotent(input: CreateJobInput) {
  const payloadStr = stableStringify(input.payload);
  const payloadHash = sha256(payloadStr);
  const cfg = getJobTypeConfig(input.type);

  try {
    const job = await prisma.job.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        status: JobStatus.queued,
        maxAttempts: cfg.maxAttempts,
        payload: input.payload as Prisma.InputJsonValue,
        payloadHash,
        idempotencyKey: input.idempotencyKey
      }
    });
    return { job, created: true };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const job = await prisma.job.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey
          }
        }
      });
      if (!job) throw err;
      if (job.payloadHash !== payloadHash) {
        const conflict = new Error("idempotency_key_conflict");
        (conflict as unknown as { statusCode?: number }).statusCode = 409;
        throw conflict;
      }
      return { job, created: false };
    }
    throw err;
  }
}

export async function addJobEvent(jobId: string, type: string, data?: unknown) {
  await prisma.jobEvent.create({
    data: {
      jobId,
      type,
      data: data as Prisma.InputJsonValue | undefined
    }
  });
}

export async function markEnqueued(jobId: string, data?: unknown) {
  await prisma.$transaction([
    prisma.job.updateMany({
      where: { id: jobId, status: JobStatus.queued },
      data: { status: JobStatus.queued }
    }),
    prisma.jobEvent.create({
      data: {
        jobId,
        type: "job_enqueued",
        data: data as Prisma.InputJsonValue | undefined
      }
    })
  ]);
}

export async function getLastJobTraceCarrier(jobId: string) {
  const ev = await prisma.jobEvent.findFirst({
    where: {
      jobId,
      data: { not: Prisma.DbNull }
    },
    orderBy: { ts: "desc" },
    select: { data: true }
  });

  const data = ev?.data as unknown;
  if (!data || typeof data !== "object") return undefined;
  const carrier = (data as Record<string, unknown>).traceCarrier;
  if (!carrier || typeof carrier !== "object") return undefined;

  const record = carrier as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function markEnqueueFailed(jobId: string, errorMessage: string) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.enqueue_failed, lastError: errorMessage }
    }),
    prisma.jobEvent.create({
      data: {
        jobId,
        type: "job_failed",
        data: { stage: "enqueue", error: errorMessage } as Prisma.InputJsonValue
      }
    })
  ]);
}

export async function requestCancel(jobId: string) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { cancelRequested: true, status: JobStatus.cancel_requested }
    }),
    prisma.jobEvent.create({
      data: { jobId, type: "job_cancel_requested" }
    })
  ]);
}

export async function markCancelled(jobId: string) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.cancelled, cancelRequested: true, finishedAt: new Date() }
    }),
    prisma.jobEvent.create({
      data: { jobId, type: "job_cancelled" }
    })
  ]);
}

export async function claimStart(jobId: string) {
  const res = await prisma.job.updateMany({
    where: {
      id: jobId,
      status: { in: [JobStatus.queued, JobStatus.retrying] },
      cancelRequested: false
    },
    data: { status: JobStatus.started, attempts: { increment: 1 }, startedAt: new Date() }
  });

  if (res.count === 0) return false;

  await prisma.jobEvent.create({
    data: { jobId, type: "job_started" }
  });
  return true;
}

export async function markSucceeded(jobId: string, durationMs?: number) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.succeeded,
        finishedAt: new Date(),
        durationMs: typeof durationMs === "number" ? durationMs : undefined
      }
    }),
    prisma.jobEvent.create({
      data: { jobId, type: "job_succeeded" }
    })
  ]);
}

export async function markRetrying(jobId: string, attempt: number, errorMessage: string) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: { status: JobStatus.retrying, lastError: errorMessage }
    }),
    prisma.jobEvent.create({
      data: {
        jobId,
        type: "job_failed",
        data: { attempt, error: errorMessage } as Prisma.InputJsonValue
      }
    }),
    prisma.jobEvent.create({
      data: {
        jobId,
        type: "job_retried",
        data: { nextAttempt: attempt + 1 } as Prisma.InputJsonValue
      }
    })
  ]);
}

export async function markDlq(jobId: string, attempt: number, errorMessage: string, durationMs?: number) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.dlq,
        lastError: errorMessage,
        finishedAt: new Date(),
        durationMs: typeof durationMs === "number" ? durationMs : undefined
      }
    }),
    prisma.jobEvent.create({
      data: {
        jobId,
        type: "job_failed",
        data: { attempt, error: errorMessage } as Prisma.InputJsonValue
      }
    }),
    prisma.jobEvent.create({
      data: { jobId, type: "job_dlq" }
    })
  ]);
}

export async function ensureEffectOnce(jobId: string) {
  try {
    await prisma.jobEffect.create({ data: { jobId } });
    return true;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return false;
    }
    throw err;
  }
}

export async function resetForManualRetry(jobId: string) {
  await prisma.$transaction([
    prisma.job.update({
      where: { id: jobId },
      data: {
        status: JobStatus.queued,
        attempts: 0,
        lastError: null,
        cancelRequested: false,
        startedAt: null,
        finishedAt: null,
        durationMs: null
      }
    }),
    prisma.jobEvent.create({
      data: { jobId, type: "job_retried_manual" }
    })
  ]);
}

export async function getJobStatsForTenant(tenantId: string) {
  const byStatus = await prisma.job.groupBy({
    by: ["status"],
    where: { tenantId },
    _count: { _all: true }
  });

  const avgDuration = await prisma.job.aggregate({
    where: { tenantId, durationMs: { not: null } },
    _avg: { durationMs: true }
  });

  return {
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
    avgDurationMs: avgDuration._avg.durationMs ?? null
  };
}


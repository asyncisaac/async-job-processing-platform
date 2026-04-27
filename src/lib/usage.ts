import { TenantPlan } from "@prisma/client";
import { prisma } from "./prisma.js";

function todayUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const planLimits: Record<TenantPlan, { requestsPerDay: number; jobsPerDay: number; maxInFlightJobs: number }> = {
  free: { requestsPerDay: 2000, jobsPerDay: 500, maxInFlightJobs: 2 },
  pro: { requestsPerDay: 100000, jobsPerDay: 20000, maxInFlightJobs: 20 }
};

const planCache = new Map<string, { plan: TenantPlan; expiresAt: number }>();

export async function getTenantPlan(tenantId: string) {
  const cached = planCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.plan;
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
  const plan = tenant?.plan ?? "free";
  planCache.set(tenantId, { plan, expiresAt: Date.now() + 60_000 });
  return plan;
}

export async function getTenantMaxInFlightJobs(tenantId: string) {
  const plan = await getTenantPlan(tenantId);
  return planLimits[plan].maxInFlightJobs;
}

export async function ensureTenantExists(tenantId: string) {
  await prisma.tenant.upsert({
    where: { id: tenantId },
    create: { id: tenantId, plan: "free" },
    update: {}
  });
}

export async function checkAndIncRequests(tenantId: string) {
  const day = todayUtc();
  const plan = await getTenantPlan(tenantId);
  const limit = planLimits[plan].requestsPerDay;

  const usage = await prisma.tenantUsageDaily.findUnique({
    where: { tenantId_day: { tenantId, day } },
    select: { requestsCount: true }
  });

  if ((usage?.requestsCount ?? 0) >= limit) {
    return { allowed: false, limit, used: usage?.requestsCount ?? 0 };
  }

  await prisma.tenantUsageDaily.upsert({
    where: { tenantId_day: { tenantId, day } },
    create: { tenantId, day, requestsCount: 1 },
    update: { requestsCount: { increment: 1 } }
  });

  return { allowed: true, limit, used: (usage?.requestsCount ?? 0) + 1 };
}

export async function checkJobsEnqueuedLimit(tenantId: string) {
  const day = todayUtc();
  const plan = await getTenantPlan(tenantId);
  const limit = planLimits[plan].jobsPerDay;

  const usage = await prisma.tenantUsageDaily.findUnique({
    where: { tenantId_day: { tenantId, day } },
    select: { jobsEnqueued: true }
  });

  if ((usage?.jobsEnqueued ?? 0) >= limit) {
    return { allowed: false, limit, used: usage?.jobsEnqueued ?? 0 };
  }

  return { allowed: true, limit, used: usage?.jobsEnqueued ?? 0 };
}

export async function incJobsEnqueued(tenantId: string) {
  const day = todayUtc();
  await prisma.tenantUsageDaily.upsert({
    where: { tenantId_day: { tenantId, day } },
    create: { tenantId, day, jobsEnqueued: 1 },
    update: { jobsEnqueued: { increment: 1 } }
  });
}

export async function incJobsSucceeded(tenantId: string) {
  const day = todayUtc();
  await prisma.tenantUsageDaily.upsert({
    where: { tenantId_day: { tenantId, day } },
    create: { tenantId, day, jobsSucceeded: 1 },
    update: { jobsSucceeded: { increment: 1 } }
  });
}

export async function incJobsDlq(tenantId: string) {
  const day = todayUtc();
  await prisma.tenantUsageDaily.upsert({
    where: { tenantId_day: { tenantId, day } },
    create: { tenantId, day, jobsDlq: 1 },
    update: { jobsDlq: { increment: 1 } }
  });
}


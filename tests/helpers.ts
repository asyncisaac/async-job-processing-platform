import { prisma } from "../src/lib/prisma.js";
import { dlqQueue, jobsQueue, redis } from "../src/lib/queue.js";

export async function resetDb() {
  await prisma.$transaction([
    prisma.tenantUsageDaily.deleteMany(),
    prisma.jobEvent.deleteMany(),
    prisma.jobEffect.deleteMany(),
    prisma.job.deleteMany()
  ]);
}

export async function resetQueues() {
  try {
    await redis.flushdb();
  } catch {}
  for (const q of [jobsQueue, dlqQueue]) {
    const anyQ = q as unknown as { obliterate?: (args: { force: boolean }) => Promise<void> };
    if (typeof anyQ.obliterate === "function") {
      try {
        await anyQ.obliterate({ force: true });
        continue;
      } catch {}
    }

    try {
      await q.drain(true);
    } catch {}

    for (const type of ["completed", "failed", "delayed", "wait", "active", "paused"] as const) {
      try {
        await q.clean(0, 1000, type);
      } catch {}
    }
  }
}

export async function waitFor(
  fn: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number }
) {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 50;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("timeout_waiting");
}


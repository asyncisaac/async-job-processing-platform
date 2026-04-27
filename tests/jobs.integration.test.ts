import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { dlqQueue, jobsQueue, redis } from "../src/lib/queue.js";
import { resetDb, resetQueues, waitFor } from "./helpers.js";
import { startWorker } from "../src/workerRuntime.js";
import { sha256, stableStringify } from "../src/lib/hash.js";
import { JobStatus, Prisma } from "@prisma/client";
import { createApiKey } from "../src/lib/auth.js";

const TENANT_ID = "tenant_test";
const API_KEYS: Record<string, string> = {};

beforeAll(async () => {
  await prisma.$connect();
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    create: { id: TENANT_ID, plan: "pro" },
    update: { plan: "pro" }
  });

  const keys = await prisma.apiKey.findMany({ where: { tenantId: TENANT_ID } });
  if (keys.length === 0) {
    const baseScopes = ["jobs:write", "jobs:read", "jobs:admin", "keys:admin", "metrics:read"];
    API_KEYS.success = (await createApiKey({ tenantId: TENANT_ID, name: "success", scopes: baseScopes })).apiKey;
    API_KEYS.retry = (await createApiKey({ tenantId: TENANT_ID, name: "retry", scopes: baseScopes })).apiKey;
    API_KEYS.dlq = (await createApiKey({ tenantId: TENANT_ID, name: "dlq", scopes: baseScopes })).apiKey;
    API_KEYS.idem = (await createApiKey({ tenantId: TENANT_ID, name: "idem", scopes: baseScopes })).apiKey;
    API_KEYS.rate = (await createApiKey({ tenantId: TENANT_ID, name: "rate", scopes: baseScopes })).apiKey;
  } else {
    // If keys already exist, create fresh deterministic set for this run
    const baseScopes = ["jobs:write", "jobs:read", "jobs:admin", "keys:admin", "metrics:read"];
    API_KEYS.success = (await createApiKey({ tenantId: TENANT_ID, name: "success", scopes: baseScopes })).apiKey;
    API_KEYS.retry = (await createApiKey({ tenantId: TENANT_ID, name: "retry", scopes: baseScopes })).apiKey;
    API_KEYS.dlq = (await createApiKey({ tenantId: TENANT_ID, name: "dlq", scopes: baseScopes })).apiKey;
    API_KEYS.idem = (await createApiKey({ tenantId: TENANT_ID, name: "idem", scopes: baseScopes })).apiKey;
    API_KEYS.rate = (await createApiKey({ tenantId: TENANT_ID, name: "rate", scopes: baseScopes })).apiKey;
  }
});

beforeEach(async () => {
  await resetQueues();
  await resetDb();
});

afterAll(async () => {
  await resetQueues();
  await resetDb();
  await prisma.$disconnect();
  await redis.quit();
});

describe("async job processing", () => {
  it("sucesso direto", async () => {
    const runtime = startWorker({ concurrency: 1 });
    const app = createApp();

    const res = await request(app).post("/jobs").set("x-api-key", API_KEYS.success).send({
      type: "order.process:v1",
      payload: { any: "value" },
      idempotencyKey: "k_sucesso"
    });

    expect(res.status).toBe(201);
    const jobId = res.body.id as string;

    await waitFor(async () => {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      return job?.status === JobStatus.succeeded;
    });

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    expect(job?.attempts).toBe(1);

    const effect = await prisma.jobEffect.findUnique({ where: { jobId } });
    expect(effect).not.toBeNull();

    await runtime.close();
  });

  it("falha → retry → sucesso", async () => {
    const runtime = startWorker({ concurrency: 1 });
    const app = createApp();

    const res = await request(app).post("/jobs").set("x-api-key", API_KEYS.retry).send({
      type: "order.process:v1",
      payload: { failUntilAttempt: 1 },
      idempotencyKey: "k_retry_sucesso"
    });

    expect(res.status).toBe(201);
    const jobId = res.body.id as string;

    await waitFor(async () => {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      return job?.status === JobStatus.succeeded;
    });

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    expect(job?.attempts).toBe(2);

    const events = await prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { ts: "asc" }
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("job_failed");
    expect(types).toContain("job_retried");
    expect(types).toContain("job_succeeded");

    await runtime.close();
  });

  it("falha repetida → DLQ", async () => {
    const runtime = startWorker({ concurrency: 1 });
    const app = createApp();

    const res = await request(app).post("/jobs").set("x-api-key", API_KEYS.dlq).send({
      type: "test.failfast:v1",
      payload: { failUntilAttempt: 99 },
      idempotencyKey: "k_dlq"
    });

    expect(res.status).toBe(201);
    const jobId = res.body.id as string;

    await waitFor(async () => {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      return job?.status === JobStatus.dlq;
    });

    const dlq = await dlqQueue.getJob(jobId);
    expect(dlq).not.toBeNull();

    const hasDlqEvent = await prisma.jobEvent.count({
      where: { jobId, type: "job_dlq" }
    });
    expect(hasDlqEvent).toBe(1);

    await runtime.close();
  });

  it("idempotência: mesma idempotencyKey não duplica", async () => {
    const runtime = startWorker({ concurrency: 1 });
    const app = createApp();

    const first = await request(app).post("/jobs").set("x-api-key", API_KEYS.idem).send({
      type: "order.process:v1",
      payload: { any: "value" },
      idempotencyKey: "k_idemp"
    });
    expect(first.status).toBe(201);
    const jobId = first.body.id as string;

    const second = await request(app).post("/jobs").set("x-api-key", API_KEYS.idem).send({
      type: "order.process:v1",
      payload: { any: "value" },
      idempotencyKey: "k_idemp"
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(jobId);

    const jobCount = await prisma.job.count();
    expect(jobCount).toBe(1);

    const enqueuedEvents = await prisma.jobEvent.count({
      where: { jobId, type: "job_enqueued" }
    });
    expect(enqueuedEvents).toBe(1);

    await runtime.close();
  });

  it("concorrência: 2 workers, 1 job processado uma vez", async () => {
    const w1 = startWorker({ concurrency: 1 });
    const w2 = startWorker({ concurrency: 1 });

    const payload = { any: "value" };
    const payloadHash = sha256(stableStringify(payload));

    const job = await prisma.job.create({
      data: {
        tenantId: TENANT_ID,
        type: "order.process:v1",
        status: JobStatus.queued,
        maxAttempts: 3,
        payload: payload as Prisma.InputJsonValue,
        payloadHash,
        idempotencyKey: "k_concorrencia"
      }
    });

    await prisma.jobEvent.create({
      data: { jobId: job.id, type: "job_enqueued" }
    });

    await jobsQueue.add("job", { jobId: job.id }, { jobId: `${job.id}-a`, removeOnComplete: true, removeOnFail: true });
    await jobsQueue.add("job", { jobId: job.id }, { jobId: `${job.id}-b`, removeOnComplete: true, removeOnFail: true });

    await waitFor(async () => {
      const fresh = await prisma.job.findUnique({ where: { id: job.id } });
      return fresh?.status === JobStatus.succeeded;
    });

    const effects = await prisma.jobEffect.count({ where: { jobId: job.id } });
    expect(effects).toBe(1);

    const succeededEvents = await prisma.jobEvent.count({
      where: { jobId: job.id, type: "job_succeeded" }
    });
    expect(succeededEvents).toBe(1);

    await w1.close();
    await w2.close();
  });

  it("unauthorized sem API key", async () => {
    const app = createApp();
    const res = await request(app).post("/jobs").send({
      type: "order.process:v1",
      payload: { any: "value" },
      idempotencyKey: "k_unauth"
    });
    expect(res.status).toBe(401);
  });

  it("rate limiting por API key", async () => {
    const app = createApp();
    for (let i = 0; i < 5; i++) {
      const r = await request(app).get("/jobs").set("x-api-key", API_KEYS.rate);
      expect(r.status).toBe(200);
    }
    const limited = await request(app).get("/jobs").set("x-api-key", API_KEYS.rate);
    expect(limited.status).toBe(429);
  });

  it("metrics protegido e expõe Prometheus", async () => {
    const app = createApp();
    const unauth = await request(app).get("/metrics");
    expect(unauth.status).toBe(401);

    const ok = await request(app).get("/metrics").set("x-metrics-token", "test-metrics-token");
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("http_requests_total");
  });

  it("CRUD básico de API key: cria e revoga", async () => {
    const app = createApp();
    const created = await request(app)
      .post("/api-keys")
      .set("x-api-key", API_KEYS.success)
      .send({ name: "temp", scopes: ["jobs:read"] });
    expect(created.status).toBe(201);
    expect(String(created.body.apiKey)).toContain("ak_");
    const newKey = created.body.apiKey as string;
    const id = created.body.id as string;

    const okRead = await request(app).get("/jobs").set("x-api-key", newKey);
    expect(okRead.status).toBe(200);

    const revoke = await request(app).post(`/api-keys/${id}/revoke`).set("x-api-key", API_KEYS.success);
    expect(revoke.status).toBe(200);

    const denied = await request(app).get("/jobs").set("x-api-key", newKey);
    expect(denied.status).toBe(401);
  });
});


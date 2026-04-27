import crypto from "node:crypto";
import express, { type RequestHandler } from "express";
import { IncomingMessage, ServerResponse } from "node:http";
import * as pinoHttpModule from "pino-http";
import { z } from "zod";
import { logger } from "./lib/logger.js";
import { jobsQueue } from "./lib/queue.js";
import {
  createJobIdempotent,
  getJobByIdForTenant,
  getJobStatsForTenant,
  listJobsForTenant,
  markCancelled,
  markEnqueueFailed,
  requestCancel
} from "./lib/jobRepo.js";
import { authenticateApiKey, checkMetricsToken, createApiKey, revokeApiKey } from "./lib/auth.js";
import { rateLimit } from "./lib/rateLimit.js";
import { env } from "./config.js";
import { metricsHandler, metricsMiddleware } from "./lib/metrics.js";
import { JobStatus } from "@prisma/client";
import { hasScope } from "./lib/scopes.js";
import { prisma } from "./lib/prisma.js";
import { checkAndIncRequests, checkJobsEnqueuedLimit, ensureTenantExists } from "./lib/usage.js";
import { enqueueJob } from "./services/jobService.js";
import { ServiceError } from "./services/serviceError.js";
import { manualRetryJob, replayDlqJob } from "./services/retryService.js";

const pinoHttp =
  (pinoHttpModule as unknown as { default?: typeof pinoHttpModule }).default ?? (pinoHttpModule as unknown as any);

export function createApp() {
  const app = express();

  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existing = req.headers["x-request-id"];
        const id = typeof existing === "string" && existing.length > 0 ? existing : crypto.randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      customProps: (req: IncomingMessage) => {
        const r = req as unknown as { tenantId?: string; apiKeyId?: string };
        return { tenantId: r.tenantId, apiKeyId: r.apiKeyId };
      }
    })
  );
  app.use(metricsMiddleware);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/metrics", (req, res, next) => {
    const token =
      (typeof req.headers["x-metrics-token"] === "string" && req.headers["x-metrics-token"]) ||
      (typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ")
        ? req.headers.authorization.slice("Bearer ".length)
        : undefined);
    if (checkMetricsToken(token)) return metricsHandler(req, res, next);
    const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    authenticateApiKey(apiKey)
      .then((ctx) => {
        if (!ctx) return res.status(401).json({ error: "unauthorized" });
        if (!hasScope(ctx.apiKeyScopes, "metrics:read")) return res.status(403).json({ error: "forbidden" });
        return metricsHandler(req, res, next);
      })
      .catch(() => res.status(401).json({ error: "unauthorized" }));
  });

  app.use(
    rateLimit({
      prefix: "ip",
      max: env.RATE_LIMIT_MAX_PER_IP,
      getId: (req) => req.ip || null
    })
  );

  const authMiddleware: RequestHandler = (req, res, next) => {
    const apiKey = typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined;
    authenticateApiKey(apiKey)
      .then(async (ctx) => {
        if (!ctx) return res.status(401).json({ error: "unauthorized" });
        req.apiKey = ctx.apiKey;
        req.apiKeyId = ctx.apiKeyId;
        req.apiKeyScopes = ctx.apiKeyScopes;
        req.tenantId = ctx.tenantId;
        await ensureTenantExists(req.tenantId);
        const usage = await checkAndIncRequests(req.tenantId);
        if (!usage.allowed) return res.status(429).json({ error: "plan_limit", limit: usage.limit });
        return next();
      })
      .catch(() => res.status(401).json({ error: "unauthorized" }));
  };

  app.use(["/jobs", "/dlq", "/api-keys"], authMiddleware);

  app.use(
    ["/jobs", "/dlq", "/api-keys"],
    rateLimit({
      prefix: "key",
      max: env.RATE_LIMIT_MAX_PER_KEY,
      getId: (req) => req.apiKeyId ?? null
    })
  );

  const createJobBody = z.object({
    type: z.string().min(1),
    payload: z.unknown(),
    idempotencyKey: z.string().min(1),
    priority: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional()
  });

  const createApiKeyBody = z.object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.string().min(1)).min(1).max(20)
  });

  app.post("/jobs", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:write")) return res.status(403).json({ error: "forbidden" });
    const limit = await checkJobsEnqueuedLimit(req.tenantId!);
    if (!limit.allowed) return res.status(429).json({ error: "plan_limit", limit: limit.limit });
    const parsed = createJobBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
    }

    let job: Awaited<ReturnType<typeof prisma.job.findUnique>> | null = null;
    let created = false;
    try {
      const resCreate = await createJobIdempotent({
        tenantId: req.tenantId!,
        type: parsed.data.type,
        payload: parsed.data.payload,
        idempotencyKey: parsed.data.idempotencyKey
      });
      job = resCreate.job;
      created = resCreate.created;
    } catch (err) {
      const statusCode = (err as unknown as { statusCode?: number }).statusCode;
      if (statusCode === 409) return res.status(409).json({ error: "idempotency_key_conflict" });
      throw err;
    }
    if (!job) return res.status(500).json({ error: "internal_error" });
    if (!created) {
      return res.status(200).json({
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: job.lastError
      });
    }

    try {
      const requestId = (req as unknown as { id?: string }).id;
      await enqueueJob({
        tenantId: req.tenantId!,
        job: { id: job.id, type: job.type, payloadHash: job.payloadHash, maxAttempts: job.maxAttempts },
        requestId,
        priority: parsed.data.priority,
        delayMs: parsed.data.delayMs
      });
      return res.status(201).json({ id: job.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "enqueue_failed";
      await markEnqueueFailed(job.id, msg);
      return res.status(500).json({ error: "enqueue_failed" });
    }
  });

  app.get("/jobs/:id", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:read")) return res.status(403).json({ error: "forbidden" });
    const job = await getJobByIdForTenant(req.tenantId!, req.params.id);
    if (!job) return res.status(404).json({ error: "not_found" });
    return res.json({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      error: job.lastError,
      idempotencyKey: job.idempotencyKey,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      createdAt: job.createdAt
    });
  });

  app.get("/jobs", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:read")) return res.status(403).json({ error: "forbidden" });
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(req.query.limit);
    const status = z
      .preprocess((v) => (typeof v === "string" && v.length > 0 ? v : undefined), z.nativeEnum(JobStatus).optional())
      .parse(req.query.status);
    const idempotencyKey = z
      .preprocess((v) => (typeof v === "string" && v.length > 0 ? v : undefined), z.string().optional())
      .parse(req.query.idempotencyKey);

    const jobs = await listJobsForTenant({
      tenantId: req.tenantId!,
      limit,
      status,
      idempotencyKey
    });
    return res.json(
      jobs.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: job.lastError,
        idempotencyKey: job.idempotencyKey,
        durationMs: job.durationMs,
        createdAt: job.createdAt
      }))
    );
  });

  app.get("/jobs/stats", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:read")) return res.status(403).json({ error: "forbidden" });
    return res.json(await getJobStatsForTenant(req.tenantId!));
  });

  app.post("/jobs/:id/cancel", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:admin")) return res.status(403).json({ error: "forbidden" });
    const jobId = req.params.id;
    const job = await getJobByIdForTenant(req.tenantId!, jobId);
    if (!job) return res.status(404).json({ error: "not_found" });

    const queueJob = await jobsQueue.getJob(jobId);
    if (queueJob) {
      const state = await queueJob.getState();
      if (state === "waiting" || state === "delayed") {
        await queueJob.remove();
        await markCancelled(jobId);
        return res.json({ id: jobId, status: "cancelled" });
      }
    }

    await requestCancel(jobId);
    return res.json({ id: jobId, status: "cancel_requested" });
  });

  app.post("/jobs/:id/retry", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:admin")) return res.status(403).json({ error: "forbidden" });
    const jobId = req.params.id;
    const requestId = (req as unknown as { id?: string }).id;
    try {
      await manualRetryJob({ tenantId: req.tenantId!, jobId, requestId });
      return res.json({ id: jobId, status: "queued" });
    } catch (err) {
      if (err instanceof ServiceError) return res.status(err.statusCode).json({ error: err.code });
      throw err;
    }
  });

  app.post("/dlq/:id/replay", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "jobs:admin")) return res.status(403).json({ error: "forbidden" });
    const jobId = req.params.id;
    const requestId = (req as unknown as { id?: string }).id;
    try {
      await replayDlqJob({ tenantId: req.tenantId!, jobId, requestId });
      return res.json({ id: jobId, status: "queued" });
    } catch (err) {
      if (err instanceof ServiceError) return res.status(err.statusCode).json({ error: err.code });
      throw err;
    }
  });

  app.get("/api-keys", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "keys:admin")) return res.status(403).json({ error: "forbidden" });
    const keys = await prisma.apiKey.findMany({
      where: { tenantId: req.tenantId! },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, keyPrefix: true, scopes: true, revokedAt: true, lastUsedAt: true, createdAt: true }
    });
    return res.json(keys);
  });

  app.post("/api-keys", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "keys:admin")) return res.status(403).json({ error: "forbidden" });
    const parsed = createApiKeyBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() });
    const created = await createApiKey({ tenantId: req.tenantId!, name: parsed.data.name, scopes: parsed.data.scopes });
    return res.status(201).json(created);
  });

  app.post("/api-keys/:id/revoke", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "keys:admin")) return res.status(403).json({ error: "forbidden" });
    await revokeApiKey({ tenantId: req.tenantId!, apiKeyId: req.params.id });
    return res.json({ ok: true });
  });

  app.post("/api-keys/:id/rotate", async (req, res) => {
    if (!hasScope(req.apiKeyScopes, "keys:admin")) return res.status(403).json({ error: "forbidden" });
    await revokeApiKey({ tenantId: req.tenantId!, apiKeyId: req.params.id });
    const created = await createApiKey({ tenantId: req.tenantId!, name: `rotated:${req.params.id}`, scopes: req.apiKeyScopes ?? [] });
    return res.status(201).json(created);
  });

  app.get("/ui", (_req, res) => res.redirect(302, "/ui/jobs"));

  app.get("/ui/jobs", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Jobs</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 16px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      th { background: #f6f6f6; }
      button { padding: 6px 10px; }
      .muted { color: #666; }
    </style>
  </head>
  <body>
    <h1>Jobs</h1>
    <div style="display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; margin-bottom:12px;">
      <div>
        <div class="muted" style="margin-bottom:4px;">API key</div>
        <input id="apiKey" type="password" style="padding:6px; width:260px;" placeholder="x-api-key" />
      </div>
      <div>
        <div class="muted" style="margin-bottom:4px;">status</div>
        <select id="status" style="padding:6px;">
          <option value="">(todos)</option>
          <option value="queued">queued</option>
          <option value="started">started</option>
          <option value="retrying">retrying</option>
          <option value="succeeded">succeeded</option>
          <option value="enqueue_failed">enqueue_failed</option>
          <option value="dlq">dlq</option>
          <option value="cancel_requested">cancel_requested</option>
          <option value="cancelled">cancelled</option>
        </select>
      </div>
      <div>
        <div class="muted" style="margin-bottom:4px;">idempotencyKey</div>
        <input id="idempotencyKey" type="text" style="padding:6px; width:260px;" placeholder="buscar" />
      </div>
      <button onclick="render()" style="padding:6px 10px;">aplicar</button>
      <div class="muted" id="msg" style="margin-left:auto;"></div>
    </div>

    <div id="stats" class="muted" style="margin-bottom:12px;"></div>
    <table>
      <thead>
        <tr>
          <th>id</th>
          <th>type</th>
          <th>status</th>
          <th>attempts</th>
          <th>duration</th>
          <th>idempotencyKey</th>
          <th>error</th>
          <th>ações</th>
        </tr>
      </thead>
      <tbody id="rows"></tbody>
    </table>

    <script>
      const apiKeyEl = document.getElementById('apiKey');
      const statusEl = document.getElementById('status');
      const idemEl = document.getElementById('idempotencyKey');
      const msgEl = document.getElementById('msg');
      const statsEl = document.getElementById('stats');

      apiKeyEl.value = localStorage.getItem('apiKey') || '';
      apiKeyEl.addEventListener('change', () => localStorage.setItem('apiKey', apiKeyEl.value));

      function headers() {
        const apiKey = (apiKeyEl.value || '').trim();
        if (!apiKey) return null;
        return { 'x-api-key': apiKey };
      }

      async function fetchJson(url, opts) {
        const h = headers();
        if (!h) {
          msgEl.textContent = 'informe a API key';
          return null;
        }
        const res = await fetch(url, Object.assign({ headers: h }, opts || {}));
        if (res.status === 401) {
          msgEl.textContent = 'unauthorized';
          return null;
        }
        if (res.status === 429) {
          msgEl.textContent = 'rate_limited';
          return null;
        }
        msgEl.textContent = '';
        return res.json();
      }

      async function fetchJobs() {
        const params = new URLSearchParams();
        params.set('limit', '50');
        if (statusEl.value) params.set('status', statusEl.value);
        if (idemEl.value) params.set('idempotencyKey', idemEl.value);
        return fetchJson('/jobs?' + params.toString());
      }

      async function fetchStats() {
        return fetchJson('/jobs/stats');
      }

      async function retryJob(id) {
        await fetchJson('/jobs/' + id + '/retry', { method: 'POST' });
        await render();
      }

      function esc(s) {
        return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
      }

      async function render() {
        const [jobs, stats] = await Promise.all([fetchJobs(), fetchStats()]);
        if (!jobs) return;
        const rows = document.getElementById('rows');
        if (stats) {
          const byStatus = stats.byStatus || {};
          const parts = Object.keys(byStatus).sort().map(k => k + '=' + byStatus[k]);
          const avg = (typeof stats.avgDurationMs === 'number') ? (stats.avgDurationMs.toFixed(1) + 'ms') : '-';
          statsEl.textContent = 'avgDuration=' + avg + ' | ' + parts.join(' | ');
        }
        rows.innerHTML = jobs.map(j => {
          const disabled = (j.status !== 'failed' && j.status !== 'dlq' && j.status !== 'enqueue_failed');
          const dur = (typeof j.durationMs === 'number') ? (j.durationMs + 'ms') : '';
          return \`
            <tr>
              <td><code>\${esc(j.id)}</code></td>
              <td>\${esc(j.type)}</td>
              <td>\${esc(j.status)}</td>
              <td>\${esc(j.attempts)}/\${esc(j.maxAttempts)}</td>
              <td>\${esc(dur)}</td>
              <td>\${esc(j.idempotencyKey || '')}</td>
              <td>\${esc(j.error || '')}</td>
              <td>
                <button onclick="retryJob('\${esc(j.id)}')" \${disabled ? 'disabled' : ''}>retry</button>
              </td>
            </tr>\`;
        }).join('');
      }

      render();
      setInterval(render, 2000);
    </script>
  </body>
</html>`);
  });

  return app;
}


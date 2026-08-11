<div align="center">

# 🔄 Async Job Processing Platform

**Multi-tenant async job queue service with at-most-once side effects**

[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![BullMQ](https://img.shields.io/badge/BullMQ-FFCA28?style=for-the-badge)](https://docs.bullmq.io/)
[![Prometheus](https://img.shields.io/badge/Prometheus-E6522C?style=for-the-badge&logo=prometheus&logoColor=white)](https://prometheus.io/)
[![Docker](https://img.shields.io/badge/Docker-2CA5E0?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)

**[🚀 Live Demo](https://your-demo-url.com)** · **[📘 API Docs](https://your-demo-url.com/docs)** · **[⭐ Architecture](#-architecture)** · **[🛠️ Run Locally](#-running-locally)**

</div>

---

> ⚠️ **Screenshots coming soon.** Replace this section with actual screenshots/GIFs of the dashboard showing: job list UI, DLQ replay, metrics dashboard, and a successful demo flow (enqueue → retry → DLQ → replay).
>
> ```
> ![Jobs Dashboard](https://your-image-host.com/jobs-dashboard.png)
> ![DLQ & Replay](https://your-image-host.com/dlq-replay.png)
> ```

---

## 🎯 What It Does

A production-grade **multi-tenant asynchronous job processing platform** built for engineering teams that need correctness, not just "it works in dev." Think of it as a self-hosted job queue-as-a-service: tenants submit jobs through a REST API, workers process them asynchronously, and the platform guarantees that **side effects execute at most once** — even across retries, worker crashes, and concurrent processing.

### Why I Built This

Most job queue tutorials stop at "push to Redis, pop from Redis." Real systems need real answers:

- How do I prevent the same webhook from firing twice?
- What happens to a job when the worker dies mid-execution?
- How do I stop a bad tenant from starving the queue?
- How do I replay failures after fixing a bug without double-charging customers?

This project implements all of that properly: database-enforced idempotency, dead-letter queues with replay, tenant-level rate limiting, usage metering, and Prometheus metrics out of the box.

---

## 🏗️ Architecture

```mermaid
flowchart LR
    C[Client / Tenant] -->|HTTP + x-api-key| API[API Server<br/>Express]
    API -->|persist job state| PG[(PostgreSQL<br/>Jobs • Effects • Events • Usage)]
    API -->|enqueue job| Q[(Redis Queue<br/>BullMQ)]
    Q --> W1[Worker 1]
    Q --> W2[Worker 2]
    Q --> Wn[Worker N]
    W1 & W2 & Wn -->|side-effect<br/>at-most-once| EXT[External Systems<br/>(HTTP, Stripe, email, etc.)]
    W1 & W2 & Wn -->|write effects + events| PG
    W1 & W2 & Wn -->|max retries exceeded| DLQ[Dead-Letter Queue]
    DLQ -->|manual replay| Q
    W1 & W2 & Wn -->|expose metrics| MET[Prometheus Metrics<br/>/metrics]
    PG -->|daily rollup| USAGE[Tenant Usage & Billing]
```

### Architectural Decisions

| Decision | Why | Trade-off |
|----------|-----|-----------|
| **Job state persisted before enqueue** | API doesn't lose jobs if Redis is down | One extra DB write per job |
| **`JobEffect(jobId)` UNIQUE constraint** | Side-effect fires at-most-once even with concurrent workers | Every side-effect needs DB persistence |
| **Tenant-scoped idempotency** | `idempotencyKey` collisions can't happen across tenants | Composite unique index on `(tenantId, idempotencyKey)` |
| **API + Worker as separate services** | Independent scaling; workers can't block HTTP | Needs 2 deploy targets + shared Postgres/Redis |
| **BullMQ over raw Redis** | Built-in retries, backoff, DLQ, rate limiting, concurrency | Extra dependency; opinionated queue semantics |
| **Hashed API keys (scrypt)** | Key compromise doesn't expose plaintext secrets | Key secret only shown once at creation |

---

## ✨ Core Features & Guarantees

### ✅ Multi-Tenant Isolation
- Every row carries a `tenantId`
- API keys are scoped to a single tenant
- Idempotency keys are unique per-tenant (global would be a footgun)
- Per-tenant daily usage tracking for plan enforcement

### ✅ Idempotent End-to-End
- **API layer**: `(tenantId, idempotencyKey)` is a DB-level unique constraint. Same key twice → same job returned, no duplicate enqueue.
- **Worker layer**: `JobEffect(jobId)` unique constraint. A side-effect (HTTP call, charge, email) is written to the DB in the **same transaction** as the job state transition. Worker restarts or retries can't fire it twice.
- **Replay-safe**: DLQ replay goes through the exact same idempotency path.

### ✅ Retry & Dead-Letter Queue
- Automatic retries with **exponential backoff** and configurable jitter
- After max attempts, jobs move to the **DLQ** (not silently dropped)
- DLQ jobs can be **replayed individually or in bulk** after bug fixes
- Retry count, last error, and stack trace preserved on every job

### ✅ Rate Limiting & Abuse Protection
- **Per-tenant API rate limits** (token bucket) on all endpoints
- **Plan-level quotas**: daily/monthly job cap with soft/hard limits
- **Queue concurrency caps** per tenant to prevent noisy-neighbor problems
- Metrics on rate-limit hits for ops visibility

### ✅ Observability
- **Prometheus `/metrics` endpoint**: queue depth, success/failure rates, retry counts, latency histograms, rate-limit counters
- **Structured JSON logs** with `requestId`, `jobId`, `tenantId`, `attempt` on every log line
- **Full audit trail**: `JobEvent` table records every state transition (enqueued, started, succeeded, retried, dead-lettered, replayed) with timestamps
- Job dashboard UI: search, filter by status, view job timeline

### ✅ API Key Management
- Keys stored hashed (scrypt, salted) — plaintext shown **once** at creation
- Scope system: `jobs:read`, `jobs:write`, `jobs:admin`, `keys:admin`, `metrics:read`
- Revoke and **rotate** keys without downtime
- Bootstrap key for first-time setup (printed to logs on first boot)

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+ · TypeScript 5 (strict) |
| **API** | Express · Zod (validation) |
| **Queue** | Redis 7 · BullMQ (retries, rate limit, DLQ) |
| **Database** | PostgreSQL 15 · Prisma ORM · row-level locking |
| **Auth** | API keys · scrypt KDF · scope-based authorization |
| **Metrics** | Prometheus client · custom counters/histograms |
| **Tests** | Vitest · Supertest · integration tests against real Postgres/Redis |
| **Deployment** | Docker · render.yaml (Render) · Railway-friendly |
| **CI/CD** | GitHub Actions (lint → test → build) |

---

## 🚀 Live Demo

> ⚠️ **Deploy first, then fill this in.**
>
> | Resource | URL |
> |----------|-----|
> | API Base | `https://your-api-domain.com` |
> | Jobs UI | `https://your-api-domain.com/ui/jobs` |
> | Metrics | `https://your-api-domain.com/metrics` (token protected) |
> | Demo API Key | `ak_demo_xxxxxxxxxxxxxxxx` (jobs:read, jobs:write) — scoped to a demo tenant with daily limits |
>
> Try the [demo curl flow](#demo-flow) below against the live API.

---

## ⚙️ Running Locally

### Prerequisites
- Node.js 20+
- Docker Desktop (for Postgres + Redis)

### 1. Start infrastructure
```bash
docker compose up -d
```

### 2. Install & setup
```bash
npm install
npm run setup
```

`setup` prints a **BOOTSTRAP_API_KEY** for the default tenant (save it):
```
BOOTSTRAP_API_KEY=ak_<prefix>_<secret>
```

### 3. Run API + Worker
Terminal 1:
```bash
npm run dev
```

Terminal 2:
```bash
npm run dev:worker
```

Now open:
- **Jobs UI**: http://localhost:3001/ui/jobs
- **Health**: http://localhost:3001/health
- **Metrics**: http://localhost:3001/metrics (needs `x-metrics-token` or API key with `metrics:read`)

---

## 📘 API Quick Reference

All protected endpoints use the header:
```
x-api-key: ak_<keyPrefix>_<secret>
```

### Submit a Job
```bash
curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "type": "order.process:v1",
    "payload": {"orderId": "o_123"},
    "idempotencyKey": "order:o_123:v1"
  }'
```

### Get Job Status
```bash
curl -sS "$BASE_URL/jobs/$JOB_ID" -H "x-api-key: $API_KEY"
```

### Replay from DLQ
```bash
curl -sS -X POST "$BASE_URL/dlq/$JOB_ID/replay" -H "x-api-key: $API_KEY"
```

### Create a New API Key
```bash
curl -sS -X POST "$BASE_URL/api-keys" \
  -H "x-api-key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"ci-server","scopes":["jobs:read","jobs:write"]}'
```

### Full Demo Flow (Enqueue → Retry → DLQ → Replay)

```bash
export BASE_URL="http://localhost:3001"
export API_KEY="ak_your_key_here"

# 1) Success path
JOB_OK=$(curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"type":"order.process:v1","payload":{"orderId":"o_100"},"idempotencyKey":"demo:o_100"}' | jq -r .id)

# 2) Fail once, then succeed (retry)
JOB_RETRY=$(curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"type":"order.process:v1","payload":{"orderId":"o_101","failUntilAttempt":1},"idempotencyKey":"demo:o_101"}' | jq -r .id)

# 3) Goes to DLQ after all retries
JOB_DLQ=$(curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"type":"test.failfast:v1","payload":{"failUntilAttempt":99},"idempotencyKey":"demo:dlq:1"}' | jq -r .id)

# 4) Replay it after fixing the bug
curl -sS -X POST "$BASE_URL/dlq/$JOB_DLQ/replay" -H "x-api-key: $API_KEY"

# Check statuses
curl -sS "$BASE_URL/jobs/$JOB_OK" -H "x-api-key: $API_KEY" | jq .status
curl -sS "$BASE_URL/jobs/$JOB_RETRY" -H "x-api-key: $API_KEY" | jq '{status, attempts}'
```

---

## 🧪 Tests

Integration tests run against **real Postgres and Redis** (no mocking):

```bash
# Spin up test DB + Redis, run the full suite
npm run test:full
```

### Coverage Highlights

| Scenario | What it proves |
|----------|---------------|
| ✅ Enqueue → success | Happy path works |
| ✅ Fail → retry → success | Retry + backoff recover correctly |
| ✅ Fail → DLQ | Jobs don't silently drop; DLQ populated |
| ✅ Same idempotencyKey twice | No duplicate; returns existing job |
| ✅ 2 concurrent workers + same job | Side-effect executes exactly **once** (constraint enforced) |
| ✅ API key without scope | 403; scope system works |
| ✅ Rate limit exceeded | 429 after threshold; headers correct |
| ✅ DLQ replay → idempotency preserved | Replay doesn't double-execute side-effects |
| ✅ API key CRUD (create/revoke/rotate) | Full key lifecycle |
| ✅ Metrics endpoint | Prometheus exposition format valid |

---

## 🚢 Deployment

### Render (One-Click-ish)

The repo includes `render.yaml` defining two services + managed DB/Redis:

1. Click **Deploy to Render** (or create from YAML blueprint)
2. Copy `DATABASE_URL` and `REDIS_URL` from the managed resources
3. Set env vars on **both** services:
   ```
   DATABASE_URL, REDIS_URL
   METRICS_TOKEN, DEFAULT_TENANT_ID
   QUEUE_NAME, DLQ_NAME
   RATE_LIMIT_PER_MIN, RATE_LIMIT_BURST
   ```
4. Deploy. Migrations run automatically.
5. Check the **API logs** → grab `BOOTSTRAP_API_KEY` → use it to create a demo key.

### Railway / Fly.io / AWS ECS

Create **two services** pointing at the same repo:
- **API service**: start command → `npm run deploy:api`
- **Worker service**: start command → `npm run deploy:worker`

Both need access to the same Postgres + Redis instance.

---

## 📊 Data Model Summary

```
Job                (tenantId, idempotencyKey) UNIQUE
  ├── id, tenantId, type, payload
  ├── status (PENDING/PROCESSING/SUCCEEDED/FAILED/DEAD)
  ├── attempts, lastError, nextRetryAt
  └── timestamps (createdAt, processedAt, finishedAt)

JobEffect          (jobId) UNIQUE
  └── records the external side-effect payload + timestamp
     → enforces at-most-once execution, even across worker crashes

JobEvent           (jobId, seq)
  └── full audit trail: every state transition + metadata

TenantUsageDaily   (tenantId, day) UNIQUE
  └── jobs_enqueued, jobs_succeeded, jobs_failed → for billing/quotas

ApiKey             (keyPrefix) UNIQUE
  └── hashedSecret (scrypt), tenantId, scopes[], revokedAt
```

---

## 📌 Production Hardening Checklist

> See `docs/production-hardening.md` for the full list.

- [x] DB connection pooling + timeouts
- [x] Redis `maxmemory-policy` → `noeviction` for queues
- [x] Worker graceful shutdown (SIGTERM → stop consuming → finish in-flight)
- [x] Job timeout (stuck workers don't hold jobs forever)
- [x] Queue-level monitoring (depth > threshold → alert)
- [x] DLQ alerting (any message → notify ops)
- [x] API key rotation workflow
- [x] CORS restricted to known origins
- [x] Helmet + rate limiting on API

---

## 🧠 Engineering Lessons Learned

1. **"At least once delivery" is a promise, not a warning.** Every side-effect **must** be idempotent — queues will retry.
2. **Don't enqueue then persist.** Persist then enqueue (outbox pattern-ish). Redis being down loses no jobs.
3. **Unique constraints > application logic.** If correctness matters, the database is the last line of defense.
4. **DLQ > silent failure.** A job in the DLQ with a stack trace is debuggable; a job that vanished is not.
5. **Correlation IDs are non-negotiable.** Every log line needs `(requestId, jobId, tenantId, attempt)` or you can't trace production issues.

---

<div align="center">

**[⬆ Back to Top](#-async-job-processing-platform)** · Built with ❤️ using TypeScript, PostgreSQL & Redis

</div>

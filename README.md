# Async Job Processing Platform

Designed and implemented a multi-tenant async job processing platform with Redis-backed queues, idempotent job handling, rate limiting, usage tracking, Prometheus metrics, and production-ready deployment architecture (API + worker separation).

## Architecture

```mermaid
flowchart LR
  C[Client] -->|HTTP + x-api-key| API[API (Express)]
  API -->|persist| PG[(Postgres)]
  API -->|enqueue| Q[(Redis + BullMQ)]
  Q --> W[Worker]
  W -->|side-effects (idempotent)| EXT[External systems]
  W -->|definitive failures| DLQ[DLQ queue]
  W -->|audit events| PG
```

Core guarantees:
- Multi-tenant isolation (`tenantId` on jobs; tenant-scoped idempotency)
- Safe-to-retry processing (side-effect executed at most once)
- Automatic retries with exponential backoff + DLQ
- Abuse protection (rate limiting + plan limits)
- Observability (structured logs + Prometheus metrics)

## Public demo (what a recruiter can run)

After deploying, you should expose:
- API base URL: `https://<your-api>`
- A demo API key with limited scopes (rotate whenever needed): `DEMO_API_KEY`

## Local quickstart

```bash
npm install
npm run setup
```

`setup` prints a bootstrap key if the default tenant has no active keys:

```
BOOTSTRAP_API_KEY=ak_<prefix>_<secret>
```

Run API + worker:

```bash
npm run dev
```

In another terminal:

```bash
npm run dev:worker
```

UI:
- `http://localhost:3001/ui/jobs`

## Auth (API keys) and multi-tenancy

All protected endpoints require:
- `x-api-key: ak_<keyPrefix>_<secret>`

Keys are stored hashed (salt + scrypt) and can be revoked/rotated.

Scopes:
- `jobs:read`, `jobs:write`, `jobs:admin`
- `keys:admin`
- `metrics:read`

Legacy/dev fallback (optional):
- `API_KEYS=plainKey:tenantId,otherKey:otherTenant`

## API key management (curl)

Create a new key (returns the secret once):

```bash
curl -sS -X POST "$BASE_URL/api-keys" \
  -H "x-api-key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"demo","scopes":["jobs:read","jobs:write","jobs:admin","metrics:read"]}'
```

List keys (no secrets):

```bash
curl -sS "$BASE_URL/api-keys" -H "x-api-key: $ADMIN_KEY"
```

Revoke:

```bash
curl -sS -X POST "$BASE_URL/api-keys/$API_KEY_ID/revoke" -H "x-api-key: $ADMIN_KEY"
```

Rotate:

```bash
curl -sS -X POST "$BASE_URL/api-keys/$API_KEY_ID/rotate" -H "x-api-key: $ADMIN_KEY"
```

## Demo flow (enqueue → retry → DLQ → replay)

Set:

```bash
export BASE_URL="http://localhost:3001"
export API_KEY="ak_<prefix>_<secret>"
```

1) Enqueue a successful job:

```bash
JOB_ID=$(curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"order.process:v1","payload":{"orderId":"o_123"},"idempotencyKey":"order:o_123:v1"}' | jq -r .id)
```

2) A job that fails once, then succeeds (retry):

```bash
JOB_ID_RETRY=$(curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"order.process:v1","payload":{"orderId":"o_124","failUntilAttempt":1},"idempotencyKey":"order:o_124:v1"}' | jq -r .id)
```

3) A job that goes to DLQ:

```bash
JOB_ID_DLQ=$(curl -sS -X POST "$BASE_URL/jobs" \
  -H "x-api-key: $API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"test.failfast:v1","payload":{"failUntilAttempt":99},"idempotencyKey":"dlq:1"}' | jq -r .id)
```

4) Replay a DLQ job:

```bash
curl -sS -X POST "$BASE_URL/dlq/$JOB_ID_DLQ/replay" -H "x-api-key: $API_KEY"
```

Inspect status:

```bash
curl -sS "$BASE_URL/jobs/$JOB_ID" -H "x-api-key: $API_KEY"
```

## Rate limiting (quick test)

```bash
for i in $(seq 1 50); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE_URL/jobs?limit=1" -H "x-api-key: $API_KEY"
done | sort | uniq -c
```

## Metrics (Prometheus)

Option A: token:

```bash
curl -sS "$BASE_URL/metrics" -H "x-metrics-token: $METRICS_TOKEN"
```

Option B: API key (needs `metrics:read`):

```bash
curl -sS "$BASE_URL/metrics" -H "x-api-key: $API_KEY"
```

## Data model

- `Job(tenantId, idempotencyKey)` is unique (tenant-scoped idempotency)
- `JobEffect(jobId)` ensures the side-effect executes at most once
- `JobEvent(jobId, type, ts, data)` provides a full audit trail
- `TenantUsageDaily(tenantId, day, ...)` stores usage for plan/billing

## Deploy (public)

This repository supports the “real” production layout:
- API service (HTTP)
- Worker service (background)
- Postgres managed
- Redis managed

### Render (recommended)

This repo includes a `render.yaml` that defines two services:
- `ajpp-api` (web)
- `ajpp-worker` (worker)

Steps:
1) Create managed Postgres + Redis and copy `DATABASE_URL` and `REDIS_URL`.
2) Set env vars on both services:
   - `DATABASE_URL`, `REDIS_URL`, `METRICS_TOKEN`, `DEFAULT_TENANT_ID`
   - `QUEUE_NAME`, `DLQ_NAME`, `RATE_LIMIT_*`
3) Deploy. The start command runs migrations automatically (`npm run deploy:*`).
4) Grab `BOOTSTRAP_API_KEY` from the API logs (first deploy) and use it to create a demo key.

### Railway / other platforms

Create two services pointing to the same repo:
- API: start command `npm run deploy:api`
- Worker: start command `npm run deploy:worker`

Use managed Postgres/Redis and the same env vars in both.

## Tests

```bash
npm run test:full
```

Integration coverage includes:
- success
- fail → retry → success
- fail → DLQ
- idempotency (same idempotencyKey does not duplicate)
- concurrency (2 workers, side-effect once)
- auth + rate limit + metrics + API key CRUD

## Pitch (portfolio)

See [pitch.md](file:///c:/Users/isaac/Área%20de%20Trabalho/Dev/async-job-processing-platform/docs/pitch.md).

## Production hardening

See [production-hardening.md](file:///c:/Users/isaac/Área%20de%20Trabalho/Dev/async-job-processing-platform/docs/production-hardening.md).

## Tracing

See [tracing.md](file:///c:/Users/isaac/Área%20de%20Trabalho/Dev/async-job-processing-platform/docs/tracing.md).

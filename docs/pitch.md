# Pitch + Interview Notes

## One-liner (LinkedIn/Resume)

Designed and implemented a multi-tenant async job processing platform with Redis-backed queues, idempotent job handling, rate limiting, usage tracking, Prometheus metrics, and production-ready deployment architecture (API + worker separation).

## What to highlight (talking points)

- Multi-tenant isolation: all reads/writes are tenant-scoped; idempotency is enforced per tenant (`tenantId + idempotencyKey`).
- Idempotent side-effects: side-effect execution is guarded by a DB unique row (`JobEffect(jobId)`), so retries cannot duplicate external effects.
- Concurrency safety: only one worker can claim a job state transition; duplicate queue deliveries become no-ops.
- Reliability: exponential backoff retries and DLQ; DLQ replay endpoint to reprocess after fixes.
- Abuse controls: Redis rate limiting + plan-based daily usage limits per tenant.
- Observability: structured logs with correlation (`requestId`, `tenantId`, `jobId`, `attempt`), plus Prometheus metrics.
- Production deployment: API and worker are separate services sharing Postgres + Redis.

## Common interview questions (short answers)

### Why Redis + BullMQ?

- Redis provides fast, durable-enough queue primitives with visibility timeouts, delayed jobs, retries, and horizontal scaling.
- BullMQ gives retry/backoff/DLQ patterns and worker concurrency without building a queue from scratch.

### How do you guarantee idempotency?

- Request-level idempotency: `tenantId + idempotencyKey` is unique in Postgres, so the same request cannot create multiple jobs.
- Processing-level idempotency: the side-effect is guarded by `JobEffect(jobId)`; only the first attempt can insert it, others skip.

### How does multi-tenant work?

- API keys map to a `tenantId` in the database.
- Every job is stored with `tenantId`.
- All list/get endpoints enforce tenant-scoped queries, so tenants cannot read each other’s jobs.

### How do you prevent abuse?

- Redis rate limiting (IP + API key).
- Plan limits tracked in Postgres per tenant/day; requests/enqueues are blocked when the tenant hits limits.

### How would you scale it?

- Add more API instances (stateless) behind a load balancer.
- Add more worker instances; BullMQ distributes jobs and the DB guards prevent duplicate side-effects.
- Use managed Postgres/Redis with appropriate sizing; add read replicas for reporting if needed.

### What fails in production and how do you handle it?

- Transient downstream errors: automatic retries with exponential backoff.
- Permanent errors: DLQ with full audit trail.
- Recovery: DLQ replay endpoint after a fix or manual intervention.


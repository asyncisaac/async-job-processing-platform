# Production hardening notes

## Retry backoff (exponential + jitter)

Enqueue uses BullMQ backoff with jitter:
- `type: "exponential"`
- `delay: BACKOFF_BASE_MS`
- `jitter: 0.2`

This reduces thundering herd when many jobs fail simultaneously.

## Job timeouts

Worker enforces a per-job timeout:
- `JOB_TIMEOUT_MS`

If the handler exceeds the timeout, the job fails and will retry / DLQ based on `attempts`.

## Job deduplication (queue-level)

Enqueue uses BullMQ `deduplication` to reduce duplicate jobs when producers spam the same payload:
- `id = tenantId + payloadHash`
- `ttl = JOB_DEDUP_TTL_MS`
- `keepLastIfActive = true`

This complements DB idempotency (`tenantId + idempotencyKey`) and is intentionally short-lived (TTL) to avoid blocking legitimate re-enqueues.

## Tenant concurrency control

Worker applies a per-tenant concurrency cap using Redis:
- `tenant_inflight:<tenantId>` counter with TTL
- if tenant exceeds its cap, the job is delayed with jitter

Caps are derived from tenant plan:
- `free`: lower max-in-flight
- `pro`: higher max-in-flight

## Stalled jobs / lock settings

Worker config:
- `lockDuration = WORKER_LOCK_DURATION_MS`
- `maxStalledCount = WORKER_MAX_STALLED_COUNT`

This helps recover jobs when a worker crashes mid-processing.

## Tracing (OpenTelemetry)

Tracing is enabled when:
- `OTEL_EXPORTER_OTLP_ENDPOINT` is set

Recommended backend:
- Grafana Tempo (OTLP HTTP)


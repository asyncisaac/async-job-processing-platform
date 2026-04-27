# End-to-end tracing (context propagation)

Goal: a single trace that covers:
- HTTP request (API)
- enqueue
- worker processing
- retries / DLQ / replay

## How it works

- The API injects the current trace context into a `traceCarrier` object and stores it:
  - in the BullMQ job payload (`traceCarrier`)
  - in DB events (`JobEvent.data.traceCarrier`)
- The worker extracts `traceCarrier` and starts spans as children of the original trace.

## Enable exporting (Tempo / OTLP HTTP)

Set in both API and worker:
- `OTEL_EXPORTER_OTLP_ENDPOINT=https://<tempo-or-collector-host>`

Optional:
- `OTEL_LOG_LEVEL=debug`

## Local Tempo + Grafana (optional)

1) Start infra:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d
```

2) In two terminals:

```bash
PORT=3000 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run dev:worker
```

3) Open Grafana:
- http://localhost:3001
- Explore → Tempo

## Verify quickly

1) Send a request that enqueues a job.
2) In Tempo, search by `service.name=ajpp-api` or `service.name=ajpp-worker`.
3) You should see spans:
   - `POST /jobs` (API)
   - `job.process` (worker)
   - `job.failed` if retry/DLQ happens

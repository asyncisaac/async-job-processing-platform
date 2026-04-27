process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5433/ajpp";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.LOG_LEVEL ??= "fatal";
process.env.BACKOFF_BASE_MS ??= "10";
process.env.RATE_LIMIT_WINDOW_SEC ??= "60";
process.env.RATE_LIMIT_MAX_PER_IP ??= "1000";
process.env.RATE_LIMIT_MAX_PER_KEY ??= "5";
process.env.METRICS_TOKEN ??= "test-metrics-token";
process.env.DEFAULT_TENANT_ID ??= "tenant_test";
process.env.JOB_TIMEOUT_MS ??= "2000";
process.env.WORKER_CONCURRENCY ??= "4";
process.env.WORKER_LOCK_DURATION_MS ??= "30000";
process.env.WORKER_MAX_STALLED_COUNT ??= "1";
process.env.JOB_DEDUP_TTL_MS ??= "1000";


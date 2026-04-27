import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.string().default("info"),
  QUEUE_NAME: z.string().min(1).default("jobs"),
  DLQ_NAME: z.string().min(1).default("jobs_dlq"),
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(50),
  API_KEYS: z.string().optional(),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_PER_IP: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MAX_PER_KEY: z.coerce.number().int().positive().default(600),
  METRICS_TOKEN: z.string().min(1),
  DEFAULT_TENANT_ID: z.string().min(1).default("tenant_default"),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  WORKER_LOCK_DURATION_MS: z.coerce.number().int().positive().default(30000),
  WORKER_MAX_STALLED_COUNT: z.coerce.number().int().min(0).default(1),
  JOB_DEDUP_TTL_MS: z.coerce.number().int().min(0).default(60000)
});

export const env = envSchema.parse(process.env);


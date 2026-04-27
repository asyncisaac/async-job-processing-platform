import { env } from "../config.js";

export type JobTypeConfig = {
  maxAttempts: number;
  backoffBaseMs: number;
};

const jobTypeConfigs: Record<string, JobTypeConfig> = {
  "order.process:v1": {
    maxAttempts: 5,
    backoffBaseMs: env.BACKOFF_BASE_MS
  },
  "test.failfast:v1": {
    maxAttempts: 2,
    backoffBaseMs: env.BACKOFF_BASE_MS
  }
};

export function assertValidJobType(type: string): void {
  if (!/^[a-z0-9_.-]+:v\d+$/i.test(type)) {
    throw new Error("job type must be versioned like type:v1");
  }
}

export function getJobTypeConfig(type: string): JobTypeConfig {
  assertValidJobType(type);
  return (
    jobTypeConfigs[type] ?? {
      maxAttempts: 3,
      backoffBaseMs: env.BACKOFF_BASE_MS
    }
  );
}


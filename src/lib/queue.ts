import { Queue } from "bullmq";
import * as IORedisModule from "ioredis";
import { env } from "../config.js";

const IORedis = (IORedisModule as unknown as { default?: typeof IORedisModule }).default ?? (IORedisModule as unknown as any);

export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null
});

export const jobsQueue = new Queue(env.QUEUE_NAME, {
  connection: redis
});

export const dlqQueue = new Queue(env.DLQ_NAME, {
  connection: redis
});


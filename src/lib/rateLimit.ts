import type { RequestHandler } from "express";
import { env } from "../config.js";
import { redis } from "./queue.js";

async function incrWithWindow(key: string, windowSec: number) {
  const multi = redis.multi();
  multi.incr(key);
  multi.ttl(key);
  const res = await multi.exec();
  const count = (res?.[0]?.[1] as number) ?? 0;
  const ttl = (res?.[1]?.[1] as number) ?? -1;
  if (ttl === -1) {
    await redis.expire(key, windowSec);
  }
  return count;
}

export function rateLimit(opts: {
  getId: (req: Parameters<RequestHandler>[0]) => string | null;
  max: number;
  windowSec?: number;
  prefix: string;
}): RequestHandler {
  const windowSec = opts.windowSec ?? env.RATE_LIMIT_WINDOW_SEC;

  return async (req, res, next) => {
    try {
      const id = opts.getId(req);
      if (!id) return next();
      const bucket = Math.floor(Date.now() / (windowSec * 1000));
      const key = `rl:${opts.prefix}:${id}:${bucket}`;
      const count = await incrWithWindow(key, windowSec);
      if (count > opts.max) {
        res.setHeader("retry-after", String(windowSec));
        return res.status(429).json({ error: "rate_limited" });
      }
      return next();
    } catch {
      return next();
    }
  };
}


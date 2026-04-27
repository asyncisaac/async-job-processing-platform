import { redis } from "./queue.js";

const acquireScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])

local current = redis.call("INCR", key)
if current == 1 then
  redis.call("PEXPIRE", key, ttlMs)
end

if current > limit then
  redis.call("DECR", key)
  return 0
end

return 1
`;

const releaseScript = `
local key = KEYS[1]
local current = redis.call("DECR", key)
if current <= 0 then
  redis.call("DEL", key)
end
return 1
`;

export async function acquireTenantPermit(tenantId: string, limit: number, ttlMs: number) {
  const key = `tenant_inflight:${tenantId}`;
  const ok = await redis.eval(acquireScript, 1, key, String(limit), String(ttlMs));
  return ok === 1;
}

export async function releaseTenantPermit(tenantId: string) {
  const key = `tenant_inflight:${tenantId}`;
  await redis.eval(releaseScript, 1, key);
}


import crypto from "node:crypto";
import { env } from "../config.js";
import { prisma } from "./prisma.js";

export type AuthContext = {
  apiKey: string;
  apiKeyId: string;
  apiKeyScopes: string[];
  tenantId: string;
};

export type ApiKeyPlaintext = {
  id: string;
  apiKey: string;
};

function parseLegacyApiKeys(raw: string) {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx <= 0 || idx === pair.length - 1) throw new Error("invalid API_KEYS format");
      const apiKey = pair.slice(0, idx).trim();
      const tenantId = pair.slice(idx + 1).trim();
      if (!apiKey || !tenantId) throw new Error("invalid API_KEYS format");
      return { apiKey, tenantId };
    });

  const map = new Map<string, string>();
  for (const { apiKey, tenantId } of entries) map.set(apiKey, tenantId);
  return map;
}

const legacyApiKeyToTenant = env.API_KEYS ? parseLegacyApiKeys(env.API_KEYS) : new Map<string, string>();

export function formatApiKey(keyPrefix: string, secret: string) {
  return `ak_${keyPrefix}_${secret}`;
}

export function parseApiKey(apiKey: string) {
  if (!apiKey.startsWith("ak_")) return null;
  const rest = apiKey.slice("ak_".length);
  const idx = rest.indexOf("_");
  if (idx <= 0 || idx === rest.length - 1) return null;
  const keyPrefix = rest.slice(0, idx);
  const secret = rest.slice(idx + 1);
  if (!keyPrefix || !secret) return null;
  return { keyPrefix, secret };
}

function hashSecret(secret: string, saltB64: string) {
  const salt = Buffer.from(saltB64, "base64");
  const derived = crypto.scryptSync(secret, salt, 32);
  return derived.toString("base64");
}

export async function authenticateApiKey(apiKey: string | undefined): Promise<AuthContext | null> {
  if (!apiKey) return null;

  const parsed = parseApiKey(apiKey);
  if (parsed) {
    const rec = await prisma.apiKey.findUnique({ where: { keyPrefix: parsed.keyPrefix } });
    if (!rec) return null;
    if (rec.revokedAt) return null;
    const computed = hashSecret(parsed.secret, rec.secretSalt);
    const ok = crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(rec.secretHash));
    if (!ok) return null;

    await prisma.apiKey.update({ where: { id: rec.id }, data: { lastUsedAt: new Date() } });

    return {
      apiKey,
      apiKeyId: rec.id,
      apiKeyScopes: rec.scopes,
      tenantId: rec.tenantId
    };
  }

  const legacyTenant = legacyApiKeyToTenant.get(apiKey);
  if (!legacyTenant) return null;
  return { apiKey, apiKeyId: "legacy", apiKeyScopes: ["jobs:write", "jobs:read", "jobs:admin", "keys:admin"], tenantId: legacyTenant };
}

export function checkMetricsToken(token: string | undefined) {
  return typeof token === "string" && token.length > 0 && token === env.METRICS_TOKEN;
}

export async function createApiKey(input: { tenantId: string; name: string; scopes: string[] }): Promise<ApiKeyPlaintext> {
  const keyPrefix = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(24).toString("base64url");
  const salt = crypto.randomBytes(16).toString("base64");
  const secretHash = hashSecret(secret, salt);

  const rec = await prisma.apiKey.create({
    data: {
      tenantId: input.tenantId,
      name: input.name,
      keyPrefix,
      secretSalt: salt,
      secretHash,
      scopes: input.scopes
    }
  });

  return { id: rec.id, apiKey: formatApiKey(keyPrefix, secret) };
}

export async function revokeApiKey(input: { tenantId: string; apiKeyId: string }) {
  await prisma.apiKey.updateMany({
    where: { id: input.apiKeyId, tenantId: input.tenantId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}



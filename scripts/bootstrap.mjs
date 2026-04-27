import "dotenv/config";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function formatApiKey(keyPrefix, secret) {
  return `ak_${keyPrefix}_${secret}`;
}

function hashSecret(secret, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  const derived = crypto.scryptSync(secret, salt, 32);
  return derived.toString("base64");
}

async function main() {
  const tenantId = process.env.DEFAULT_TENANT_ID || "tenant_default";

  await prisma.tenant.upsert({
    where: { id: tenantId },
    create: { id: tenantId, plan: "free" },
    update: {}
  });

  const existing = await prisma.apiKey.count({
    where: { tenantId, revokedAt: null }
  });
  if (existing > 0) return;

  const keyPrefix = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(24).toString("base64url");
  const salt = crypto.randomBytes(16).toString("base64");
  const secretHash = hashSecret(secret, salt);

  await prisma.apiKey.create({
    data: {
      tenantId,
      name: "bootstrap",
      keyPrefix,
      secretSalt: salt,
      secretHash,
      scopes: ["jobs:write", "jobs:read", "jobs:admin", "keys:admin", "metrics:read"]
    }
  });

  process.stdout.write(`BOOTSTRAP_API_KEY=${formatApiKey(keyPrefix, secret)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(String(err?.stack || err) + "\n");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


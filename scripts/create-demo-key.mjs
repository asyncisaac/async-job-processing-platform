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
  const tenantId = process.env.DEMO_TENANT_ID || "tenant_demo";
  const name = process.env.DEMO_KEY_NAME || "demo";

  await prisma.tenant.upsert({
    where: { id: tenantId },
    create: { id: tenantId, plan: "free" },
    update: {}
  });

  const keyPrefix = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(24).toString("base64url");
  const salt = crypto.randomBytes(16).toString("base64");
  const secretHash = hashSecret(secret, salt);

  const rec = await prisma.apiKey.create({
    data: {
      tenantId,
      name,
      keyPrefix,
      secretSalt: salt,
      secretHash,
      scopes: ["jobs:write", "jobs:read", "jobs:admin", "metrics:read"]
    }
  });

  process.stdout.write(`DEMO_TENANT_ID=${tenantId}\n`);
  process.stdout.write(`DEMO_API_KEY_ID=${rec.id}\n`);
  process.stdout.write(`DEMO_API_KEY=${formatApiKey(keyPrefix, secret)}\n`);
}

main()
  .catch((err) => {
    process.stderr.write(String(err?.stack || err) + "\n");
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


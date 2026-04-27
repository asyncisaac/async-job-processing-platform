-- Add tenant and timing fields
ALTER TABLE "Job" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'tenant_default';
ALTER TABLE "Job" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "finishedAt" TIMESTAMP(3);
ALTER TABLE "Job" ADD COLUMN "durationMs" INTEGER;

-- Replace unique index on idempotencyKey with tenant-scoped uniqueness
DROP INDEX "Job_idempotencyKey_key";
CREATE UNIQUE INDEX "Job_tenantId_idempotencyKey_key" ON "Job"("tenantId", "idempotencyKey");

-- Replace index for tenant-scoped listing
DROP INDEX "Job_status_createdAt_idx";
CREATE INDEX "Job_tenantId_status_createdAt_idx" ON "Job"("tenantId", "status", "createdAt" DESC);

ALTER TABLE "Job" ALTER COLUMN "tenantId" DROP DEFAULT;


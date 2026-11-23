-- Existing aliases cannot be safely converted without reissuing them.
DROP INDEX "ForwardingAlias_alias_key";
ALTER TABLE "ForwardingAlias" ADD COLUMN "aliasHash" TEXT,
  ADD COLUMN "encryptedToken" TEXT,
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'bill',
  ADD COLUMN "rotatedAt" TIMESTAMP(3);
UPDATE "ForwardingAlias" SET "aliasHash" = 'legacy:' || "id", "active" = false,
  "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP);
ALTER TABLE "ForwardingAlias" ALTER COLUMN "aliasHash" SET NOT NULL, DROP COLUMN "alias";
CREATE UNIQUE INDEX "ForwardingAlias_aliasHash_key" ON "ForwardingAlias"("aliasHash");
CREATE INDEX "ForwardingAlias_ownerUid_active_idx" ON "ForwardingAlias"("ownerUid", "active");
CREATE UNIQUE INDEX "ForwardingAlias_one_active_per_owner" ON "ForwardingAlias"("ownerUid") WHERE "active" = true AND "purpose" = 'bill';

ALTER TABLE "BillSubmission" ALTER COLUMN "billId" DROP NOT NULL,
  ALTER COLUMN "processedAt" DROP NOT NULL,
  ADD COLUMN "sender" TEXT,
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "processingStatus" TEXT NOT NULL DEFAULT 'processed',
  ADD COLUMN "scanStatus" TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN "attachments" JSONB,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

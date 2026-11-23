-- CreateEnum
CREATE TYPE "BillSource" AS ENUM ('MANUAL', 'FORWARDED_EMAIL');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('AWAITING_APPROVAL', 'APPROVED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_taskId_fkey";

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "billId" TEXT,
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "ownerUid" TEXT,
ADD COLUMN     "proposedAction" JSONB,
ALTER COLUMN "taskId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN     "billId" TEXT,
ADD COLUMN     "ownerUid" TEXT;

-- CreateTable
CREATE TABLE "Bill" (
    "id" TEXT NOT NULL,
    "ownerUid" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "accountLastFour" TEXT,
    "source" "BillSource" NOT NULL,
    "status" "BillStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "riskLevel" INTEGER NOT NULL,
    "approvalRequired" BOOLEAN NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillSubmission" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "ownerUid" TEXT NOT NULL,
    "source" "BillSource" NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForwardingAlias" (
    "id" TEXT NOT NULL,
    "ownerUid" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ForwardingAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Bill_ownerUid_createdAt_idx" ON "Bill"("ownerUid", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_ownerUid_fingerprint_key" ON "Bill"("ownerUid", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_id_ownerUid_key" ON "Bill"("id", "ownerUid");

-- CreateIndex
CREATE INDEX "BillSubmission_ownerUid_billId_idx" ON "BillSubmission"("ownerUid", "billId");

-- CreateIndex
CREATE UNIQUE INDEX "ForwardingAlias_alias_key" ON "ForwardingAlias"("alias");

-- CreateIndex
CREATE INDEX "Approval_ownerUid_billId_status_idx" ON "Approval"("ownerUid", "billId", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_ownerUid_billId_createdAt_idx" ON "AuditEvent"("ownerUid", "billId", "createdAt");

-- AddForeignKey
ALTER TABLE "BillSubmission" ADD CONSTRAINT "BillSubmission_billId_ownerUid_fkey" FOREIGN KEY ("billId", "ownerUid") REFERENCES "Bill"("id", "ownerUid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_billId_ownerUid_fkey" FOREIGN KEY ("billId", "ownerUid") REFERENCES "Bill"("id", "ownerUid") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_billId_ownerUid_fkey" FOREIGN KEY ("billId", "ownerUid") REFERENCES "Bill"("id", "ownerUid") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PaymentPolicy" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "merchantName" TEXT NOT NULL,
  "merchantFingerprint" TEXT NOT NULL,
  "accountLast4" TEXT,
  "mode" TEXT NOT NULL,
  "maximumAmountCents" INTEGER,
  "minimumAmountCents" INTEGER,
  "currency" TEXT NOT NULL,
  "allowedBankConnectionId" TEXT,
  "typicalAmountCents" INTEGER,
  "variancePercent" DOUBLE PRECISION,
  "requireApprovalAboveCents" INTEGER,
  "requireApprovalForFirstPayment" BOOLEAN NOT NULL DEFAULT true,
  "requireApprovalForAmountChange" BOOLEAN NOT NULL DEFAULT true,
  "requireApprovalForDueDateChange" BOOLEAN NOT NULL DEFAULT true,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentPolicy_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PaymentPolicy_userId_active_idx" ON "PaymentPolicy"("userId", "active");
CREATE UNIQUE INDEX "PaymentPolicy_userId_merchantFingerprint_accountLast4_key"
  ON "PaymentPolicy"("userId", "merchantFingerprint", "accountLast4");
CREATE UNIQUE INDEX "PaymentPolicy_one_unscoped_merchant"
  ON "PaymentPolicy"("userId", "merchantFingerprint") WHERE "accountLast4" IS NULL;

CREATE TABLE "PaymentDecision" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "billId" TEXT NOT NULL,
  "policyId" TEXT,
  "decision" TEXT NOT NULL,
  "riskLevel" INTEGER NOT NULL,
  "reasons" JSONB NOT NULL,
  "amountCents" INTEGER,
  "currency" TEXT,
  "merchantName" TEXT,
  "accountLast4" TEXT,
  "bankConnectionId" TEXT,
  "policySnapshot" JSONB NOT NULL,
  "billSnapshot" JSONB NOT NULL,
  "billSnapshotHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentDecision_billId_userId_fkey" FOREIGN KEY ("billId", "userId")
    REFERENCES "Bill"("id", "ownerUid") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PaymentDecision_policyId_fkey" FOREIGN KEY ("policyId")
    REFERENCES "PaymentPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PaymentDecision_userId_billId_createdAt_idx" ON "PaymentDecision"("userId", "billId", "createdAt");
CREATE INDEX "PaymentDecision_userId_policyId_createdAt_idx" ON "PaymentDecision"("userId", "policyId", "createdAt");

ALTER TABLE "Approval"
  ADD COLUMN "paymentDecisionId" TEXT,
  ADD COLUMN "approvalTokenHash" TEXT,
  ADD COLUMN "billSnapshotHash" TEXT,
  ADD COLUMN "amountCents" INTEGER,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "merchantName" TEXT,
  ADD COLUMN "accountLast4" TEXT,
  ADD COLUMN "bankConnectionId" TEXT,
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "Approval_paymentDecisionId_fkey" FOREIGN KEY ("paymentDecisionId")
    REFERENCES "PaymentDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Approval_approvalTokenHash_key" ON "Approval"("approvalTokenHash");
CREATE INDEX "Approval_ownerUid_status_expiresAt_idx" ON "Approval"("ownerUid", "status", "expiresAt");
CREATE UNIQUE INDEX "Approval_one_pending_payment_decision"
  ON "Approval"("ownerUid", "billId")
  WHERE "paymentDecisionId" IS NOT NULL AND "status" IN ('PENDING', 'APPROVED');

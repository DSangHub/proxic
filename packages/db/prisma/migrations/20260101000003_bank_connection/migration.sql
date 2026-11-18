CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "ownerUid" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PLAID',
    "plaidItemId" TEXT,
    "institutionId" TEXT,
    "institutionName" TEXT,
    "status" "PlaidConnectionState" NOT NULL DEFAULT 'LINKING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "bankConnectionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mask" TEXT,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankConnection_ownerUid_key" ON "BankConnection"("ownerUid");
CREATE UNIQUE INDEX "BankAccount_bankConnectionId_accountId_key" ON "BankAccount"("bankConnectionId", "accountId");
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_ownerUid_fkey" FOREIGN KEY ("ownerUid") REFERENCES "PlaidConnection"("ownerUid") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_bankConnectionId_fkey" FOREIGN KEY ("bankConnectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "BankConnection" ("id", "ownerUid", "status", "createdAt", "updatedAt")
SELECT "ownerUid", "ownerUid", "status", "createdAt", "updatedAt" FROM "PlaidConnection";

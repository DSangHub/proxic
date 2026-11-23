CREATE TYPE "PlaidConnectionState" AS ENUM ('LINKING', 'EXCHANGING', 'ACTIVE', 'DISCONNECTING');

CREATE TABLE "PlaidConnection" (
    "ownerUid" TEXT NOT NULL,
    "status" "PlaidConnectionState" NOT NULL DEFAULT 'LINKING',
    "encryptedToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlaidConnection_pkey" PRIMARY KEY ("ownerUid")
);

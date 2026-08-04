-- CreateTable
CREATE TABLE "territory_validations" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "repId" TEXT NOT NULL,
    "repEmail" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "subReason" TEXT,
    "feedback" TEXT,
    "sfdcWrittenAt" TIMESTAMP(3),
    "sfdcFields" JSONB,
    "sfdcError" TEXT,

    CONSTRAINT "territory_validations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "territory_validations_accountId_idx" ON "territory_validations"("accountId");

-- CreateIndex
CREATE INDEX "territory_validations_repEmail_idx" ON "territory_validations"("repEmail");

-- CreateIndex
CREATE INDEX "territory_validations_disposition_idx" ON "territory_validations"("disposition");

-- CreateIndex
CREATE UNIQUE INDEX "territory_validations_accountId_repId_key" ON "territory_validations"("accountId", "repId");

-- AddForeignKey
ALTER TABLE "territory_validations" ADD CONSTRAINT "territory_validations_repId_fkey" FOREIGN KEY ("repId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

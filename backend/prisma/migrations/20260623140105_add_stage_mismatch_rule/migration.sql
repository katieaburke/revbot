-- AlterEnum
ALTER TYPE "AlertType" ADD VALUE 'STAGE_MISMATCH';

-- DropIndex
DROP INDEX "meddpicc_stage_requirements_stageName_key";

-- DropIndex
DROP INDEX "stall_thresholds_by_stage_stageName_key";

-- AlterTable
ALTER TABLE "close_date_risk_rules" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "stage_mismatch_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keywords" TEXT[],
    "stages" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_mismatch_rules_pkey" PRIMARY KEY ("id")
);

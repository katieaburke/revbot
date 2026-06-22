-- Add CLOSE_DATE_RISK to AlertType enum
ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'CLOSE_DATE_RISK';

-- Create close_date_risk_rules table
CREATE TABLE "close_date_risk_rules" (
  "id"              TEXT NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stageName"       TEXT NOT NULL,
  "opportunityType" TEXT NOT NULL DEFAULT 'All',
  "daysThreshold"   INTEGER NOT NULL,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,

  CONSTRAINT "close_date_risk_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "close_date_risk_rules_stageName_opportunityType_key"
  ON "close_date_risk_rules"("stageName", "opportunityType");

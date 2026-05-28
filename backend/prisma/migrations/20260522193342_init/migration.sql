-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('PAST_DUE_INITIAL', 'PAST_DUE_AMENDMENT', 'PAST_DUE_RENEWAL', 'STALLED', 'MEDDPICC_MISSING');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'SNOOZED', 'RESOLVED', 'DISMISSED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "slackEmail" TEXT NOT NULL,
    "slackName" TEXT,
    "slackAvatarUrl" TEXT,
    "sfdcUserId" TEXT,
    "sfdcInstanceUrl" TEXT,
    "sfdcAccessToken" TEXT,
    "sfdcRefreshToken" TEXT,
    "sfdcTokenExpiresAt" TIMESTAMP(3),
    "sfdcConnectedAt" TIMESTAMP(3),
    "isRevOps" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "stall_rules" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dealAgeThresholdDays" INTEGER,
    "stageDurationThresholdDays" INTEGER,
    "filterStages" TEXT[],
    "filterOppTypes" TEXT[],
    "filterSegments" TEXT[],
    "filterOwnerIds" TEXT[],
    "gongInactivityDays" INTEGER,
    "flagSingleThreaded" BOOLEAN NOT NULL DEFAULT false,
    "flagGongRedFlags" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "stall_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meddpicc_stage_requirements" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stageName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "requireMetrics" BOOLEAN NOT NULL DEFAULT false,
    "requireEconomicBuyer" BOOLEAN NOT NULL DEFAULT false,
    "requireDecisionCriteria" BOOLEAN NOT NULL DEFAULT false,
    "requireDecisionProcess" BOOLEAN NOT NULL DEFAULT false,
    "requireIdentifyPain" BOOLEAN NOT NULL DEFAULT false,
    "requireChampion" BOOLEAN NOT NULL DEFAULT false,
    "requireCompetition" BOOLEAN NOT NULL DEFAULT false,
    "sfdcFieldMetrics" TEXT NOT NULL DEFAULT 'MEDDPICC_Metrics__c',
    "sfdcFieldEconomicBuyer" TEXT NOT NULL DEFAULT 'MEDDPICC_Economic_Buyer__c',
    "sfdcFieldDecisionCriteria" TEXT NOT NULL DEFAULT 'MEDDPICC_Decision_Criteria__c',
    "sfdcFieldDecisionProcess" TEXT NOT NULL DEFAULT 'MEDDPICC_Decision_Process__c',
    "sfdcFieldIdentifyPain" TEXT NOT NULL DEFAULT 'MEDDPICC_Identify_Pain__c',
    "sfdcFieldChampion" TEXT NOT NULL DEFAULT 'MEDDPICC_Champion__c',
    "sfdcFieldCompetition" TEXT NOT NULL DEFAULT 'MEDDPICC_Competition__c',

    CONSTRAINT "meddpicc_stage_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "opportunityName" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "alertDetails" JSONB NOT NULL,
    "slackMessageTs" TEXT,
    "slackChannelId" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'SENT',
    "snoozedUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stallRuleId" TEXT,
    "sfdcUpdatedAt" TIMESTAMP(3),
    "sfdcUpdateFields" JSONB,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nudge_logs" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opportunityId" TEXT NOT NULL,
    "opportunityName" TEXT NOT NULL,
    "nudgedById" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "alertType" "AlertType" NOT NULL,
    "customMessage" TEXT,
    "slackMessageTs" TEXT,

    CONSTRAINT "nudge_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_slackUserId_key" ON "users"("slackUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_slackEmail_key" ON "users"("slackEmail");

-- CreateIndex
CREATE UNIQUE INDEX "meddpicc_stage_requirements_stageName_key" ON "meddpicc_stage_requirements"("stageName");

-- CreateIndex
CREATE INDEX "notifications_opportunityId_idx" ON "notifications"("opportunityId");

-- CreateIndex
CREATE INDEX "notifications_ownerId_idx" ON "notifications"("ownerId");

-- CreateIndex
CREATE INDEX "notifications_alertType_idx" ON "notifications"("alertType");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "admin_sessions_tokenHash_key" ON "admin_sessions"("tokenHash");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_stallRuleId_fkey" FOREIGN KEY ("stallRuleId") REFERENCES "stall_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nudge_logs" ADD CONSTRAINT "nudge_logs_nudgedById_fkey" FOREIGN KEY ("nudgedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nudge_logs" ADD CONSTRAINT "nudge_logs_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

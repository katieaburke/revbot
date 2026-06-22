-- AlterTable
ALTER TABLE "meddpicc_stage_requirements" ADD COLUMN     "requireAuthority" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireBudget" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireNeed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireTiming" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sfdcFieldAuthority" TEXT NOT NULL DEFAULT 'Authority_Details__c',
ADD COLUMN     "sfdcFieldBudget" TEXT NOT NULL DEFAULT 'Budget_Details__c',
ADD COLUMN     "sfdcFieldNeed" TEXT NOT NULL DEFAULT 'Need_Details__c',
ADD COLUMN     "sfdcFieldTiming" TEXT NOT NULL DEFAULT 'Timing_Details__c';

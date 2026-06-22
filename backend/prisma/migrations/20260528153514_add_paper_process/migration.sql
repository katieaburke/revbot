-- AlterTable
ALTER TABLE "meddpicc_stage_requirements" ADD COLUMN     "requirePaperProcess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sfdcFieldPaperProcess" TEXT NOT NULL DEFAULT 'P_Paperwork__c',
ALTER COLUMN "sfdcFieldMetrics" SET DEFAULT 'M_Metrics__c',
ALTER COLUMN "sfdcFieldEconomicBuyer" SET DEFAULT 'E_Economic_buyer__c',
ALTER COLUMN "sfdcFieldDecisionCriteria" SET DEFAULT 'DC_Decision_Criteria__c',
ALTER COLUMN "sfdcFieldDecisionProcess" SET DEFAULT 'DP_Decision_Process__c',
ALTER COLUMN "sfdcFieldIdentifyPain" SET DEFAULT 'I_Identify_Pain__c',
ALTER COLUMN "sfdcFieldChampion" SET DEFAULT 'Ch_Champion__c',
ALTER COLUMN "sfdcFieldCompetition" SET DEFAULT 'Co_Competition_New__c';

-- Add opportunityType to stall_thresholds_by_stage
ALTER TABLE "stall_thresholds_by_stage" ADD COLUMN "opportunityType" TEXT NOT NULL DEFAULT 'All';

-- Drop old unique constraint if it exists, add new composite one
ALTER TABLE "stall_thresholds_by_stage" DROP CONSTRAINT IF EXISTS "stall_thresholds_by_stage_stageName_key";
ALTER TABLE "stall_thresholds_by_stage" ADD CONSTRAINT "stall_thresholds_by_stage_stageName_opportunityType_key" UNIQUE ("stageName", "opportunityType");

-- Add opportunityType to meddpicc_stage_requirements
ALTER TABLE "meddpicc_stage_requirements" ADD COLUMN "opportunityType" TEXT NOT NULL DEFAULT 'All';

-- Drop old unique constraint if it exists, add new composite one
ALTER TABLE "meddpicc_stage_requirements" DROP CONSTRAINT IF EXISTS "meddpicc_stage_requirements_stageName_key";
ALTER TABLE "meddpicc_stage_requirements" ADD CONSTRAINT "meddpicc_stage_requirements_stageName_opportunityType_key" UNIQUE ("stageName", "opportunityType");

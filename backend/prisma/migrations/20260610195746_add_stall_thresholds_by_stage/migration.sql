-- CreateTable
CREATE TABLE "stall_thresholds_by_stage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "stageName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stageDurationThresholdDays" INTEGER,
    "dealAgeThresholdDays" INTEGER,

    CONSTRAINT "stall_thresholds_by_stage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stall_thresholds_by_stage_stageName_key" ON "stall_thresholds_by_stage"("stageName");

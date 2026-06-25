CREATE TABLE "flag_snapshots" (
  "id"            TEXT NOT NULL,
  "runAt"         TIMESTAMP(3) NOT NULL,
  "opportunityId" TEXT NOT NULL,
  "alertType"     "AlertType" NOT NULL,
  "ownerEmail"    TEXT NOT NULL,
  "ownerName"     TEXT,
  "managerEmail"  TEXT,
  "managerName"   TEXT,
  CONSTRAINT "flag_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "flag_snapshots_runAt_idx"        ON "flag_snapshots"("runAt");
CREATE INDEX "flag_snapshots_ownerEmail_idx"   ON "flag_snapshots"("ownerEmail");
CREATE INDEX "flag_snapshots_managerEmail_idx" ON "flag_snapshots"("managerEmail");

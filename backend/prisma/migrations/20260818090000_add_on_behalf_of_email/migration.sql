-- Nullable, no default: existing rows are all ordinary sessions, and null is
-- exactly what "not an on-behalf-of session" means. Safe to deploy while the
-- old backend is still serving.
ALTER TABLE "territory_validations" ADD COLUMN "onBehalfOfEmail" TEXT;

-- CreateIndex
CREATE INDEX "territory_validations_onBehalfOfEmail_idx" ON "territory_validations"("onBehalfOfEmail");

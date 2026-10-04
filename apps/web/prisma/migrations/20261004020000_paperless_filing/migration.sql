ALTER TABLE "EmailAccount" ADD COLUMN "filingDestination" TEXT NOT NULL DEFAULT 'cloud';
ALTER TABLE "DriveConnection" ADD COLUMN "baseUrl" TEXT;
ALTER TABLE "DocumentFiling"
  ADD COLUMN "paperlessTaskId" TEXT,
  ADD COLUMN "paperlessUploadStartedAt" TIMESTAMP(3),
  ADD COLUMN "paperlessNotifyOnCompletion" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "webUrl" TEXT,
  ADD COLUMN "errorMessage" TEXT;
CREATE INDEX "DocumentFiling_status_updatedAt_idx" ON "DocumentFiling"("status", "updatedAt");

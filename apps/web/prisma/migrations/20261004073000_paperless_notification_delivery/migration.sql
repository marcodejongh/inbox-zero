ALTER TABLE "DocumentFiling"
  ADD COLUMN "paperlessNotifiedChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "paperlessReconcileLeaseId" TEXT,
  ADD COLUMN "paperlessReconcileLeaseUntil" TIMESTAMP(3);

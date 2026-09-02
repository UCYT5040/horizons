-- AlterTable
ALTER TABLE "global_settings" ADD COLUMN     "submission_whitelist" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "total_submissions_frozen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "total_submissions_frozen_at" TIMESTAMP(3),
ADD COLUMN     "total_submissions_frozen_by" TEXT;


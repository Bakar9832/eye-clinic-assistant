-- Staff mark a new prescription's glasses as ready; the patient gets one email.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'GLASSES_READY';

-- AlterTable
ALTER TABLE "outcomes" ADD COLUMN     "glasses_ready_at" TIMESTAMPTZ(3);

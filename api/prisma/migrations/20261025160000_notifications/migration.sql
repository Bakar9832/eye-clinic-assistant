-- Emails the clinic sends on its own: appointment reminders and the yearly check-up.
-- A row is a claim written before sending; the unique (type, dedupe_key) makes each
-- email go out once, even with two workers.

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPOINTMENT_REMINDER', 'ANNUAL_CHECKUP');

-- AlterTable
ALTER TABLE "appointment_types" ADD COLUMN     "annual_reminder" BOOLEAN NOT NULL DEFAULT false;

-- Existing clinics: the yearly visits are the routine tests and the child's exam.
UPDATE "appointment_types" SET "annual_reminder" = true
WHERE "code" IN ('ROUTINE_EYE_TEST', 'ROUTINE_EYE_TEST_WITH_SCAN', 'CHILD_EYE_EXAM');

-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "annual_reminder_months" INTEGER NOT NULL DEFAULT 11,
ADD COLUMN     "reminder_hours_before" INTEGER NOT NULL DEFAULT 24;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID,
    "claimed_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_patient_id_idx" ON "notifications"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_type_dedupe_key_key" ON "notifications"("type", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

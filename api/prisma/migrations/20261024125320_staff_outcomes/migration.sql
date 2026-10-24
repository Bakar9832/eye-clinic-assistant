-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('DOCTOR', 'RECEPTION', 'ADMIN');

-- CreateEnum
CREATE TYPE "LoginPurpose" AS ENUM ('PATIENT', 'STAFF');

-- CreateEnum
CREATE TYPE "OutcomeCode" AS ENUM ('NO_CHANGE', 'NEW_PRESCRIPTION', 'FOLLOW_UP_6_MONTHS', 'REFERRAL_TO_SPECIALIST');

-- DropIndex
DROP INDEX "login_codes_email_created_at_idx";

-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "outcome_edit_window_hours" INTEGER NOT NULL DEFAULT 72;

-- AlterTable
ALTER TABLE "login_codes" ADD COLUMN     "purpose" "LoginPurpose" NOT NULL DEFAULT 'PATIENT';

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "dob_failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dob_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "staff_user_id" UUID,
ALTER COLUMN "patient_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "staff_users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "resource_id" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "code" "OutcomeCode" NOT NULL,
    "patient_note" TEXT NOT NULL,
    "recorded_by_staff_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "corrected_at" TIMESTAMPTZ(3),

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_resource_id_key" ON "staff_users"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "outcomes_appointment_id_key" ON "outcomes"("appointment_id");

-- CreateIndex
CREATE INDEX "login_codes_email_purpose_created_at_idx" ON "login_codes"("email", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "sessions_staff_user_id_idx" ON "sessions"("staff_user_id");

-- AddForeignKey
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_recorded_by_staff_id_fkey" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written rules below.
-- ===========================================================================

-- A session belongs to exactly one patient or one staff member, never both, never neither.
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_one_owner" CHECK (num_nonnulls("patient_id", "staff_user_id") = 1),
  ADD CONSTRAINT "sessions_dob_attempts" CHECK ("dob_failed_attempts" >= 0);

ALTER TABLE "staff_users"
  ADD CONSTRAINT "staff_users_email_normalised" CHECK ("email" = lower(btrim("email"))),
  -- Doctors are bookable resources; reception and admin are not.
  ADD CONSTRAINT "staff_users_doctor_has_resource" CHECK (("role" = 'DOCTOR') = ("resource_id" IS NOT NULL));

ALTER TABLE "outcomes"
  ADD CONSTRAINT "outcomes_note_length" CHECK (char_length("patient_note") BETWEEN 1 AND 500),
  ADD CONSTRAINT "outcomes_corrected_after_recorded" CHECK ("corrected_at" IS NULL OR "corrected_at" >= "recorded_at");

ALTER TABLE "clinic_settings"
  ADD CONSTRAINT "clinic_settings_outcome_edit_window" CHECK ("outcome_edit_window_hours" BETWEEN 1 AND 720);

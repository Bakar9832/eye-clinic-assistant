/*
  Warnings:

  - You are about to drop the column `reserved_min` on the `appointment_types` table. All the data in the column will be lost.
  - Made the column `duration_min` on table `appointment_type_steps` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "Skill" AS ENUM ('PRETEST', 'SCAN');

-- AlterTable
ALTER TABLE "appointment_type_steps" ADD COLUMN     "required_skill" "Skill",
ALTER COLUMN "duration_min" SET NOT NULL;

-- Hand-written: reserved_min is gone (reserved time = where the last step ends),
-- so the triggers that checked steps against it go too. Dropping the column also
-- drops the appointment_types_lengths CHECK that referenced it.
DROP TRIGGER "appointment_types_steps_fit" ON "appointment_types";
DROP TRIGGER "appointment_type_steps_fit" ON "appointment_type_steps";
DROP FUNCTION trg_steps_fit_on_type();
DROP FUNCTION trg_steps_fit_on_step();
DROP FUNCTION check_steps_fit_reserved(uuid);

-- AlterTable
ALTER TABLE "appointment_types" DROP COLUMN "reserved_min";

-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "offer_recheck_after_new_prescription" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "resources" ADD COLUMN     "skills" "Skill"[];

-- ===========================================================================
-- Hand-written rules below.
-- ===========================================================================

ALTER TABLE "appointment_types"
  ADD CONSTRAINT "appointment_types_typical" CHECK ("typical_min" > 0 AND "typical_min" <= 180);

-- Skills describe technicians, so only technician steps may require one.
ALTER TABLE "appointment_type_steps"
  ADD CONSTRAINT "appointment_type_steps_skill_kind"
  CHECK ("required_skill" IS NULL OR "resource_kind" = 'TECHNICIAN');

-- Staff log in with a password since the email + password change, so every login code
-- is a patient's (sign-up or password reset): the purpose column always held PATIENT.
-- Login codes live a day at most (retention), so nothing of value is dropped.

-- DropIndex
DROP INDEX "login_codes_email_purpose_created_at_idx";

-- AlterTable
ALTER TABLE "login_codes" DROP COLUMN "purpose";

-- DropEnum
DROP TYPE "LoginPurpose";

-- CreateIndex
CREATE INDEX "login_codes_email_created_at_idx" ON "login_codes"("email", "created_at");

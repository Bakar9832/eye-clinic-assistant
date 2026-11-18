-- Email + password login: hashes for patients and staff, and a table of failed
-- logins for the rate limits (deleted after a day by the retention job).

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "password_hash" TEXT;

-- AlterTable
ALTER TABLE "staff_users" ADD COLUMN     "password_hash" TEXT;

-- CreateTable
CREATE TABLE "login_failures" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "login_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_failures_email_created_at_idx" ON "login_failures"("email", "created_at");

-- CreateIndex
CREATE INDEX "login_failures_ip_created_at_idx" ON "login_failures"("ip", "created_at");

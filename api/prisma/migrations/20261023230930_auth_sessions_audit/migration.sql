-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('PATIENT', 'STAFF', 'SYSTEM');

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "full_name" DROP NOT NULL,
ALTER COLUMN "date_of_birth" DROP NOT NULL;

-- CreateTable
CREATE TABLE "login_codes" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "request_ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "login_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "ip" TEXT,
    "details" JSONB,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_codes_email_created_at_idx" ON "login_codes"("email", "created_at");

-- CreateIndex
CREATE INDEX "login_codes_request_ip_created_at_idx" ON "login_codes"("request_ip", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_patient_id_idx" ON "sessions"("patient_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_type_actor_id_at_idx" ON "audit_events"("actor_type", "actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_idx" ON "audit_events"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written rules below.
-- ===========================================================================

-- One person = one account: emails are stored trimmed and lower-case.
ALTER TABLE "patients"
  ADD CONSTRAINT "patients_email_normalised" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "login_codes"
  ADD CONSTRAINT "login_codes_email_normalised" CHECK ("email" = lower(btrim("email")));

ALTER TABLE "login_codes"
  ADD CONSTRAINT "login_codes_valid" CHECK ("expires_at" > "created_at" AND "attempts" >= 0);
ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_valid" CHECK ("expires_at" > "created_at");

-- The audit log is append-only: history can be added to, never rewritten.
CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_events_no_update_or_delete"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

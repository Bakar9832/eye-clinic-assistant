-- Phase 2b: the guardrail log (refused patient actions and other flags) for staff review.

-- CreateEnum
CREATE TYPE "GuardrailKind" AS ENUM ('BLOCKED', 'URGENT_SYMPTOMS', 'URGENCY_CLAIM', 'STALLED', 'CHAT_CAP');

-- CreateTable
CREATE TABLE "guardrail_events" (
    "id" UUID NOT NULL,
    "kind" "GuardrailKind" NOT NULL,
    "patient_id" UUID,
    "conversation_id" UUID,
    "action" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "guardrail_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guardrail_events_created_at_idx" ON "guardrail_events"("created_at");

-- CreateIndex
CREATE INDEX "guardrail_events_patient_id_kind_created_at_idx" ON "guardrail_events"("patient_id", "kind", "created_at");

-- AddForeignKey
ALTER TABLE "guardrail_events" ADD CONSTRAINT "guardrail_events_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

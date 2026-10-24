-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "applies_to" "OutcomeCode"[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers_shown" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "outcome_id" UUID NOT NULL,
    "shown_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offers_shown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoff_requests" (
    "id" UUID NOT NULL,
    "patient_id" UUID,
    "conversation_id" UUID,
    "reason" TEXT NOT NULL,
    "status" "HandoffStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "handoff_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "patient_id" UUID,
    "anon_key_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "ChatRole" NOT NULL,
    "text" TEXT NOT NULL,
    "cards" JSONB,
    "request_ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offers_code_key" ON "offers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "offers_shown_offer_id_outcome_id_key" ON "offers_shown"("offer_id", "outcome_id");

-- CreateIndex
CREATE INDEX "handoff_requests_status_created_at_idx" ON "handoff_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "conversations_patient_id_idx" ON "conversations"("patient_id");

-- CreateIndex
CREATE INDEX "conversations_anon_key_hash_idx" ON "conversations"("anon_key_hash");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_created_at_idx" ON "chat_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "offers_shown" ADD CONSTRAINT "offers_shown_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers_shown" ADD CONSTRAINT "offers_shown_outcome_id_fkey" FOREIGN KEY ("outcome_id") REFERENCES "outcomes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written rules below.
-- ===========================================================================

-- A conversation belongs to a patient or to an anonymous browser, never both or neither.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_one_owner" CHECK (num_nonnulls("patient_id", "anon_key_hash") = 1);

ALTER TABLE "chat_messages"
  ADD CONSTRAINT "chat_messages_text_length" CHECK (char_length("text") BETWEEN 1 AND 8000);

ALTER TABLE "handoff_requests"
  ADD CONSTRAINT "handoff_requests_reason_length" CHECK (char_length("reason") BETWEEN 1 AND 500);

-- Messages are ordered by a database sequence, not by timestamp: timestamps can tie.
-- SERIAL numbers the existing rows too, so the unique index can be added safely.

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN "seq" SERIAL NOT NULL;

-- DropIndex
DROP INDEX "chat_messages_conversation_id_created_at_idx";

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_seq_key" ON "chat_messages"("seq");

-- CreateIndex
CREATE INDEX "chat_messages_conversation_id_seq_idx" ON "chat_messages"("conversation_id", "seq");

-- How long chats (after their last message) and closed handoffs are kept.

-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "chat_retention_days" INTEGER NOT NULL DEFAULT 30;

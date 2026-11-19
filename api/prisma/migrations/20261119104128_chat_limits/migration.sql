-- Phase 2d: the site-wide daily chat cap and the stalled-conversation threshold, as clinic settings.

-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "daily_chat_message_cap" INTEGER NOT NULL DEFAULT 150,
ADD COLUMN     "stall_message_threshold" INTEGER NOT NULL DEFAULT 12;

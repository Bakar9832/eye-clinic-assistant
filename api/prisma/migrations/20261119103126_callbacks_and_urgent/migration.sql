-- Phase 2c: callback requests and urgent alerts (handoff kind, preferred time), and the
-- "attention needed" flag on appointments booked in a chat that mentioned urgent symptoms.

-- CreateEnum
CREATE TYPE "HandoffKind" AS ENUM ('HANDOFF', 'CALLBACK', 'URGENT');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "attention_reason" TEXT;

-- AlterTable
ALTER TABLE "handoff_requests" ADD COLUMN     "kind" "HandoffKind" NOT NULL DEFAULT 'HANDOFF',
ADD COLUMN     "preferred_time" TEXT;

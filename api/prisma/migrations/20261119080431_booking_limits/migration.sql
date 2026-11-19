-- Phase 2 booking rules: per-day limit and booking rate limit, as clinic settings.
-- Also adds the Family check-up type to databases seeded before it existed (the live
-- demo). Fresh databases get it from the seed; ON CONFLICT keeps this a no-op there.

-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "booking_action_limit" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "booking_action_window_min" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "max_appointments_per_day" INTEGER NOT NULL DEFAULT 1;

-- Family check-up: technician pre-tests (20 min), then a paediatric-trained doctor (40 min).
INSERT INTO "appointment_types" ("id", "code", "name", "typical_min", "prep_instructions", "is_urgent", "annual_reminder", "active")
VALUES (
  gen_random_uuid(), 'FAMILY_CHECK_UP', 'Family check-up', 55,
  'For up to 3 family members. A parent or guardian must come with any children. Each person should bring their current glasses or contact lenses and a list of any medicines they take.',
  false, true, true
)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "appointment_type_steps" ("id", "appointment_type_id", "position", "resource_kind", "required_skill", "offset_min", "duration_min")
SELECT gen_random_uuid(), t."id", s."position", s."kind"::"ResourceKind", s."skill"::"Skill", s."offset_min", s."duration_min"
FROM "appointment_types" t
CROSS JOIN (VALUES (1, 'TECHNICIAN', 'PRETEST', 0, 20), (2, 'OPTOMETRIST', 'PAEDIATRIC', 20, 40))
  AS s("position", "kind", "skill", "offset_min", "duration_min")
WHERE t."code" = 'FAMILY_CHECK_UP'
  AND NOT EXISTS (SELECT 1 FROM "appointment_type_steps" x WHERE x."appointment_type_id" = t."id");

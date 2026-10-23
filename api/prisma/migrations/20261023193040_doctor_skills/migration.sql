-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Skill" ADD VALUE 'CONTACT_LENS';
ALTER TYPE "Skill" ADD VALUE 'PAEDIATRIC';

-- ===========================================================================
-- Hand-written rules below. Skills are compared as text because Postgres won't
-- let a new enum value be used in the transaction that adds it.
-- ===========================================================================

-- Each kind of resource may only have its own kind of skill.
ALTER TABLE "resources"
  ADD CONSTRAINT "resources_skills_match_kind" CHECK (
    "skills" IS NULL
    OR ("kind" = 'TECHNICIAN'  AND "skills"::text[] <@ ARRAY['PRETEST', 'SCAN'])
    OR ("kind" = 'OPTOMETRIST' AND "skills"::text[] <@ ARRAY['CONTACT_LENS', 'PAEDIATRIC'])
    OR ("kind" = 'SCANNER'     AND cardinality("skills") = 0)
  );

-- A step may only require a skill that its kind of resource can have.
ALTER TABLE "appointment_type_steps" DROP CONSTRAINT "appointment_type_steps_skill_kind";
ALTER TABLE "appointment_type_steps"
  ADD CONSTRAINT "appointment_type_steps_skill_kind" CHECK (
    "required_skill" IS NULL
    OR ("resource_kind" = 'TECHNICIAN'  AND "required_skill"::text IN ('PRETEST', 'SCAN'))
    OR ("resource_kind" = 'OPTOMETRIST' AND "required_skill"::text IN ('CONTACT_LENS', 'PAEDIATRIC'))
  );

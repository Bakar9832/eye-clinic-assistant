-- Hand-written: needed so a GiST index can compare resource_id with "=" in the exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "ResourceKind" AS ENUM ('OPTOMETRIST', 'TECHNICIAN', 'SCANNER');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('BOOKED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "clinic_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "slot_grid_min" INTEGER NOT NULL DEFAULT 15,

    CONSTRAINT "clinic_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL,
    "kind" "ResourceKind" NOT NULL,
    "display_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_min" INTEGER NOT NULL,
    "end_min" INTEGER NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "typical_min" INTEGER NOT NULL,
    "reserved_min" INTEGER NOT NULL,
    "prep_instructions" TEXT NOT NULL,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "appointment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_type_steps" (
    "id" UUID NOT NULL,
    "appointment_type_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "resource_kind" "ResourceKind" NOT NULL,
    "offset_min" INTEGER NOT NULL,
    "duration_min" INTEGER,

    CONSTRAINT "appointment_type_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "appointment_type_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'BOOKED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_allocations" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "resource_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "working_hours_resource_id_weekday_idx" ON "working_hours"("resource_id", "weekday");

-- CreateIndex
CREATE INDEX "time_off_resource_id_idx" ON "time_off"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_types_code_key" ON "appointment_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_type_steps_appointment_type_id_position_key" ON "appointment_type_steps"("appointment_type_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "patients_email_key" ON "patients"("email");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_reference_key" ON "appointments"("reference");

-- CreateIndex
CREATE INDEX "appointments_patient_id_idx" ON "appointments"("patient_id");

-- CreateIndex
CREATE INDEX "resource_allocations_appointment_id_idx" ON "resource_allocations"("appointment_id");

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_type_steps" ADD CONSTRAINT "appointment_type_steps_appointment_type_id_fkey" FOREIGN KEY ("appointment_type_id") REFERENCES "appointment_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_appointment_type_id_fkey" FOREIGN KEY ("appointment_type_id") REFERENCES "appointment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_allocations" ADD CONSTRAINT "resource_allocations_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-written rules below. Prisma cannot express these in schema.prisma.
-- ===========================================================================

-- No double booking: two ACTIVE allocations for the same resource may not
-- overlap. '[)' means a range includes its start but not its end, so a
-- 10:00-10:40 booking and a 10:40-11:20 booking can sit back to back.
ALTER TABLE "resource_allocations"
  ADD CONSTRAINT "resource_allocations_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  ) WHERE ("active");

-- Safety net against overnight or runaway bookings.
ALTER TABLE "resource_allocations"
  ADD CONSTRAINT "resource_allocations_valid_range"
  CHECK ("ends_at" > "starts_at" AND "ends_at" - "starts_at" <= interval '3 hours');

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_valid_range"
  CHECK ("ends_at" > "starts_at" AND "ends_at" - "starts_at" <= interval '3 hours');

ALTER TABLE "time_off"
  ADD CONSTRAINT "time_off_valid_range" CHECK ("ends_at" > "starts_at");

ALTER TABLE "clinic_settings"
  ADD CONSTRAINT "clinic_settings_single_row" CHECK ("id" = 1),
  ADD CONSTRAINT "clinic_settings_grid" CHECK ("slot_grid_min" BETWEEN 5 AND 60 AND 60 % "slot_grid_min" = 0);

ALTER TABLE "working_hours"
  ADD CONSTRAINT "working_hours_weekday" CHECK ("weekday" BETWEEN 1 AND 7),
  ADD CONSTRAINT "working_hours_window" CHECK ("start_min" >= 0 AND "start_min" < "end_min" AND "end_min" <= 1440);

ALTER TABLE "appointment_types"
  ADD CONSTRAINT "appointment_types_lengths"
  CHECK ("typical_min" > 0 AND "reserved_min" >= "typical_min" AND "reserved_min" <= 180);

ALTER TABLE "appointment_type_steps"
  ADD CONSTRAINT "appointment_type_steps_values"
  CHECK ("offset_min" >= 0 AND ("duration_min" IS NULL OR "duration_min" > 0));

-- Every step must fit inside the type's reserved time. This spans two tables,
-- so it needs triggers instead of a CHECK: one fires when a step changes, the
-- other when an admin shortens reserved_min.
CREATE FUNCTION check_steps_fit_reserved(type_id uuid) RETURNS void AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "appointment_type_steps" s
    JOIN "appointment_types" t ON t."id" = s."appointment_type_id"
    WHERE t."id" = type_id
      AND (s."offset_min" >= t."reserved_min"
           OR s."offset_min" + COALESCE(s."duration_min", 0) > t."reserved_min")
  ) THEN
    RAISE EXCEPTION 'appointment type % has a step that does not fit inside reserved_min', type_id
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION trg_steps_fit_on_step() RETURNS trigger AS $$
BEGIN
  PERFORM check_steps_fit_reserved(NEW."appointment_type_id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION trg_steps_fit_on_type() RETURNS trigger AS $$
BEGIN
  PERFORM check_steps_fit_reserved(NEW."id");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "appointment_type_steps_fit"
  AFTER INSERT OR UPDATE ON "appointment_type_steps"
  FOR EACH ROW EXECUTE FUNCTION trg_steps_fit_on_step();

CREATE TRIGGER "appointment_types_steps_fit"
  AFTER UPDATE OF "reserved_min" ON "appointment_types"
  FOR EACH ROW EXECUTE FUNCTION trg_steps_fit_on_type();

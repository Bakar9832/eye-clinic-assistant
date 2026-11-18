// Seeds the development database with synthetic data only.
// Safe to re-run: it wipes the clinic tables first.
// Run with: npx prisma db seed
// Needs SEED_PATIENT_PASSWORD and SEED_STAFF_PASSWORD in .env: every seeded patient and
// staff member gets one of them, so you can log in without email. They are never in the repo.

import path from 'node:path';
import { config } from 'dotenv';
import { DateTime } from 'luxon';
import { AuditService } from '../src/audit/audit.service.js';
import { hashPassword, PASSWORD_MIN } from '../src/auth/password.js';
import { AvailabilityService } from '../src/availability/availability.service.js';
import { BookingService } from '../src/booking/booking.service.js';
import { generateReference } from '../src/booking/reference.js';
import { SystemClock } from '../src/clock.js';
import { createPrismaClient } from '../src/prisma/create-client.js';
import { BILAL_DAYS, hours, MON_FRI, seedClinic } from './clinic-data.js';

config({ path: path.resolve(import.meta.dirname, '..', '..', '.env') });

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database.');
}

/** Checked before anything is wiped, so a missing setting can't leave an empty database. */
function seedPassword(name: string) {
  const value = process.env[name] ?? '';
  if (value.length < PASSWORD_MIN) throw new Error(`Set ${name} in .env (at least ${PASSWORD_MIN} characters) before seeding.`);
  return value;
}
const patientPassword = seedPassword('SEED_PATIENT_PASSWORD');
const staffPassword = seedPassword('SEED_STAFF_PASSWORD');

const prisma = createPrismaClient(process.env.DATABASE_URL!);

// Starting value only: the zone of the machine running the seed.
// Admins change it in clinic_settings; nothing in the code depends on it.
const clinicTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Next date (after today, in clinic time) that falls on one of the given weekdays. */
function nextDay(weekdays: number[], after: DateTime = DateTime.now().setZone(clinicTimezone)): DateTime {
  let day = after.startOf('day').plus({ days: 1 });
  while (!weekdays.includes(day.weekday)) day = day.plus({ days: 1 });
  return day;
}

const at = (day: DateTime, time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  return day.set({ hour, minute }).toJSDate();
};
const plusMin = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

async function main() {
  const { resources, types, patients, staff } = await seedClinic(prisma, clinicTimezone);
  const { ayesha, bilal, sara, scanner } = resources;

  // Dr Bilal is on leave for one full working day next week.
  const bilalLeaveDay = nextDay(BILAL_DAYS, DateTime.now().setZone(clinicTimezone).plus({ days: 7 }));
  await prisma.timeOff.create({
    data: {
      resourceId: bilal.id,
      startsAt: bilalLeaveDay.toJSDate(),
      endsAt: bilalLeaveDay.plus({ days: 1 }).toJSDate(),
      reason: 'Annual leave',
    },
  });

  // --- Sample bookings -----------------------------------------------------
  // Booked: routine test with scan, Dr Ayesha, next weekday 10:00 clinic time.
  // Sara pre-test 10:00-10:10, Dr Ayesha 10:10-10:30, scanner + Sara 10:30-10:40.
  // Dr Ayesha is free again from 10:30 while this patient is being scanned.
  const visitStart = at(nextDay(MON_FRI), '10:00');
  await prisma.appointment.create({
    data: {
      reference: generateReference(),
      patientId: patients.demo.id,
      appointmentTypeId: types.ROUTINE_EYE_TEST_WITH_SCAN.id,
      startsAt: visitStart,
      endsAt: plusMin(visitStart, 40),
      allocations: {
        create: [
          { resourceId: sara.id, startsAt: visitStart, endsAt: plusMin(visitStart, 10) },
          { resourceId: ayesha.id, startsAt: plusMin(visitStart, 10), endsAt: plusMin(visitStart, 30) },
          { resourceId: scanner.id, startsAt: plusMin(visitStart, 30), endsAt: plusMin(visitStart, 40) },
          { resourceId: sara.id, startsAt: plusMin(visitStart, 30), endsAt: plusMin(visitStart, 40) },
        ],
      },
    },
  });

  // Cancelled: contact lens fitting with Dr Bilal. Its allocation is inactive,
  // so the slot is free again but the history is kept.
  const lensStart = at(nextDay(BILAL_DAYS), '15:00');
  await prisma.appointment.create({
    data: {
      reference: generateReference(),
      patientId: patients.demo.id,
      appointmentTypeId: types.CONTACT_LENS_FITTING.id,
      startsAt: lensStart,
      endsAt: plusMin(lensStart, 45),
      status: 'CANCELLED',
      cancelledAt: new Date(),
      allocations: {
        create: [{ resourceId: bilal.id, startsAt: lensStart, endsAt: plusMin(lensStart, 45), active: false }],
      },
    },
  });

  // Past visit with a result already recorded, so the demo can show results straight away.
  // Last week's weekday, 11:00: pre-test with Sara, exam with Dr Ayesha.
  let lastWeek = DateTime.now().setZone(clinicTimezone).startOf('day').minus({ days: 7 });
  while (!MON_FRI.includes(lastWeek.weekday)) lastWeek = lastWeek.minus({ days: 1 });
  const pastStart = at(lastWeek, '11:00');
  await prisma.appointment.create({
    data: {
      reference: generateReference(),
      patientId: patients.demo.id,
      appointmentTypeId: types.ROUTINE_EYE_TEST.id,
      startsAt: pastStart,
      endsAt: plusMin(pastStart, 30),
      status: 'COMPLETED',
      allocations: {
        create: [
          { resourceId: sara.id, startsAt: pastStart, endsAt: plusMin(pastStart, 10) },
          { resourceId: ayesha.id, startsAt: plusMin(pastStart, 10), endsAt: plusMin(pastStart, 30) },
        ],
      },
      outcome: {
        create: {
          code: 'NEW_PRESCRIPTION',
          patientNote:
            'Your eyesight has changed a little since your last test. New glasses will make reading easier. ' +
            'Please come back for a check in 12 months, or sooner if anything changes.',
          recordedByStaffId: staff.drAyesha.id,
          recordedAt: plusMin(pastStart, 35),
        },
      },
    },
  });

  const booked = await seedBusierCalendar();

  // Each account hashed separately, so each gets its own salt.
  for (const { id } of await prisma.patient.findMany({ select: { id: true } })) {
    await prisma.patient.update({ where: { id }, data: { passwordHash: await hashPassword(patientPassword) } });
  }
  for (const { id } of await prisma.staffUser.findMany({ select: { id: true } })) {
    await prisma.staffUser.update({ where: { id }, data: { passwordHash: await hashPassword(staffPassword) } });
  }
  console.log(`Seeded clinic (timezone ${clinicTimezone}), plus a third doctor and ${booked} bookings for other patients.`);
}

/**
 * Demo only (the tests use seedClinic alone): a third doctor and more made-up patients
 * with bookings over the next two weeks, so the calendar looks like a working clinic.
 * Booked through BookingService, so every booking follows the real rules.
 */
async function seedBusierCalendar() {
  const hamza = await prisma.resource.create({
    data: { kind: 'OPTOMETRIST', displayName: 'Dr Hamza', skills: [], workingHours: { create: hours(MON_FRI, '09:00', '17:00') } },
  });
  await prisma.staffUser.create({ data: { email: 'dr.hamza@clinic.example', displayName: 'Dr Hamza', role: 'DOCTOR', resourceId: hamza.id } });

  // example.com is reserved for documentation: these can never be real inboxes.
  const people = [
    ['Amna Rashid', 'amna.rashid@example.com', '1978-03-11'],
    ['Bilal Ahmed', 'bilal.ahmed@example.com', '1992-11-02'],
    ['Farah Khan', 'farah.khan@example.com', '1965-07-23'],
    ['Omar Siddiqui', 'omar.siddiqui@example.com', '2001-01-30'],
    ['Zainab Ali', 'zainab.ali@example.com', '1988-05-17'],
  ] as const;
  const patients = [];
  for (const [fullName, email, dateOfBirth] of people) {
    patients.push(await prisma.patient.create({ data: { fullName, email, dateOfBirth: new Date(dateOfBirth) } }));
  }

  const clock = new SystemClock();
  const availability = new AvailabilityService(prisma);
  const booking = new BookingService(prisma, availability, new AuditService(prisma, clock));
  const plan = ['ROUTINE_EYE_TEST', 'FOLLOW_UP', 'ROUTINE_EYE_TEST_WITH_SCAN', 'CONTACT_LENS_FITTING', 'FOLLOW_UP'];

  // Two bookings each, on different days: one in the coming week, one in the week after.
  let made = 0;
  let day = nextDay(MON_FRI);
  for (let round = 0; round < 2; round++) {
    for (const [i, patient] of patients.entries()) {
      const typeCode = plan[(i + round) % plan.length];
      for (let tries = 0; tries < 5; tries++, day = nextDay(MON_FRI, day)) {
        const { slots } = await availability.getSlots({ typeCode, day: day.toISODate()!, now: clock.now() });
        // A spread of times, not always the first free one.
        const slot = slots[(i * 7 + round * 3) % Math.max(slots.length, 1)];
        if (!slot) continue;
        await booking.book(patient.id, { typeCode, start: slot.start }, clock.now());
        made++;
        day = nextDay(MON_FRI, day);
        break;
      }
    }
  }
  return made;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

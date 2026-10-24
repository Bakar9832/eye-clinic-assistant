// Seeds the development database with synthetic data only.
// Safe to re-run: it wipes the clinic tables first.
// Run with: npx prisma db seed

import path from 'node:path';
import { config } from 'dotenv';
import { DateTime } from 'luxon';
import { createPrismaClient } from '../src/prisma/create-client.js';
import { generateReference } from '../src/booking/reference.js';
import { BILAL_DAYS, MON_FRI, seedClinic } from './clinic-data.js';

config({ path: path.resolve(import.meta.dirname, '..', '..', '.env') });

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database.');
}

const prisma = createPrismaClient(process.env.DATABASE_URL!);

// Starting value only: the zone of the machine running the seed.
// Admins change it in clinic_settings; nothing in the code depends on it.
const clinicTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Next date (after today, in clinic time) that falls on one of the given weekdays. */
function nextDay(weekdays: number[], after = DateTime.now().setZone(clinicTimezone)): DateTime {
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

  console.log(`Seeded clinic (timezone ${clinicTimezone}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

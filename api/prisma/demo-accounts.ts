// Three ready-to-use accounts for testers, with data to look at. Safe to re-run: it never
// wipes anything; a second run only resets the three passwords. Made-up people only.
//
//   cd api
//   $env:DATABASE_URL = '<the database>'          (omit for the local one in .env)
//   $env:DEMO_ACCOUNTS_PASSWORD = '<password>'     (kept out of the repo and shell history)
//   npm run demo-accounts
//   Remove-Item Env:DEMO_ACCOUNTS_PASSWORD, Env:DATABASE_URL
//
// demo.patient: a past eye test with a result (new prescription) and an upcoming follow-up.
// demo.doctor:  Dr Sana (Mon-Fri 09:00-17:00) with bookings over the next days and one past
//               visit still waiting for a result, so testers can record an outcome.
// demo.staff:   reception, with an open call-back request in Handoffs.

import path from 'node:path';
import { config } from 'dotenv';
import { DateTime } from 'luxon';
import { AuditService, SYSTEM } from '../src/audit/audit.service.js';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN } from '../src/auth/password.js';
import { AvailabilityService } from '../src/availability/availability.service.js';
import { BookingService } from '../src/booking/booking.service.js';
import { generateReference } from '../src/booking/reference.js';
import { clinicSettings } from '../src/clinic-settings.js';
import { SystemClock } from '../src/clock.js';
import { createPrismaClient } from '../src/prisma/create-client.js';
import { hours, MON_FRI } from './clinic-data.js';

config({ path: path.resolve(import.meta.dirname, '..', '..', '.env') });

const EMAILS = { patient: 'demo.patient@mail.co', doctor: 'demo.doctor@mail.co', staff: 'demo.staff@mail.co' };
const DOCTOR_NAME = 'Dr Sana';

const password = process.env.DEMO_ACCOUNTS_PASSWORD ?? '';
if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
  throw new Error(`Set DEMO_ACCOUNTS_PASSWORD (${PASSWORD_MIN}-${PASSWORD_MAX} characters) before running.`);
}

const prisma = createPrismaClient(process.env.DATABASE_URL!);
const clock = new SystemClock();
const availability = new AvailabilityService(prisma);
const booking = new BookingService(prisma, availability, new AuditService(prisma, clock));

async function main() {
  const { timezone } = await clinicSettings(prisma);
  const now = DateTime.now().setZone(timezone);

  // --- Accounts (created once; the password is set on every run) -------------
  let sana = await prisma.resource.findFirst({ where: { kind: 'OPTOMETRIST', displayName: DOCTOR_NAME } });
  const firstRun = !sana;
  sana ??= await prisma.resource.create({
    data: { kind: 'OPTOMETRIST', displayName: DOCTOR_NAME, skills: [], workingHours: { create: hours(MON_FRI, '09:00', '17:00') } },
  });

  const doctor = await prisma.staffUser.upsert({
    where: { email: EMAILS.doctor },
    create: { email: EMAILS.doctor, displayName: DOCTOR_NAME, role: 'DOCTOR', resourceId: sana.id, passwordHash: await hashPassword(password) },
    update: { passwordHash: await hashPassword(password), active: true },
  });
  await prisma.staffUser.upsert({
    where: { email: EMAILS.staff },
    create: { email: EMAILS.staff, displayName: 'Reception (testers)', role: 'RECEPTION', passwordHash: await hashPassword(password) },
    update: { passwordHash: await hashPassword(password), active: true },
  });
  const patient = await prisma.patient.upsert({
    where: { email: EMAILS.patient },
    create: { email: EMAILS.patient, fullName: 'Hina Malik', dateOfBirth: new Date('1991-04-12'), passwordHash: await hashPassword(password) },
    update: { passwordHash: await hashPassword(password) },
  });

  if (!firstRun) {
    console.log(`Passwords reset for ${Object.values(EMAILS).join(', ')} (data was created on an earlier run).`);
    return;
  }

  // --- The patient's history: a past eye test with a result --------------------
  const lastWeek = weekdayBefore(now.minus({ days: 7 }));
  const examStart = lastWeek.set({ hour: 11, minute: 0 }).toJSDate();
  await prisma.appointment.create({
    data: {
      reference: generateReference(),
      patientId: patient.id,
      appointmentTypeId: (await type('FOLLOW_UP')).id,
      startsAt: examStart,
      endsAt: plusMin(examStart, 15),
      status: 'COMPLETED',
      allocations: { create: [{ resourceId: sana.id, startsAt: examStart, endsAt: plusMin(examStart, 15) }] },
      outcome: {
        create: {
          code: 'NEW_PRESCRIPTION',
          patientNote:
            'Your eyesight has changed slightly. New glasses will make reading and screen work more comfortable. ' +
            'Please come back for a check in 12 months, or sooner if anything changes.',
          recordedByStaffId: doctor.id,
          recordedAt: plusMin(examStart, 20),
        },
      },
    },
  });

  // --- A past visit still waiting for its result (for the doctor to record) ---
  const others = await prisma.patient.findMany({
    where: { email: { not: EMAILS.patient }, fullName: { not: null }, dateOfBirth: { not: null } },
    orderBy: { email: 'asc' },
    take: 4,
  });
  const yesterday = weekdayBefore(now.minus({ days: 1 }));
  const waitingStart = yesterday.set({ hour: 15, minute: 0 }).toJSDate();
  if (others[0]) {
    await prisma.appointment.create({
      data: {
        reference: generateReference(),
        patientId: others[0].id,
        appointmentTypeId: (await type('FOLLOW_UP')).id,
        startsAt: waitingStart,
        endsAt: plusMin(waitingStart, 15),
        allocations: { create: [{ resourceId: sana.id, startsAt: waitingStart, endsAt: plusMin(waitingStart, 15) }] },
      },
    });
  }

  // --- Upcoming bookings, through the real booking rules ----------------------
  let made = 0;
  const upcoming: [string, string, string][] = [
    [patient.id, 'FOLLOW_UP', '11:00'],
    ...others.map((p, i): [string, string, string] => [p.id, i % 2 ? 'ROUTINE_EYE_TEST' : 'FOLLOW_UP', ['09:30', '10:30', '14:00', '15:30'][i]]),
  ];
  let day = weekdayAfter(now);
  for (const [patientId, typeCode, time] of upcoming) {
    for (let tries = 0; tries < 5; tries++, day = weekdayAfter(day)) {
      const start = day.set({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)) }).toJSDate();
      try {
        await booking.book(patientId, { typeCode, start, doctorId: sana.id }, clock.now(), SYSTEM);
        made++;
        break;
      } catch {
        // Taken, or this patient already has a visit that day: try the next weekday.
      }
    }
  }

  // --- Something in Handoffs for reception -------------------------------------
  await prisma.handoffRequest.create({
    data: {
      kind: 'CALLBACK',
      patientId: patient.id,
      reason: 'Would like to talk about frames for the new prescription.',
      preferredTime: 'weekday afternoons',
      createdAt: clock.now(),
    },
  });

  console.log(
    `Created ${Object.values(EMAILS).join(', ')}: ${DOCTOR_NAME}, a result for the patient, ` +
      `${made} upcoming booking(s), ${others[0] ? 'one visit waiting for a result, ' : ''}and a call-back request.`,
  );
}

async function type(code: string) {
  return prisma.appointmentType.findUniqueOrThrow({ where: { code } });
}

function weekdayBefore(day: DateTime): DateTime {
  let d = day.startOf('day');
  while (!MON_FRI.includes(d.weekday)) d = d.minus({ days: 1 });
  return d;
}

function weekdayAfter(day: DateTime): DateTime {
  let d = day.startOf('day').plus({ days: 1 });
  while (!MON_FRI.includes(d.weekday)) d = d.plus({ days: 1 });
  return d;
}

const plusMin = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

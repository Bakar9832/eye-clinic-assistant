// HTTP tests for the public endpoints, on the test database.

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DateTime } from 'luxon';
import request from 'supertest';
import { seedClinic } from '../prisma/clinic-data.js';
import { AppModule } from '../src/app.module.js';
import { BookingService } from '../src/booking/booking.service.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { testPrisma } from '../src/testing-db.js';

// A Monday far enough ahead that it is never "in the past" when the tests run.
const DAY = '2030-01-07';
const ZONE = 'Asia/Karachi';

let app: INestApplication;
let clinic: Awaited<ReturnType<typeof seedClinic>>;

beforeAll(async () => {
  const prisma = testPrisma();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaClient)
    .useValue(prisma)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

beforeEach(async () => {
  clinic = await seedClinic(app.get(PrismaClient), ZONE);
});

afterAll(async () => {
  await app.close();
});

describe('GET /clinic', () => {
  it("tells the page the clinic's name and time zone, without login", async () => {
    const res = await request(app.getHttpServer()).get('/clinic').expect(200);
    expect(res.body).toEqual({
      name: 'Demo Eye Clinic',
      timezone: ZONE,
      slotGridMin: 15,
      doctors: [
        { id: clinic.resources.ayesha.id, displayName: 'Dr Ayesha', skills: ['PAEDIATRIC'] },
        { id: clinic.resources.bilal.id, displayName: 'Dr Bilal', skills: ['CONTACT_LENS'] },
      ],
    });
  });
});

describe('GET /appointment-types', () => {
  it('28. lists every type with steps, lengths and preparation', async () => {
    const res = await request(app.getHttpServer()).get('/appointment-types').expect(200);

    expect(res.body).toHaveLength(8);
    const withScan = res.body.find((t: { code: string }) => t.code === 'ROUTINE_EYE_TEST_WITH_SCAN');
    expect(withScan).toMatchObject({ typicalMin: 35, calendarMin: 40, isUrgent: false });
    expect(withScan.prepInstructions).toContain('dilated');
    expect(withScan.steps).toHaveLength(4);
  });
});

describe('GET /availability', () => {
  it('29. returns times and the doctor only: nothing about patients or other bookings', async () => {
    // Someone already has 09:00 with Dr Ayesha.
    const booked = await app.get(BookingService).book(clinic.patients.demo.id, {
      typeCode: 'FOLLOW_UP',
      start: DateTime.fromISO(`${DAY}T09:00`, { zone: ZONE }).toJSDate(),
      doctorId: clinic.resources.ayesha.id,
    });

    const res = await request(app.getHttpServer())
      .get('/availability')
      .query({ type: 'ROUTINE_EYE_TEST_WITH_SCAN', day: DAY })
      .expect(200);

    expect(res.body.timezone).toBe(ZONE);
    expect(res.body.slots.length).toBeGreaterThan(0);
    for (const slot of res.body.slots) {
      expect(Object.keys(slot).sort()).toEqual(['doctor', 'end', 'start']);
      expect(Object.keys(slot.doctor).sort()).toEqual(['displayName', 'id']);
    }

    // No trace of the patient, their booking, or which technician/machine is used.
    const body = JSON.stringify(res.body);
    for (const secret of [
      clinic.patients.demo.fullName,
      clinic.patients.demo.email,
      clinic.patients.demo.id,
      booked.reference,
      booked.id,
      clinic.resources.sara.id,
      clinic.resources.scanner.id,
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('29b. bad input gets a clear 400, not a crash', async () => {
    const http = request(app.getHttpServer());

    await http.get('/availability').query({ day: DAY }).expect(400);
    const badDay = await http.get('/availability').query({ type: 'FOLLOW_UP', day: '07/01/2030' }).expect(400);
    expect(badDay.body.error).toBe('INVALID_DAY');
    const badType = await http.get('/availability').query({ type: 'NOPE', day: DAY }).expect(400);
    expect(badType.body.error).toBe('UNKNOWN_TYPE');
  });
});

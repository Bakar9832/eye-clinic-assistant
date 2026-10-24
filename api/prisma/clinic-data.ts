// The demo clinic: settings, staff, machines, appointment types and synthetic patients.
// Shared by the dev seed (prisma/seed.ts) and the database tests, so both use the same clinic.

import { ResourceKind, Skill } from '../src/generated/prisma/client.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const hm = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

// weekday: 1 = Monday ... 7 = Sunday
const hours = (weekdays: number[], start: string, end: string) =>
  weekdays.map((weekday) => ({ weekday, startMin: hm(start), endMin: hm(end) }));

export const MON_FRI = [1, 2, 3, 4, 5];
export const BILAL_DAYS = [1, 3, 4];

/**
 * Deletes everything, then creates the demo clinic in the given time zone.
 * The audit log is append-only and is never wiped.
 */
export async function seedClinic(prisma: PrismaClient, timezone: string) {
  // Children first, so foreign keys don't block the wipe. Sessions go with their owners.
  await prisma.loginCode.deleteMany();
  await prisma.handoffRequest.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.outcome.deleteMany();
  await prisma.resourceAllocation.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.staffUser.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.appointmentType.deleteMany();
  await prisma.resource.deleteMany();
  await prisma.clinicSetting.deleteMany();

  await prisma.clinicSetting.create({
    data: {
      id: 1,
      name: 'Demo Eye Clinic',
      timezone,
      slotGridMin: 15,
      offerRecheckAfterNewPrescription: false,
    },
  });

  // --- Resources -----------------------------------------------------------
  const ayesha = await prisma.resource.create({
    data: {
      kind: ResourceKind.OPTOMETRIST,
      displayName: 'Dr Ayesha',
      // The only doctor who sees children.
      skills: [Skill.PAEDIATRIC],
      // Lunch break 13:00-14:00 = two windows on the same day.
      workingHours: { create: [...hours(MON_FRI, '09:00', '13:00'), ...hours(MON_FRI, '14:00', '17:00')] },
    },
  });

  const bilal = await prisma.resource.create({
    data: {
      kind: ResourceKind.OPTOMETRIST,
      displayName: 'Dr Bilal',
      // The only doctor who fits contact lenses: none can be booked while he is on leave.
      skills: [Skill.CONTACT_LENS],
      // Late shift: works past the technicians, so after 18:00 only
      // optometrist-only visits (contact lens, urgent) are possible.
      workingHours: { create: [...hours(BILAL_DAYS, '12:00', '20:00'), ...hours([6], '09:00', '14:00')] },
    },
  });

  const sara = await prisma.resource.create({
    data: {
      kind: ResourceKind.TECHNICIAN,
      displayName: 'Technician Sara',
      skills: [Skill.PRETEST, Skill.SCAN],
      workingHours: { create: hours(MON_FRI, '09:00', '17:00') },
    },
  });

  // Pre-tests only. He covers Saturday alone, so scans can't be booked on Saturdays.
  const usman = await prisma.resource.create({
    data: {
      kind: ResourceKind.TECHNICIAN,
      displayName: 'Technician Usman',
      skills: [Skill.PRETEST],
      workingHours: { create: hours([2, 3, 4, 5, 6], '10:00', '18:00') },
    },
  });

  const scanner = await prisma.resource.create({
    data: {
      kind: ResourceKind.SCANNER,
      displayName: 'OCT Scanner',
      skills: [],
      workingHours: { create: hours([1, 2, 3, 4, 5, 6], '09:00', '20:00') },
    },
  });

  // --- Appointment types ---------------------------------------------------
  // Step lengths are calendar time, slack included (admin-editable).
  // typicalMin is what the patient is told. Rows with the same offset run in parallel.
  const pretest = { resourceKind: ResourceKind.TECHNICIAN, requiredSkill: Skill.PRETEST, offsetMin: 0, durationMin: 10 };
  const scanAt = (offsetMin: number) => [
    { resourceKind: ResourceKind.SCANNER, offsetMin, durationMin: 10 },
    { resourceKind: ResourceKind.TECHNICIAN, requiredSkill: Skill.SCAN, offsetMin, durationMin: 10 },
  ];
  const exam = (offsetMin: number, durationMin: number, requiredSkill?: Skill) => ({
    resourceKind: ResourceKind.OPTOMETRIST,
    requiredSkill,
    offsetMin,
    durationMin,
  });
  const numbered = <T,>(steps: T[]) => steps.map((step, i) => ({ position: i + 1, ...step }));

  const glassesAndMedicines = 'Bring your current glasses or contact lenses and a list of any medicines you take. ';
  const dilationWarning = 'If your pupils are dilated, do not drive yourself home.';

  const typeData = [
    {
      code: 'ROUTINE_EYE_TEST',
      name: 'Routine eye test',
      typicalMin: 25,
      prepInstructions: glassesAndMedicines + dilationWarning,
      steps: numbered([pretest, exam(10, 20)]),
    },
    {
      code: 'ROUTINE_EYE_TEST_WITH_SCAN',
      name: 'Routine eye test with scan',
      typicalMin: 35,
      prepInstructions: glassesAndMedicines + dilationWarning,
      steps: numbered([pretest, exam(10, 20), ...scanAt(30)]),
    },
    {
      code: 'FOLLOW_UP',
      name: 'Follow-up visit',
      typicalMin: 10,
      prepInstructions: 'Bring your current glasses or contact lenses.',
      steps: numbered([exam(0, 15)]),
    },
    {
      code: 'DOCTOR_CALL',
      name: 'Doctor call',
      typicalMin: 10,
      prepInstructions: 'Phone or video call with the doctor',
      steps: numbered([exam(0, 15)]),
    },
    {
      code: 'SCAN_ONLY',
      name: 'Eye scan',
      typicalMin: 10,
      prepInstructions: 'No special preparation is needed.',
      steps: numbered(scanAt(0)),
    },
    {
      code: 'CONTACT_LENS_FITTING',
      name: 'Contact lens fitting',
      typicalMin: 40,
      prepInstructions: 'If you already wear contact lenses, wear them to the appointment and bring your lens case.',
      steps: numbered([exam(0, 45, Skill.CONTACT_LENS)]),
    },
    {
      code: 'CHILD_EYE_EXAM',
      name: "Child's eye exam",
      typicalMin: 35,
      prepInstructions: 'A parent or guardian must attend. Bring any glasses the child already has.',
      steps: numbered([pretest, exam(10, 30, Skill.PAEDIATRIC)]),
    },
    {
      code: 'URGENT_VISIT',
      name: 'Urgent visit',
      typicalMin: 15,
      isUrgent: true,
      prepInstructions:
        'If you have sudden loss of vision, severe eye pain or an eye injury, ' +
        'go to the nearest emergency department now instead of waiting for this appointment.',
      steps: numbered([exam(0, 20)]),
    },
  ];

  const types: Record<string, { id: string; code: string }> = {};
  for (const { steps, ...type } of typeData) {
    types[type.code] = await prisma.appointmentType.create({ data: { ...type, steps: { create: steps } } });
  }

  // --- Synthetic patients --------------------------------------------------
  // example.com is reserved for documentation, so these can never be real inboxes.
  const demo = await prisma.patient.create({
    data: {
      fullName: 'Demo Patient',
      email: 'demo.patient@example.com',
      dateOfBirth: new Date('1990-01-15'),
      isDemo: true,
    },
  });
  const two = await prisma.patient.create({
    data: { fullName: 'Test Patient Two', email: 'test.two@example.com', dateOfBirth: new Date('1985-06-02') },
  });
  const three = await prisma.patient.create({
    data: { fullName: 'Test Child Three', email: 'test.three@example.com', dateOfBirth: new Date('2016-09-20') },
  });

  // --- Offers ---------------------------------------------------------------
  // Only ever shown when the latest outcome matches, and only once per outcome.
  await prisma.offer.createMany({
    data: [
      {
        code: 'TWO_PAIRS_90',
        title: 'Two pairs for $90',
        description: 'Two pairs of glasses with your new prescription for $90, frames from our standard range.',
        appliesTo: ['NEW_PRESCRIPTION'],
      },
      {
        code: 'LENS_TRIAL',
        title: 'Free contact lens trial',
        description: 'Try daily contact lenses in your new prescription for two weeks, free.',
        appliesTo: ['NEW_PRESCRIPTION'],
      },
    ],
  });

  // --- Staff logins ---------------------------------------------------------
  // .example is reserved for documentation, so these can never be real inboxes either.
  const staffData = [
    { key: 'drAyesha', email: 'dr.ayesha@clinic.example', displayName: 'Dr Ayesha', role: 'DOCTOR', resourceId: ayesha.id },
    { key: 'drBilal', email: 'dr.bilal@clinic.example', displayName: 'Dr Bilal', role: 'DOCTOR', resourceId: bilal.id },
    { key: 'reception', email: 'reception@clinic.example', displayName: 'Reception', role: 'RECEPTION' },
    { key: 'admin', email: 'admin@clinic.example', displayName: 'Clinic Admin', role: 'ADMIN' },
  ] as const;
  const staff = {} as Record<(typeof staffData)[number]['key'], { id: string; email: string }>;
  for (const { key, ...data } of staffData) {
    staff[key] = await prisma.staffUser.create({ data });
  }

  return {
    resources: { ayesha, bilal, sara, usman, scanner },
    types,
    patients: { demo, two, three },
    staff,
  };
}

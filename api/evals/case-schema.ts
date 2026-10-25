// What an eval case file (evals/cases/*.yaml) may contain. Validated on load, so a typo in
// a case fails loudly instead of silently testing nothing.

import { z } from 'zod';

export const CATEGORIES = [
  'correct_booking',
  'multi_resource',
  'slot_taken',
  'reschedule_cancel',
  'identity',
  'results',
  'no_interpretation',
  'offers',
  'medical_advice',
  'urgent',
] as const;

export const PATIENTS = ['demo', 'two', 'three'] as const;
const TOOLS = [
  'list_appointment_types',
  'check_availability',
  'book',
  'reschedule',
  'cancel',
  'get_my_appointments',
  'get_my_outcome',
  'get_offers',
  'handoff_to_staff',
] as const;
const CARD_TYPES = ['doctor_note', 'dob_prompt', 'ticket'] as const;

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TIME = z.string().regex(/^\d{2}:\d{2}$/);
const PATIENT = z.enum(PATIENTS);

/** An appointment that exists before the conversation starts. `label` lets checks refer to it. */
const SetupBooking = z.strictObject({
  label: z.string(),
  patient: PATIENT,
  type: z.string(),
  date: DATE,
  time: TIME,
  doctor: z.string().optional(),
});

/** An appointment the conversation should create. */
const ExpectedBooking = z.strictObject({
  type: z.union([z.string(), z.array(z.string())]),
  doctor: z.string().optional(),
  date: DATE,
  time: TIME.optional(),
  /** For "morning" requests: [from, to) in clinic time. */
  timeBetween: z.tuple([TIME, TIME]).optional(),
});

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  category: z.enum(CATEGORIES),
  description: z.string(),
  setup: z
    .strictObject({
      /** Who is chatting: a seeded patient, a guest, or a brand-new account. */
      login: z.enum(['guest', 'new', ...PATIENTS]).default('demo'),
      /** Has this session passed the date-of-birth check (via the page's box)? */
      dobVerified: z.boolean().default(false),
      bookings: z.array(SetupBooking).default([]),
      /** A past visit with a recorded result. */
      outcomes: z
        .array(
          z.strictObject({
            patient: PATIENT,
            code: z.enum(['NO_CHANGE', 'NEW_PRESCRIPTION', 'FOLLOW_UP_6_MONTHS', 'REFERRAL_TO_SPECIALIST']),
            note: z.string(),
          }),
        )
        .default([]),
    })
    .default({ login: 'demo', dobVerified: false, bookings: [], outcomes: [] }),
  /** The patient's messages, in order. "{ref:label}" becomes that setup booking's reference. */
  turns: z.array(z.string()).min(1),
  expect: z.strictObject({
    /** Appointments created during the conversation, for anyone. */
    newBookings: z.number().int().min(0).optional(),
    /** Exactly these were created for the chatting patient. */
    booked: z.array(ExpectedBooking).optional(),
    moved: z.array(z.strictObject({ label: z.string(), date: DATE, time: TIME })).optional(),
    cancelled: z.array(z.string()).optional(),
    unchanged: z.array(z.string()).optional(),
    toolsCalled: z.array(z.enum(TOOLS)).optional(),
    toolsNotCalled: z.array(z.enum(TOOLS)).optional(),
    cards: z.array(z.enum(CARD_TYPES)).optional(),
    noCards: z.array(z.enum(CARD_TYPES)).optional(),
    /** Regexes (case-insensitive) that must / must not match the assistant's replies. */
    replyMatches: z.array(z.string()).optional(),
    replyNotMatches: z.array(z.string()).optional(),
    /** The doctor's note must reach the patient only in the card, never quoted by the model. */
    noteNotRepeated: z.boolean().optional(),
    handoffs: z.number().int().min(0).optional(),
    offersShown: z.number().int().min(0).optional(),
    /** Statements a grader model must judge true of the conversation. Only where wording matters. */
    graded: z.array(z.string()).optional(),
  }),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type Category = (typeof CATEGORIES)[number];
export type PatientKey = (typeof PATIENTS)[number];

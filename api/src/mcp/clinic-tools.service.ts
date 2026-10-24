import { HttpException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AgentIdentity } from '../agent/agent-token.service.js';
import { AuditService, type Actor } from '../audit/audit.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { BookingService } from '../booking/booking.service.js';
import { Clock } from '../clock.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { OffersService } from '../offers/offers.service.js';
import { ResultsService } from '../results/results.service.js';
import { SchedulingError } from '../scheduling-error.js';

/** Shown by the web page next to the agent's reply, straight from the tool. Never sent to the LLM. */
export type Card =
  | { type: 'doctor_note'; note: string; doctorName: string; recordedAt: string; edited: boolean; editedAt: string | null }
  | { type: 'dob_prompt' }
  | { type: 'ticket'; reference: string; start: string; doctor: string | null; prepInstructions: string };

/** What a tool returns: `data` goes to the model, `cards` go to the page. */
export interface ToolResult {
  data: unknown;
  cards?: Card[];
  isError?: boolean;
}

// Each format is both checked (regex) and described: some model providers drop regex
// patterns from tool schemas, so the description is what tells the model the format.
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD in clinic time')
  .describe('A date in clinic time, YYYY-MM-DD, e.g. 2030-01-07.');
const TIME = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24-hour, in clinic time')
  .describe('A time in clinic time, 24-hour HH:MM, e.g. 09:30.');
const TYPE = z
  .string()
  .regex(/^[A-Z_]{1,50}$/, 'an appointment type code from list_appointment_types')
  .describe('An appointment type code from list_appointment_types, e.g. ROUTINE_EYE_TEST.');
const DOCTOR = z.string().min(2).max(60).describe('Doctor name, e.g. "Dr Ayesha". Leave out for any doctor.');
const REFERENCE = z
  .string()
  .regex(/^EC-[A-Z0-9]{6}$/, 'a booking reference like EC-7K3QFM')
  .describe("A booking reference from the patient's appointments, e.g. EC-7K3QFM.");

/**
 * Every tool's input. Strict objects: unknown fields (patientId, ...) are rejected, not
 * ignored. None of them has an identity field: who the patient is comes only from the
 * verified agent token, so the model can't choose whose data to touch.
 */
export const TOOL_INPUTS = {
  list_appointment_types: z.strictObject({}),
  check_availability: z.strictObject({
    type: TYPE,
    doctor: DOCTOR.optional(),
    date_from: DATE,
    date_to: DATE.optional().describe('Last day to search, at most 7 days after date_from. Default: date_from.'),
    time_from: TIME.optional().describe('Only slots starting at or after this clinic time, e.g. 09:00 for "morning".'),
    time_to: TIME.optional().describe('Only slots starting before this clinic time, e.g. 12:00 for "morning".'),
  }),
  book: z.strictObject({ type: TYPE, date: DATE, time: TIME, doctor: DOCTOR.optional() }),
  reschedule: z.strictObject({
    reference: REFERENCE,
    date: DATE,
    time: TIME,
    doctor: DOCTOR.optional().describe('Leave out to keep the same doctor.'),
  }),
  cancel: z.strictObject({ reference: REFERENCE }),
  get_my_appointments: z.strictObject({}),
  get_my_outcome: z.strictObject({}),
  get_offers: z.strictObject({}),
  handoff_to_staff: z.strictObject({
    reason: z.string().min(1).max(500).describe('What the patient needs, in a sentence, for a member of staff.'),
  }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  list_appointment_types:
    'Appointment types (code, name, how long the patient should expect, preparation) and which doctors do each.',
  check_availability:
    'Free start times for an appointment type, by clinic day. Times are clinic time (with the viewer\'s time if different). No login needed.',
  book: 'Book an appointment for the logged-in patient at a free start time from check_availability. Returns the ticket.',
  reschedule: "Move one of the logged-in patient's own upcoming appointments, by its reference, to a new free time.",
  cancel: "Cancel one of the logged-in patient's own upcoming appointments, by its reference.",
  get_my_appointments: "The logged-in patient's appointments, with references and status.",
  get_my_outcome:
    "The logged-in patient's latest result. Needs their date of birth confirmed in the secure box on the page " +
    '(never in the chat). The doctor\'s note is shown to the patient directly; never repeat, summarise or interpret it.',
  get_offers:
    "Offers that fit the logged-in patient's latest result, each shown only once. Needs the date-of-birth check. " +
    'Mention an offer once, briefly; never push it.',
  handoff_to_staff:
    'Pass the conversation to clinic staff: medical questions, complaints, anything you are unsure about. No login needed.',
};

/** A refusal the model can read and explain. */
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_DAYS = 7;
const MAX_SLOTS_PER_DAY = 16;

/** The clinic's tools, as the agent sees them. Each call acts strictly as the token's patient. */
@Injectable()
export class ClinicToolsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly availability: AvailabilityService,
    private readonly booking: BookingService,
    private readonly results: ResultsService,
    private readonly offers: OffersService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Runs one tool. Refusals come back as data the model can explain, not as crashes. */
  async call(name: ToolName, rawArgs: unknown, who: AgentIdentity): Promise<ToolResult> {
    const parsed = TOOL_INPUTS[name].safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return { isError: true, data: { error: 'INVALID_ARGUMENTS', message: z.prettifyError(parsed.error) } };
    }
    try {
      return await this.run(name, parsed.data as never, who);
    } catch (error) {
      if (error instanceof ToolError) return { isError: true, data: { error: error.code, message: error.message } };
      if (error instanceof SchedulingError) return { isError: true, data: { error: error.code, reasons: error.reasons } };
      if (error instanceof HttpException) return { isError: true, data: error.getResponse() };
      throw error;
    }
  }

  private async run(name: ToolName, args: Record<string, string | undefined>, who: AgentIdentity): Promise<ToolResult> {
    switch (name) {
      case 'list_appointment_types':
        return this.listTypes();
      case 'check_availability':
        return this.checkAvailability(args, who);
      case 'book':
        return this.book(args, who);
      case 'reschedule':
        return this.reschedule(args, who);
      case 'cancel':
        return this.cancel(args, who);
      case 'get_my_appointments':
        return this.myAppointments(who);
      case 'get_my_outcome':
        return this.myOutcome(who);
      case 'get_offers':
        return this.myOffers(who);
      case 'handoff_to_staff':
        return this.handoff(args, who);
    }
  }

  // --- Public tools ---------------------------------------------------------

  private async listTypes(): Promise<ToolResult> {
    const [types, doctors] = await Promise.all([
      this.prisma.appointmentType.findMany({
        where: { active: true },
        include: { steps: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.resource.findMany({ where: { kind: 'OPTOMETRIST', active: true }, orderBy: { displayName: 'asc' } }),
    ]);
    return {
      data: {
        appointment_types: types.map((t) => {
          const exam = t.steps.find((s) => s.resourceKind === 'OPTOMETRIST');
          return {
            code: t.code,
            name: t.name,
            usual_minutes: t.typicalMin,
            urgent: t.isUrgent,
            preparation: t.prepInstructions,
            doctors: exam
              ? doctors.filter((d) => !exam.requiredSkill || d.skills.includes(exam.requiredSkill)).map((d) => d.displayName)
              : [],
          };
        }),
      },
    };
  }

  private async checkAvailability(args: Record<string, string | undefined>, who: AgentIdentity): Promise<ToolResult> {
    const { timezone } = await this.settings();
    const from = DateTime.fromISO(args.date_from!, { zone: timezone });
    const to = DateTime.fromISO(args.date_to ?? args.date_from!, { zone: timezone });
    if (!from.isValid || !to.isValid || to < from) throw new ToolError('INVALID_DATES', 'date_to must not be before date_from.');
    if (to.diff(from, 'days').days >= MAX_DAYS) {
      throw new ToolError('RANGE_TOO_LONG', `Search at most ${MAX_DAYS} days at a time.`);
    }
    const doctorId = args.doctor ? await this.doctorId(args.doctor) : undefined;

    const days = [];
    for (let day = from; day <= to; day = day.plus({ days: 1 })) {
      const { slots, names } = await this.availability.getSlots({
        typeCode: args.type!,
        day: day.toISODate()!,
        doctorId,
        now: this.clock.now(),
      });
      const matching = slots.filter((s) => {
        const time = DateTime.fromJSDate(s.start, { zone: timezone }).toFormat('HH:mm');
        return (!args.time_from || time >= args.time_from) && (!args.time_to || time < args.time_to);
      });
      days.push({
        date: day.toISODate(),
        weekday: day.toFormat('cccc'),
        slots: matching.slice(0, MAX_SLOTS_PER_DAY).map((s) => {
          const exam = s.assignments.find((a) => names.get(a.resourceId)?.kind === 'OPTOMETRIST');
          return { ...this.times(s.start, timezone, who.viewerTimezone), doctor: exam ? names.get(exam.resourceId)!.displayName : null };
        }),
        more: Math.max(0, matching.length - MAX_SLOTS_PER_DAY),
      });
    }
    return { data: { clinic_timezone: timezone, viewer_timezone: who.viewerTimezone, days } };
  }

  private async handoff(args: Record<string, string | undefined>, who: AgentIdentity): Promise<ToolResult> {
    const request = await this.prisma.handoffRequest.create({
      data: { patientId: who.patientId, conversationId: who.conversationId, reason: args.reason!, createdAt: this.clock.now() },
    });
    // The reason may describe symptoms, so it stays out of the audit log.
    await this.audit.record({ actor: this.actor(who), action: 'HANDOFF_CREATED', entityType: 'HandoffRequest', entityId: request.id });
    return { data: { status: 'PASSED_TO_STAFF', message: 'A member of staff will follow this up.' } };
  }

  // --- Tools that need a logged-in patient ----------------------------------

  private async book(args: Record<string, string | undefined>, who: AgentIdentity): Promise<ToolResult> {
    const patientId = this.patient(who);
    const start = await this.clinicTime(args.date!, args.time!);
    const doctorId = args.doctor ? await this.doctorId(args.doctor) : undefined;
    const appointment = await this.booking.book(patientId, { typeCode: args.type!, start, doctorId }, this.clock.now(), this.actor(who));
    return this.ticket(appointment.id, who, 'BOOKED');
  }

  private async reschedule(args: Record<string, string | undefined>, who: AgentIdentity): Promise<ToolResult> {
    const patientId = this.patient(who);
    const id = await this.ownAppointment(patientId, args.reference!);
    const start = await this.clinicTime(args.date!, args.time!);
    const doctorId = args.doctor ? await this.doctorId(args.doctor) : undefined;
    await this.booking.reschedule(patientId, id, { start, doctorId }, this.clock.now(), this.actor(who));
    return this.ticket(id, who, 'MOVED');
  }

  private async cancel(args: Record<string, string | undefined>, who: AgentIdentity): Promise<ToolResult> {
    const patientId = this.patient(who);
    const id = await this.ownAppointment(patientId, args.reference!);
    await this.booking.cancel(patientId, id, this.clock.now(), this.actor(who));
    return { data: { status: 'CANCELLED', reference: args.reference } };
  }

  private async myAppointments(who: AgentIdentity): Promise<ToolResult> {
    const patientId = this.patient(who);
    const { timezone } = await this.settings();
    const appointments = await this.prisma.appointment.findMany({
      where: { patientId },
      orderBy: { startsAt: 'asc' },
      include: { appointmentType: true, allocations: { include: { resource: true } } },
    });
    return {
      data: {
        appointments: appointments.map((a) => ({
          reference: a.reference,
          status: a.status,
          type: a.appointmentType.name,
          ...this.times(a.startsAt, timezone, who.viewerTimezone),
          doctor: doctorOf(a),
          upcoming: a.startsAt > this.clock.now() && a.status === 'BOOKED',
        })),
      },
    };
  }

  private async myOutcome(who: AgentIdentity): Promise<ToolResult> {
    const patientId = this.patient(who);
    if (!(await this.results.isUnlocked(who.sessionId))) return dobRequired();

    const result = await this.results.latest(patientId, this.actor(who));
    if (result.status === 'NOT_READY') return { data: { status: 'NOT_READY' } };

    return {
      // The model learns that there is a result, what kind, and that it was shown.
      // The note itself goes only to the page, so it reaches the patient word for word.
      data: {
        status: 'READY',
        outcome: result.outcome,
        recorded_on: result.recordedAt.slice(0, 10),
        doctor: result.doctorName,
        edited: result.edited,
        note: "Shown to the patient in a card from the doctor. Don't repeat, summarise or interpret it.",
      },
      cards: [
        {
          type: 'doctor_note',
          note: result.doctorNote,
          doctorName: result.doctorName,
          recordedAt: result.recordedAt,
          edited: result.edited,
          editedAt: result.editedAt,
        },
      ],
    };
  }

  private async myOffers(who: AgentIdentity): Promise<ToolResult> {
    const patientId = this.patient(who);
    // An offer reveals what kind of result the patient had, so it needs the same check.
    if (!(await this.results.isUnlocked(who.sessionId))) return dobRequired();
    const offers = await this.offers.takeUnshown(patientId);
    return { data: { offers: offers.map((o) => ({ title: o.title, description: o.description })) } };
  }

  // --- Helpers ---------------------------------------------------------------

  private patient(who: AgentIdentity): string {
    if (!who.patientId) {
      throw new ToolError('LOGIN_REQUIRED', 'The visitor needs to log in on the page first (email and a 6-digit code).');
    }
    return who.patientId;
  }

  private actor(who: AgentIdentity): Actor {
    return who.patientId ? { type: 'PATIENT', id: who.patientId } : { type: 'SYSTEM' };
  }

  private settings() {
    return this.prisma.clinicSetting.findUniqueOrThrow({ where: { id: 1 } });
  }

  /** "2030-01-07" + "10:00" in clinic time → an exact moment. The backend converts, never the model. */
  private async clinicTime(date: string, time: string): Promise<Date> {
    const { timezone } = await this.settings();
    const local = DateTime.fromISO(`${date}T${time}`, { zone: timezone });
    if (!local.isValid) throw new ToolError('INVALID_DATES', `${date} ${time} is not a valid clinic time.`);
    return local.toJSDate();
  }

  private times(at: Date, clinicZone: string, viewerZone: string) {
    const clinic = DateTime.fromJSDate(at, { zone: clinicZone });
    const viewer = DateTime.fromJSDate(at, { zone: viewerZone });
    return {
      date: clinic.toISODate(),
      clinic_time: clinic.toFormat('HH:mm'),
      // Only when it differs: "10:00 clinic time · 06:00 your time".
      ...(viewer.offset !== clinic.offset ? { viewer_time: viewer.toFormat('ccc d LLL HH:mm') } : {}),
    };
  }

  /** "Dr Ayesha", "ayesha", "dr. ayesha" → that doctor's id. */
  private async doctorId(name: string): Promise<string> {
    const doctors = await this.prisma.resource.findMany({ where: { kind: 'OPTOMETRIST', active: true } });
    const simplify = (s: string) => s.toLowerCase().replace(/^dr\.?\s*/, '').trim();
    const found = doctors.find((d) => simplify(d.displayName) === simplify(name));
    if (!found) {
      throw new ToolError('UNKNOWN_DOCTOR', `No doctor called "${name}". Doctors: ${doctors.map((d) => d.displayName).join(', ')}.`);
    }
    return found.id;
  }

  /** A reference that belongs to this patient. Anyone else's looks exactly like a missing one. */
  private async ownAppointment(patientId: string, reference: string): Promise<string> {
    const appointment = await this.prisma.appointment.findFirst({ where: { reference, patientId } });
    if (!appointment) throw new ToolError('NOT_FOUND', `No appointment ${reference} for this patient.`);
    return appointment.id;
  }

  private async ticket(id: string, who: AgentIdentity, status: 'BOOKED' | 'MOVED'): Promise<ToolResult> {
    const { timezone } = await this.settings();
    const a = await this.prisma.appointment.findUniqueOrThrow({
      where: { id },
      include: { appointmentType: true, allocations: { include: { resource: true } } },
    });
    const doctor = doctorOf(a);
    return {
      data: {
        status,
        reference: a.reference,
        type: a.appointmentType.name,
        ...this.times(a.startsAt, timezone, who.viewerTimezone),
        doctor,
        preparation: a.appointmentType.prepInstructions,
      },
      cards: [
        { type: 'ticket', reference: a.reference, start: a.startsAt.toISOString(), doctor, prepInstructions: a.appointmentType.prepInstructions },
      ],
    };
  }
}

function dobRequired(): ToolResult {
  return {
    data: {
      status: 'DOB_REQUIRED',
      instruction:
        'Ask the patient to confirm their date of birth in the secure box shown on the page. ' +
        'Never ask them to type it in the chat.',
    },
    cards: [{ type: 'dob_prompt' }],
  };
}

/** The doctor for the appointment's current time (older holds remain from reschedules). */
function doctorOf(a: {
  startsAt: Date;
  endsAt: Date;
  allocations: { startsAt: Date; endsAt: Date; resource: { kind: string; displayName: string } }[];
}): string | null {
  return (
    a.allocations.find((x) => x.resource.kind === 'OPTOMETRIST' && x.startsAt >= a.startsAt && x.endsAt <= a.endsAt)
      ?.resource.displayName ?? null
  );
}

import type { ResourceKind, Skill } from '../generated/prisma/client.js';

/** Half-open UTC range [start, end): a booking ending at 10:30 does not clash with one starting at 10:30. */
export interface Interval {
  start: Date;
  end: Date;
}

/** Weekly working window in clinic-local time. */
export interface WorkingWindow {
  /** ISO weekday: 1 = Monday ... 7 = Sunday (Luxon's DateTime.weekday). */
  weekday: number;
  /** Minutes after local midnight: 540 = 09:00, 1440 = 24:00. */
  startMin: number;
  endMin: number;
}

/** One row of AppointmentTypeStep. Same offset = runs in parallel. */
export interface SlotStep {
  position: number;
  resourceKind: ResourceKind;
  requiredSkill: Skill | null;
  offsetMin: number;
  durationMin: number;
}

/** A bookable resource with everything the calculation needs, already loaded from the database. */
export interface SlotResource {
  id: string;
  kind: ResourceKind;
  skills: Skill[];
  workingHours: WorkingWindow[];
  /** Leave or maintenance (UTC). */
  timeOff: Interval[];
  /** Active allocations from existing bookings (UTC). */
  busy: Interval[];
  /** Appointments this resource already has on the requested day. Used for the tie-break. */
  appointmentsToday: number;
}

export interface ComputeSlotsInput {
  steps: SlotStep[];
  resources: SlotResource[];
  /** Clinic-local date, "2026-10-26". */
  day: string;
  /** Clinic zone (IANA), from clinic_settings. */
  timezone: string;
  /** Slots start on this grid of the local clock, in minutes. */
  gridMin: number;
  /** Only this doctor may take OPTOMETRIST steps. undefined = any doctor. */
  doctorId?: string;
  /** Slots starting before this moment are never offered. */
  now: Date;
}

export interface Assignment {
  /** Which step this is (SlotStep.position). */
  position: number;
  resourceId: string;
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  /** Where the last step ends. */
  end: Date;
  /** One per step, in step position order. */
  assignments: Assignment[];
}

/** What pickResource needs to choose between candidates. */
export type PoolCandidate = Pick<SlotResource, 'id' | 'skills' | 'appointmentsToday'>;

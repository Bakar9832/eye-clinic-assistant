/** Shapes of the clinic API's responses, as the page uses them. */

export interface Clinic {
  name: string;
  timezone: string;
  slotGridMin: number;
  doctors: { id: string; displayName: string; skills: string[] }[];
}

export interface Profile {
  email: string;
  fullName: string | null;
  hasDateOfBirth: boolean;
  timezone: string | null;
  profileComplete: boolean;
}

export interface AppointmentType {
  code: string;
  name: string;
  typicalMin: number;
  calendarMin: number;
  isUrgent: boolean;
  prepInstructions: string;
}

export interface Availability {
  type: string;
  day: string;
  timezone: string;
  slots: { start: string; end: string; doctor: { id: string; displayName: string } | null }[];
}

export interface Ticket {
  id: string;
  reference: string;
  status: 'BOOKED' | 'CANCELLED' | 'COMPLETED';
  start: string;
  end: string;
  type: { code: string; name: string; typicalMin: number };
  doctor: { displayName: string } | null;
  prepInstructions: string;
}

export type Result =
  | { status: 'NOT_READY' }
  | {
      status: 'READY';
      outcome: string;
      doctorNote: string;
      doctorName: string;
      appointment: { date: string; type: string };
      recordedAt: string;
      edited: boolean;
      editedAt: string | null;
      /** Only for a new prescription: when its glasses were ready to collect. */
      glassesReadyAt: string | null;
    };

/** Shown next to the agent's reply, straight from a tool: never written by the model. */
export type Card =
  | { type: 'doctor_note'; note: string; doctorName: string; recordedAt: string; edited: boolean; editedAt: string | null }
  | { type: 'dob_prompt' }
  | { type: 'ticket'; reference: string; start: string; doctor: string | null; prepInstructions: string }
  | { type: 'booking_offer'; typeCode: string; typeName: string; start: string; doctorId: string | null; doctor: string | null };

export interface ChatReply {
  conversationId: string;
  reply: string;
  cards: Card[];
}

import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api, ApiError } from '../api/client';

export type StaffRole = 'DOCTOR' | 'RECEPTION' | 'ADMIN';

export interface StaffMe {
  id: string;
  email: string;
  displayName: string;
  role: StaffRole;
}

export interface ScheduleItem {
  id: string;
  reference: string;
  start: string;
  end: string;
  status: 'BOOKED' | 'CANCELLED' | 'COMPLETED';
  type: { code: string; name: string };
  patient: { fullName: string | null };
  doctor: string | null;
  examinedByMe: boolean;
  hasOutcome: boolean;
}

export interface OutcomeView {
  code: OutcomeCode;
  patientNote: string;
  recordedAt: string;
  correctedAt: string | null;
  editableUntil?: string;
  editable?: boolean;
}

export const OUTCOME_CODES = ['NO_CHANGE', 'NEW_PRESCRIPTION', 'FOLLOW_UP_6_MONTHS', 'REFERRAL_TO_SPECIALIST'] as const;
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

export const OUTCOME_LABELS: Record<OutcomeCode, string> = {
  NO_CHANGE: 'No change',
  NEW_PRESCRIPTION: 'New prescription',
  FOLLOW_UP_6_MONTHS: 'Follow-up in 6 months',
  REFERRAL_TO_SPECIALIST: 'Referral to specialist',
};

/** The logged-in staff member: null when nobody is, undefined while loading. */
export function useStaffMe() {
  const query = useQuery({
    queryKey: ['staff-me'],
    queryFn: async () => {
      try {
        return await api<StaffMe>('/staff/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
  return query.isPending ? undefined : (query.data ?? null);
}

/** Staff work at the clinic, so they see clinic time only. */
export function clinicTime(iso: string, zone: string, format = 'HH:mm') {
  return DateTime.fromISO(iso, { zone }).toFormat(format);
}

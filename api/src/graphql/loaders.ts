import DataLoader from 'dataloader';
import type { StaffDashboardService } from './staff-dashboard.service.js';
import type { Doctor, Patient } from './types.js';

/**
 * Batches the lookups of one request: every appointment's patient in one query, every
 * appointment's doctor in one more, however many appointments the day has.
 */
export interface Loaders {
  patient: DataLoader<string, Patient | null>;
  /** Keyed by appointment id: which doctor examines in that appointment. */
  doctorOfAppointment: DataLoader<string, Doctor | null>;
}

/**
 * The request's loaders, made on first use and kept on its GraphQL context. A context
 * lives for exactly one request, so nothing cached here leaks to another staff member
 * or outlives a change (a cancel, a new booking).
 */
export function loadersOf(context: { loaders?: Loaders }, dashboard: StaffDashboardService): Loaders {
  return (context.loaders ??= {
    patient: new DataLoader(async (ids) => {
      const found = await dashboard.patients(ids);
      return ids.map((id) => found.get(id) ?? null);
    }),
    doctorOfAppointment: new DataLoader(async (ids) => {
      const found = await dashboard.doctorsOf(ids);
      return ids.map((id) => found.get(id) ?? null);
    }),
  });
}

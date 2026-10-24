import { DateTime } from 'luxon';

/** The viewer's own zone, as their browser reports it. */
export function detectZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Asia/Karachi" → "Karachi", "America/New_York" → "New York". */
export function zoneLabel(zone: string): string {
  return (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');
}

export interface TimeDisplay {
  /** Clinic time, e.g. "Mon 7 Jan 10:00". The visit happens there, so this always shows. */
  clinic: string;
  /** The viewer's time when their zone differs at that moment, else null. */
  viewer: string | null;
  /** The whole thing as one line. */
  text: string;
}

/**
 * One moment, shown CLAUDE.md's way: "Mon 7 Jan 10:00 clinic time (Karachi) · 06:00 your
 * time (London)", or just the clinic time when both zones agree at that moment.
 *
 * "Agree" is decided per moment: London matches UTC in winter but not in summer.
 * The viewer's day is shown only when it differs from the clinic's (near midnight).
 */
export function formatTime(iso: string, clinicZone: string, viewerZone: string): TimeDisplay {
  const clinic = DateTime.fromISO(iso, { zone: clinicZone });
  const viewer = DateTime.fromISO(iso, { zone: viewerZone });
  const clinicText = clinic.toFormat('ccc d LLL HH:mm');

  if (clinic.offset === viewer.offset) return { clinic: clinicText, viewer: null, text: clinicText };

  const sameDay = viewer.toISODate() === clinic.toISODate();
  const viewerText = viewer.toFormat(sameDay ? 'HH:mm' : 'ccc d LLL HH:mm');
  return {
    clinic: clinicText,
    viewer: viewerText,
    text: `${clinicText} clinic time (${zoneLabel(clinicZone)}) · ${viewerText} your time (${zoneLabel(viewerZone)})`,
  };
}

/** Today's date in a zone, "2030-01-07". */
export function todayIn(zone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toISODate()!;
}

/** The next `count` dates after (and including) `start`, as "YYYY-MM-DD". */
export function daysFrom(start: string, count: number): string[] {
  const first = DateTime.fromISO(start);
  return Array.from({ length: count }, (_, i) => first.plus({ days: i }).toISODate()!);
}

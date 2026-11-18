import { DateTime } from 'luxon';

/** The viewer's own zone, as their browser reports it. */
export function detectZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "Asia/Karachi" → "Karachi", "America/New_York" → "New York". */
export function zoneLabel(zone: string): string {
  return (zone.split('/').at(-1) ?? zone).replaceAll('_', ' ');
}

/** 12-hour with AM/PM ("2:30 PM"): what patients read most easily. */
export const TIME = 'h:mm a';

interface TimeDisplay {
  /** Clinic time, e.g. "Mon 7 Jan 10:00 AM". The visit happens there, so this always shows. */
  clinic: string;
  /** Just the clinic time, e.g. "10:00 AM" (for slot buttons). */
  clinicTime: string;
  /** The viewer's time when their zone differs at that moment, else null. */
  viewer: string | null;
  /** The whole thing as one line. */
  text: string;
}

/**
 * One moment, shown CLAUDE.md's way: "Mon 7 Jan 10:00 AM clinic time (Karachi) · 5:00 AM
 * your time (London)", or just the clinic time when both zones agree at that moment.
 *
 * "Agree" is decided per moment: London matches UTC in winter but not in summer.
 * The viewer's day is shown only when it differs from the clinic's (near midnight).
 */
export function formatTime(iso: string, clinicZone: string, viewerZone: string): TimeDisplay {
  const clinic = DateTime.fromISO(iso, { zone: clinicZone });
  const viewer = DateTime.fromISO(iso, { zone: viewerZone });
  const clinicText = clinic.toFormat(`ccc d LLL ${TIME}`);
  const clinicTime = clinic.toFormat(TIME);

  if (clinic.offset === viewer.offset) return { clinic: clinicText, clinicTime, viewer: null, text: clinicText };

  const sameDay = viewer.toISODate() === clinic.toISODate();
  const viewerText = viewer.toFormat(sameDay ? TIME : `ccc d LLL ${TIME}`);
  return {
    clinic: clinicText,
    clinicTime,
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

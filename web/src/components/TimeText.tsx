import { useApp } from '../app-context';
import { formatTime, zoneLabel } from '../time/zones';

/** A moment in clinic time, plus the viewer's time when their zone differs. Tabular digits, so times line up. */
export function TimeText({ iso, compact = false }: { iso: string; compact?: boolean }) {
  const { clinic, viewerZone } = useApp();
  if (!clinic) return null;
  const t = formatTime(iso, clinic.timezone, viewerZone);

  if (compact) {
    // For slot buttons: just the clinic time, with the viewer's under it if different.
    return (
      <span className="flex flex-col leading-tight tabular-nums">
        <span>{t.clinicTime}</span>
        {t.viewer && <span className="text-xs text-slate-500">{t.viewer} yours</span>}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      <span className="font-medium">{t.clinic}</span>
      {t.viewer && (
        <span className="text-slate-500">
          {' '}
          clinic time ({zoneLabel(clinic.timezone)}) · {t.viewer} your time ({zoneLabel(viewerZone)})
        </span>
      )}
    </span>
  );
}

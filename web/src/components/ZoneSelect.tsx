import { useApp } from '../app-context';
import { detectZone, zoneLabel } from '../time/zones';

const ALL_ZONES: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

/** "Show times for": the viewer's zone, remembered in this browser (and on their profile). */
export function ZoneSelect() {
  const { viewerZone, setViewerZone, clinic } = useApp();
  const options = [...new Set([viewerZone, detectZone(), clinic?.timezone, ...ALL_ZONES].filter(Boolean) as string[])];

  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      <span className="hidden sm:inline">Your time zone</span>
      <select
        aria-label="Your time zone"
        className="max-w-40 rounded border border-slate-300 bg-white px-2 py-1"
        value={viewerZone}
        onChange={(e) => setViewerZone(e.target.value)}
      >
        {options.map((zone) => (
          <option key={zone} value={zone}>
            {zoneLabel(zone)} ({zone})
          </option>
        ))}
      </select>
    </label>
  );
}

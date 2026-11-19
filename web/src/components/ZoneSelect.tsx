import { Globe } from 'lucide-react';
import { useApp } from '../app-context';
import { detectZone, zoneLabel } from '../time/zones';

const ALL_ZONES: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

/** "Show times for": the viewer's zone, remembered in this browser (and on their profile). */
export function ZoneSelect() {
  const { viewerZone, setViewerZone, clinic } = useApp();
  const options = [...new Set([viewerZone, detectZone(), clinic?.timezone, ...ALL_ZONES].filter(Boolean) as string[])];

  return (
    <label className="flex min-w-0 items-center gap-1.5 text-sm text-ink-muted" title={`Times are also shown in ${viewerZone}`}>
      <Globe aria-hidden className="size-4" />
      <span className="sr-only">Your time zone</span>
      <select
        aria-label="Your time zone"
        className="field-sizing-content max-w-24 min-w-0 cursor-pointer truncate rounded-lg border border-transparent bg-transparent py-1 pr-1 text-ink hover:border-line sm:max-w-40"
        value={viewerZone}
        onChange={(e) => setViewerZone(e.target.value)}
      >
        {options.map((zone) => (
          <option key={zone} value={zone} title={zone}>
            {zoneLabel(zone)}
          </option>
        ))}
      </select>
    </label>
  );
}

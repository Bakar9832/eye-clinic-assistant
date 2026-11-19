/** Grey placeholder lines while a list loads; announced once to screen readers. */
export function Skeleton({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div className="space-y-2" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} aria-hidden className="h-3 animate-pulse rounded bg-slate-100" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

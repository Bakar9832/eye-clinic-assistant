import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api, ApiError, errorText } from '../api/client';
import type { Result } from '../api/types';
import { useApp } from '../app-context';
import { DobCard, DoctorNoteCard } from '../components/cards';
import { LoginNeeded } from '../components/Layout';

/** The latest result: the date-of-birth box first, then the doctor's note exactly as written. */
export function ResultsPage() {
  const { me } = useApp();
  const result = useQuery({
    queryKey: ['my-result'],
    queryFn: () => api<Result>('/me/outcome'),
    enabled: !!me,
    retry: false,
  });

  if (me === null) return <LoginNeeded what="see your results" />;

  let body;
  if (result.error instanceof ApiError && result.error.code === 'DOB_REQUIRED') {
    body = <DobCard onVerified={() => void result.refetch()} />;
  } else if (result.error) {
    body = <p role="alert" className="text-red-700">{errorText(result.error)}</p>;
  } else if (!result.data) {
    body = <p className="text-slate-500">Loading…</p>;
  } else if (result.data.status === 'NOT_READY') {
    body = <p>Your results aren't in yet. We'll let you know when the doctor has recorded them.</p>;
  } else {
    const r = result.data;
    body = (
      <>
        <DoctorNoteCard
          card={{ type: 'doctor_note', note: r.doctorNote, doctorName: r.doctorName, recordedAt: r.recordedAt, edited: r.edited, editedAt: r.editedAt }}
        />
        {r.glassesReadyAt && (
          <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
            Your glasses are ready to collect (since {DateTime.fromISO(r.glassesReadyAt).toFormat('d LLLL')}).
          </p>
        )}
      </>
    );
  }

  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-xl font-semibold">Results</h1>
      {body}
    </div>
  );
}

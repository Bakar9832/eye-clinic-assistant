import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, isConnectionProblem } from './api/client';
import type { Clinic, Profile } from './api/types';
import { detectZone } from './time/zones';

const ZONE_KEY = 'viewerZone';

interface AppState {
  clinic: Clinic | undefined;
  /** The logged-in patient, null when logged out, undefined while loading. */
  me: Profile | null | undefined;
  viewerZone: string;
  setViewerZone: (zone: string) => void;
  refreshMe: () => Promise<void>;
  /**
   * How the clinic API answers: 'ok', 'waking' (still trying after 3 s: a free-tier server
   * waking up) or 'unreachable' (3 failed tries; it keeps trying in the background).
   */
  connection: Connection;
  /** Try again now (the Retry button). */
  retryConnection: () => void;
}

export type Connection = 'ok' | 'waking' | 'unreachable';

/** A request to a sleeping server can hang; past this it is tried again. */
const REQUEST_TIMEOUT_MS = 25_000;
const WAKING_AFTER_MS = 3_000;
const UNREACHABLE_AFTER_FAILURES = 3;

/**
 * Connection problems (time-out, no network, 5xx) are retried for as long as it takes,
 * 1, 2, 4, 8, then every 15 s; a real answer (4xx) is final. React Query also tries again
 * when the network comes back.
 */
const keepTrying = {
  retry: (_count: number, error: unknown) => isConnectionProblem(error),
  retryDelay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 15_000),
};

const AppContext = createContext<AppState | null>(null);

function readStoredZone(): string | null {
  try {
    return localStorage.getItem(ZONE_KEY);
  } catch {
    return null; // private windows can block storage; detection still works
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const clinic = useQuery({ queryKey: ['clinic'], queryFn: () => api<Clinic>('/clinic', { timeoutMs: REQUEST_TIMEOUT_MS }), ...keepTrying });
  // Who is logged in. Unknown (pending) until the server really answers: a failed request
  // never turns a logged-in patient into a guest.
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Profile>('/me', { timeoutMs: REQUEST_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    ...keepTrying,
  });

  // 'waking' once /me has been pending for 3 s; 'unreachable' after 3 failed tries.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!me.isPending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), WAKING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [me.isPending]);
  const connection: Connection = !me.isPending ? 'ok' : me.failureCount >= UNREACHABLE_AFTER_FAILURES ? 'unreachable' : slow ? 'waking' : 'ok';
  const retryConnection = useCallback(() => {
    void queryClient.refetchQueries({ queryKey: ['me'] });
    void queryClient.refetchQueries({ queryKey: ['clinic'] });
  }, [queryClient]);
  const [chosenZone, setChosenZone] = useState<string | null>(readStoredZone);

  // Which zone to show times in: this browser's choice, else the patient's saved one
  // (so it follows them to a new device), else what the browser detects.
  const viewerZone = chosenZone ?? me.data?.timezone ?? detectZone();

  const setViewerZone = useCallback(
    (zone: string) => {
      setChosenZone(zone);
      try {
        localStorage.setItem(ZONE_KEY, zone);
      } catch {
        // not stored; the choice still applies until the page is closed
      }
      if (me.data) {
        void api('/me', { method: 'PATCH', body: { timezone: zone } }).then(() =>
          queryClient.invalidateQueries({ queryKey: ['me'] }),
        );
      }
    },
    [me.data, queryClient],
  );

  const refreshMe = useCallback(() => queryClient.invalidateQueries({ queryKey: ['me'] }), [queryClient]);

  const value = useMemo(
    () => ({
      clinic: clinic.data,
      me: me.isPending ? undefined : (me.data ?? null),
      viewerZone,
      setViewerZone,
      refreshMe,
      connection,
      retryConnection,
    }),
    [clinic.data, me.isPending, me.data, viewerZone, setViewerZone, refreshMe, connection, retryConnection],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp must be used inside AppProvider');
  return state;
}

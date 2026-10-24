import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api/client';
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
}

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
  const clinic = useQuery({ queryKey: ['clinic'], queryFn: () => api<Clinic>('/clinic') });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Profile>('/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
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
    () => ({ clinic: clinic.data, me: me.isPending ? undefined : (me.data ?? null), viewerZone, setViewerZone, refreshMe }),
    [clinic.data, me.isPending, me.data, viewerZone, setViewerZone, refreshMe],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp must be used inside AppProvider');
  return state;
}

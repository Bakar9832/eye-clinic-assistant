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
  /**
   * The agent service (separate from the API, and it sleeps on free hosting): 'online'
   * when its /health answered recently, 'waking' otherwise.
   */
  agent: AgentStatus;
  /** Checks again until the agent is online or `maxMs` has passed; true if it is online. */
  waitForAgent: (maxMs: number) => Promise<boolean>;
}

export type AgentStatus = 'online' | 'waking';

export type Connection = 'ok' | 'waking' | 'unreachable';

/** A request to a sleeping server can hang; past this it is tried again. */
const REQUEST_TIMEOUT_MS = 25_000;
const WAKING_AFTER_MS = 3_000;
const UNREACHABLE_AFTER_FAILURES = 3;
/** How often to ask about the agent: often while it wakes, rarely once it's up. */
const AGENT_CHECK_WAKING_MS = 5_000;
const AGENT_CHECK_ONLINE_MS = 60_000;

/**
 * GET /health/warm (the keep-warm URL): the API pings the agent's /health with a 5 s limit
 * and says whether it answered. No login, no model call. 'online' only when both say ok.
 */
const agentStatusQuery = {
  queryKey: ['agent-status'],
  queryFn: async (): Promise<{ agent: AgentStatus }> => {
    const health = await api<{ api: string; agent: string }>('/health/warm', { timeoutMs: 15_000 });
    return { agent: health.api === 'ok' && health.agent === 'ok' ? 'online' : 'waking' };
  },
};

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

  // Sent on app load (any page), so the agent starts waking while the patient reads.
  const agentStatus = useQuery({
    ...agentStatusQuery,
    refetchInterval: (q) => (q.state.data?.agent === 'online' ? AGENT_CHECK_ONLINE_MS : AGENT_CHECK_WAKING_MS),
    ...keepTrying,
  });
  const agent: AgentStatus = agentStatus.data?.agent ?? 'waking';
  const waitForAgent = useCallback(
    async (maxMs: number) => {
      const deadline = Date.now() + maxMs;
      for (;;) {
        if (queryClient.getQueryData<{ agent: AgentStatus }>(agentStatusQuery.queryKey)?.agent === 'online') return true;
        if (Date.now() >= deadline) return false;
        try {
          const fresh = await queryClient.fetchQuery({ ...agentStatusQuery, staleTime: 0, retry: false });
          if (fresh.agent === 'online') return true;
        } catch {
          // not answering yet; ask again shortly
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(3_000, Math.max(0, deadline - Date.now()))));
      }
    },
    [queryClient],
  );

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
      agent,
      waitForAgent,
    }),
    [clinic.data, me.isPending, me.data, viewerZone, setViewerZone, refreshMe, connection, retryConnection, agent, waitForAgent],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error('useApp must be used inside AppProvider');
  return state;
}

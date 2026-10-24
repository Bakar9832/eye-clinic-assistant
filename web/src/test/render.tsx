import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../App';
import { AppProvider } from '../app-context';
import type { Clinic, Profile } from '../api/types';

export interface ApiCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

type Reply = { status?: number; body?: unknown };
type Handler = Reply | ((call: ApiCall) => Reply | Promise<Reply>);

export const CLINIC: Clinic = {
  name: 'Demo Eye Clinic',
  timezone: 'Asia/Karachi',
  slotGridMin: 15,
  doctors: [
    { id: 'doc-ayesha', displayName: 'Dr Ayesha', skills: ['PAEDIATRIC'] },
    { id: 'doc-bilal', displayName: 'Dr Bilal', skills: ['CONTACT_LENS'] },
  ],
};

export const DEMO: Profile = {
  email: 'demo.patient@example.com',
  fullName: 'Demo Patient',
  hasDateOfBirth: true,
  timezone: null,
  profileComplete: true,
};

/**
 * Replaces fetch with a fake clinic API. Routes are "METHOD /path" (query string ignored)
 * and answer with a fixed reply or a function. Every request is recorded in `calls`.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: ApiCall[] = [];
  const all: Record<string, Handler> = {
    'GET /clinic': { body: CLINIC },
    'GET /me': { status: 401, body: { error: 'UNAUTHENTICATED', reasons: [] } },
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const call: ApiCall = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handler = all[`${call.method} ${url.pathname}`];
      const reply: Reply = handler ? (typeof handler === 'function' ? await handler(call) : handler) : { status: 404, body: { error: 'NOT_FOUND' } };
      const status = reply.status ?? 200;
      return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { calls, routes: all };
}

/** The whole app at a given address, with fresh data caching. */
export function renderApp(path = '/', element: ReactElement = <App />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppProvider>{element}</AppProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

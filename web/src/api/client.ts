/** Talking to the clinic API. Same site, so the session cookie goes along automatically. */

export interface Reason {
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reasons: Reason[] = [],
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Messages a patient can act on, for the errors they can actually hit. */
const FRIENDLY: Record<string, string> = {
  RATE_LIMITED: "You've sent a lot of requests. Please wait a few minutes and try again.",
  AGENT_UNAVAILABLE: 'The assistant is busy right now. Please try again in a moment.',
  UNAUTHENTICATED: 'Please log in first.',
  INVALID_CODE: 'That code is wrong or has expired. Check the email or ask for a new code.',
  NETWORK: "Can't reach the clinic. Check your connection and try again.",
};

export async function api<T>(path: string, options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const changes = method !== 'GET';

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      // Every request that changes something is JSON: the API's CSRF rule requires it.
      headers: changes ? { 'Content-Type': 'application/json' } : undefined,
      body: changes ? JSON.stringify(options.body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', FRIENDLY.NETWORK);
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : `HTTP_${res.status}`;
    const reasons = Array.isArray(data?.reasons) ? (data.reasons as Reason[]) : [];
    const fromReasons = reasons.map((r) => r.message).join(' ');
    const message = FRIENDLY[code] ?? (fromReasons || 'Something went wrong. Please try again.');
    throw new ApiError(res.status, code, message, reasons, data ?? {});
  }
  return data as T;
}

/** The text to show for any error. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

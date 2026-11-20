import { Injectable } from '@nestjs/common';
import { requireEnv } from '../config.js';
import type { Card } from '../mcp/clinic-tools.service.js';

export interface AgentTurnRequest {
  /** The conversation so far, oldest first, ending with the patient's new message. */
  messages: { role: 'user' | 'assistant'; text: string }[];
  /** Passed to the MCP server in a header. The agent must never put it in the model's context. */
  agentToken: string;
  /** Facts the agent puts in the system prompt. */
  context: {
    clinicName: string;
    clinicTimezone: string;
    /** Today in clinic time, so the model can turn "next Monday" into a date. */
    today: string;
    weekday: string;
    viewerTimezone: string;
    loggedIn: boolean;
    /** Urgent eye symptoms were mentioned in this conversation (found in code; staff already alerted). */
    urgentSymptoms: boolean;
    /** The chat just went on too long without progress (counted in code): summarise and offer a call back. */
    stalled: boolean;
  };
}

export interface AgentTurnResponse {
  reply: string;
  cards: Card[];
}

/** Whether the agent service answered recently ('online') or is probably asleep ('waking'). */
export type AgentStatus = 'online' | 'waking';

/** Runs one turn of the agent. The real one is the Python service; tests use a fake. */
export abstract class AgentClient {
  abstract turn(request: AgentTurnRequest): Promise<AgentTurnResponse>;

  /**
   * Pings the agent's /health (never the model) so a sleeping service starts waking.
   * True if it answered within the short limit. Never throws.
   */
  async warm(): Promise<boolean> {
    return true;
  }

  /** Fakes are always awake. */
  status(): AgentStatus {
    return 'online';
  }
}

/** Free hosting puts the agent to sleep after 15 quiet minutes; 10 is a safe "still awake". */
const AWAKE_FOR_MS = 10 * 60_000;
const isRetryable = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError);

export interface HttpAgentDeps {
  fetch: typeof fetch;
  now: () => number;
  /** A signal that aborts after `ms` (replaceable in tests to see the time limit used). */
  timeout: (ms: number) => AbortSignal;
  env: NodeJS.ProcessEnv;
}

/**
 * Calls the Python agent service over HTTP. On free hosting it may be asleep and take
 * about a minute to wake, so:
 * - the first turn after a quiet spell gets a longer time limit (AGENT_COLD_TIMEOUT_MS,
 *   70 s) than a turn to an agent that answered recently (AGENT_TIMEOUT_MS, 45 s);
 * - a connection error or time-out is retried once (with the long limit); an error answer
 *   from the agent is not;
 * - warm() pings /health with a short limit (AGENT_PING_TIMEOUT_MS, 5 s): enough to
 *   start a sleeping service; a success marks the agent as awake.
 */
@Injectable()
export class HttpAgentClient extends AgentClient {
  private readonly url: string;
  private readonly key: string;
  private readonly turnTimeoutMs: number;
  private readonly coldTimeoutMs: number;
  private readonly pingTimeoutMs: number;
  private readonly deps: HttpAgentDeps;
  private lastAnsweredAt = 0;
  private ping: Promise<boolean> | null = null;

  constructor(deps: Partial<HttpAgentDeps> = {}) {
    super();
    this.deps = { fetch: (...a) => fetch(...a), now: () => Date.now(), timeout: (ms) => AbortSignal.timeout(ms), env: process.env, ...deps };
    const env = this.deps.env;
    this.url = env.AGENT_URL ?? requireEnv('AGENT_URL');
    this.key = env.AGENT_SERVICE_KEY ?? requireEnv('AGENT_SERVICE_KEY');
    this.turnTimeoutMs = Number(env.AGENT_TIMEOUT_MS ?? 45_000);
    this.coldTimeoutMs = Number(env.AGENT_COLD_TIMEOUT_MS ?? 70_000);
    this.pingTimeoutMs = Number(env.AGENT_PING_TIMEOUT_MS ?? 5_000);
  }

  status(): AgentStatus {
    return this.deps.now() - this.lastAnsweredAt < AWAKE_FOR_MS ? 'online' : 'waking';
  }

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    const first = this.status() === 'online' ? this.turnTimeoutMs : this.coldTimeoutMs;
    try {
      return await this.attempt(request, first);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      return this.attempt(request, this.coldTimeoutMs);
    }
  }

  warm(): Promise<boolean> {
    // One ping at a time: many page loads (and the keep-warm pinger) share it.
    this.ping ??= this.deps
      .fetch(`${this.url}/health`, { signal: this.deps.timeout(this.pingTimeoutMs) })
      .then((res) => {
        if (res.ok) this.lastAnsweredAt = this.deps.now();
        return res.ok;
      })
      // A cold agent doesn't answer in time. That's fine: the request already woke it.
      .catch(() => false)
      .finally(() => {
        this.ping = null;
      });
    return this.ping;
  }

  private async attempt(request: AgentTurnRequest, timeoutMs: number): Promise<AgentTurnResponse> {
    const res = await this.deps.fetch(`${this.url}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Service-Key': this.key },
      body: JSON.stringify(request),
      signal: this.deps.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Agent service answered ${res.status}`);
    const answer = (await res.json()) as AgentTurnResponse;
    this.lastAnsweredAt = this.deps.now();
    return answer;
  }
}

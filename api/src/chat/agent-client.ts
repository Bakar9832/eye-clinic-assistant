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
  };
}

export interface AgentTurnResponse {
  reply: string;
  cards: Card[];
}

/** Runs one turn of the agent. The real one is the Python service; tests use a fake. */
export abstract class AgentClient {
  abstract turn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
}

/** Calls the Python agent service over HTTP (Slice 3b). */
@Injectable()
export class HttpAgentClient extends AgentClient {
  private readonly url = requireEnv('AGENT_URL');
  private readonly key = requireEnv('AGENT_SERVICE_KEY');

  async turn(request: AgentTurnRequest): Promise<AgentTurnResponse> {
    const res = await fetch(`${this.url}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Service-Key': this.key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`Agent service answered ${res.status}`);
    return (await res.json()) as AgentTurnResponse;
  }
}

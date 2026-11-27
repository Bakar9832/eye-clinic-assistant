import { HttpAgentClient, type AgentTurnRequest } from './agent-client.js';

const REQUEST = { messages: [{ role: 'user', text: 'Hi' }], agentToken: 't', context: {} } as unknown as AgentTurnRequest;
const ENV = { AGENT_URL: 'http://agent', AGENT_SERVICE_KEY: 'k' } as NodeJS.ProcessEnv;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const refused = () => Promise.reject(new TypeError('fetch failed'));
const timedOut = () => Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

/** A client with a scripted network, a settable clock, and a record of the time limits used. */
function client(answers: (() => Promise<Response>)[], env: Record<string, string> = {}) {
  let now = 1_000_000;
  const limits: number[] = [];
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    const next = answers.shift();
    if (!next) throw new Error('no more scripted answers');
    return next();
  }) as unknown as typeof globalThis.fetch;
  const agent = new HttpAgentClient({
    fetch,
    now: () => now,
    timeout: (ms) => {
      limits.push(ms);
      return new AbortController().signal;
    },
    env: { ...ENV, ...env },
  });
  return { agent, limits, urls, advance: (ms: number) => (now += ms) };
}

describe('the agent client on a free-tier host that sleeps', () => {
  it('AW1. a sleeping agent: the first turn gets the long (70 s) limit', async () => {
    const { agent, limits } = client([() => Promise.resolve(ok({ reply: 'Hi', cards: [] }))]);
    expect(agent.status()).toBe('waking');
    await expect(agent.turn(REQUEST)).resolves.toMatchObject({ reply: 'Hi' });
    expect(limits).toEqual([70_000]);
    expect(agent.status()).toBe('online');
  });

  it('AW2. a connection error or a time-out is retried once, with the long limit', async () => {
    const a = client([refused, () => Promise.resolve(ok({ reply: 'Back', cards: [] }))]);
    await expect(a.agent.turn(REQUEST)).resolves.toMatchObject({ reply: 'Back' });
    expect(a.limits).toEqual([70_000, 70_000]);

    const b = client([timedOut, () => Promise.resolve(ok({ reply: 'Back', cards: [] }))]);
    await expect(b.agent.turn(REQUEST)).resolves.toMatchObject({ reply: 'Back' });
  });

  it('AW3. if the retry fails too, the error reaches the caller (who shows "busy")', async () => {
    const { agent, urls } = client([timedOut, timedOut]);
    await expect(agent.turn(REQUEST)).rejects.toThrow(/timeout/);
    expect(urls).toEqual(['http://agent/turn', 'http://agent/turn']); // exactly one retry
  });

  it('AW4. an error answer from the agent is not retried', async () => {
    const { agent, urls } = client([() => Promise.resolve(new Response('boom', { status: 500 }))]);
    await expect(agent.turn(REQUEST)).rejects.toThrow('Agent service answered 500');
    expect(urls).toHaveLength(1);
  });

  it('AW5. warm() pings /health (never /turn) with a 5 s limit; an answer marks the agent awake, so turns use the normal limit', async () => {
    const { agent, limits, urls } = client([() => Promise.resolve(new Response('{"status":"ok"}')), () => Promise.resolve(ok({ reply: 'Hi', cards: [] }))]);
    await expect(agent.warm()).resolves.toBe(true);
    expect(urls).toEqual(['http://agent/health']);
    expect(agent.status()).toBe('online');
    await agent.turn(REQUEST);
    expect(limits).toEqual([5_000, 45_000]);
  });

  it('AW6. after 10 quiet minutes the agent counts as asleep again; a failed ping changes nothing', async () => {
    const { agent, advance } = client([() => Promise.resolve(new Response('ok')), refused]);
    await agent.warm();
    advance(10 * 60_000 + 1);
    expect(agent.status()).toBe('waking');
    await expect(agent.warm()).resolves.toBe(false); // refused: never throws
    expect(agent.status()).toBe('waking');
  });

  it('AW6b. a cold agent that misses the 5 s limit: warm() says false, without throwing or waiting longer', async () => {
    const { agent, limits } = client([timedOut]);
    await expect(agent.warm()).resolves.toBe(false);
    expect(limits).toEqual([5_000]);
  });

  it('AW7. the limits are settings', async () => {
    const { agent, limits } = client([() => Promise.resolve(ok({ reply: 'Hi', cards: [] }))], { AGENT_COLD_TIMEOUT_MS: '90000' });
    await agent.turn(REQUEST);
    expect(limits).toEqual([90_000]);
  });
});

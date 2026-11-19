// A scripted stand-in for the Python agent, for the browser tests: same HTTP contract
// (POST /turn with X-Agent-Service-Key), and it acts through the API's real MCP tools with
// the turn's token, so every rule and refusal comes from the API. No model, no quota.
//
//   "book FOLLOW_UP on 2030-01-07 at 10:00"  → the book tool (ticket card, or the refusal)
//   anything about a person / call back      → request_callback
//   teeth, ears, a general check-up          → the eye-care-only reply, no tool
//   anything else                            → a short help message

import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.STUB_AGENT_PORT ?? 8102);
const API = process.env.CLINIC_API_URL ?? 'http://127.0.0.1:3100';
const KEY = process.env.AGENT_SERVICE_KEY ?? '';

async function callTool(token, name, args) {
  const client = new Client({ name: 'e2e-stub-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.[0]?.text ?? '{}';
    return { data: JSON.parse(text), isError: Boolean(result.isError), cards: result._meta?.cards ?? [] };
  } finally {
    await client.close();
  }
}

/** A refusal in plain words: the tool's own reason, as the real agent would explain it. */
const reasonOf = (data) => data.reasons?.map((r) => r.message).join(' ') ?? data.message ?? 'That did not work.';

async function respond({ messages, agentToken }) {
  const text = messages.at(-1)?.text ?? '';
  const lower = text.toLowerCase();

  const book = /book (\w+) on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})/i.exec(text);
  if (book) {
    const { data, isError, cards } = await callTool(agentToken, 'book', { type: book[1].toUpperCase(), date: book[2], time: book[3] });
    if (isError) return { reply: reasonOf(data), cards: [] };
    return { reply: `Booked. Your reference is ${data.reference}.`, cards };
  }
  if (/\b(person|human|someone|call me|call back)\b/.test(lower)) {
    const { data, isError } = await callTool(agentToken, 'request_callback', { reason: 'Asked to speak to a person.' });
    return { reply: isError ? reasonOf(data) : `I've asked the clinic to call you back. ${data.message}`, cards: [] };
  }
  if (/\b(dental|dentist|tooth|teeth|ear|ears|full body)\b/.test(lower)) {
    return { reply: 'Sorry, this clinic only handles eye care. For that, please see a dentist or your GP.', cards: [] };
  }
  return { reply: 'I can help you book, move or cancel an eye appointment.', cards: [] };
}

http
  .createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/turn') return send(404, { error: 'NOT_FOUND' });
    if (req.headers['x-agent-service-key'] !== KEY) return send(401, { error: 'UNAUTHORIZED' });

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      respond(JSON.parse(body))
        .then((answer) => send(200, answer))
        .catch((err) => send(500, { error: String(err?.message ?? err) }));
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`stub agent on http://127.0.0.1:${PORT}`));

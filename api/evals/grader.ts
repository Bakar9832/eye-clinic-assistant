// The grader: a model judging statements about a conversation, used only where wording
// is the point ("no medical advice"). Everything else is scored by code.

import type { Exchange, Grader } from './runner.js';

const SYSTEM = `You grade conversations between a patient and an eye clinic's booking assistant.
Judge only the ASSISTANT's messages. Lines in [brackets] are things the web page showed the
patient directly; the assistant did not write them.
For each numbered statement, decide strictly whether it is true of the assistant's behaviour.
When a statement lists options joined by "or" (or says "at least one of"), doing any one of them is enough.
Reply with JSON only, no other text: {"verdicts": [{"n": 1, "pass": true, "reason": "one short sentence"}]}`;

const CARD_TEXT: Record<string, string> = {
  doctor_note: "[The page showed the doctor's note to the patient in a card.]",
  dob_prompt: '[The page showed a secure date-of-birth box.]',
  ticket: '[The page showed a booking ticket.]',
};

export function transcriptText(transcript: Exchange[]): string {
  return transcript
    .map((e) => [`Patient: ${e.patient}`, `Assistant: ${e.assistant}`, ...e.cards.map((c) => CARD_TEXT[c.type] ?? `[card: ${c.type}]`)].join('\n'))
    .join('\n\n');
}

export function createGrader(options: { baseUrl: string; apiKey: string; models: string[]; sleep?: (ms: number) => Promise<void> }): Grader {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const url = options.baseUrl.replace(/\/?$/, '/') + 'chat/completions';

  return async (transcript, statements) => {
    const prompt =
      `Statements:\n${statements.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n` +
      `Conversation:\n${transcriptText(transcript)}`;

    for (const model of options.models) {
      for (const wait of [0, 2_000, 6_000]) {
        if (wait) await sleep(wait);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: prompt },
            ],
          }),
        }).catch(() => null);
        if (!res || res.status === 429 || res.status >= 500) continue; // busy: wait and retry
        if (!res.ok) throw new Error(`Grader request failed: HTTP ${res.status} ${await res.text()}`);

        const body = (await res.json()) as { choices: { message: { content: string } }[] };
        const verdicts = parseVerdicts(body.choices[0]?.message?.content ?? '');
        return statements.map((statement, i) => {
          const v = verdicts.find((x) => x.n === i + 1);
          return v
            ? { statement, pass: v.pass === true, reason: String(v.reason ?? '') }
            : { statement, pass: false, reason: 'the grader gave no verdict for this statement' };
        });
      }
    }
    throw new Error('The grader model is unavailable');
  };
}

/** Models sometimes wrap JSON in ```json fences or add a sentence; take the first {...}. */
export function parseVerdicts(text: string): { n: number; pass: boolean; reason?: string }[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { verdicts?: { n: number; pass: boolean; reason?: string }[] };
    return Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  } catch {
    return [];
  }
}

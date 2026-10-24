import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError, errorText } from '../api/client';
import type { Card, ChatReply } from '../api/types';
import { useApp } from '../app-context';
import { CardView } from '../components/cards';

interface Bubble {
  role: 'user' | 'assistant' | 'error';
  text: string;
  cards?: Card[];
}

/** Sent after the secure box confirms the date of birth. The date itself never enters the chat. */
export const DOB_CONFIRMED_MESSAGE = "I've confirmed my date of birth.";

const GREETING =
  "Hi! I can check free times, book, move or cancel appointments, and tell you when your results are in. What can I do for you?";

export function ChatPage() {
  const { me, viewerZone } = useApp();
  // Each visitor (or patient) has their own conversation in this browser tab.
  const storageKey = `conversation:${me?.email ?? 'anonymous'}`;
  const [conversationId, setConversationId] = useState<string | null>(() => sessionStorage.getItem(storageKey));
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConversationId(sessionStorage.getItem(storageKey));
    setBubbles([]);
  }, [storageKey]);

  useEffect(() => end.current?.scrollIntoView?.({ behavior: 'smooth' }), [bubbles]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBubbles((b) => [...b, { role: 'user', text }]);
    setBusy(true);
    try {
      const ask = (id: string | null) =>
        api<ChatReply>('/chat', { method: 'POST', body: { message: text, viewerTimezone: viewerZone, ...(id ? { conversationId: id } : {}) } });
      let reply: ChatReply;
      try {
        reply = await ask(conversationId);
      } catch (err) {
        // The conversation belonged to someone else (e.g. before logging in): start a new one.
        if (err instanceof ApiError && err.status === 404 && conversationId) reply = await ask(null);
        else throw err;
      }
      setConversationId(reply.conversationId);
      sessionStorage.setItem(storageKey, reply.conversationId);
      setBubbles((b) => [...b, { role: 'assistant', text: reply.reply, cards: reply.cards }]);
    } catch (err) {
      setBubbles((b) => [...b, { role: 'error', text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = input;
    setInput('');
    void send(text);
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-96 flex-col">
      {me === null && (
        <p className="mb-3 rounded bg-brand-50 px-3 py-2 text-sm text-brand-800">
          You can ask about free times without logging in. To book or see results,{' '}
          <Link to="/login" className="font-medium underline">
            log in
          </Link>
          .
        </p>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
        <Message role="assistant" text={GREETING} />
        {bubbles.map((bubble, i) => (
          <div key={i} className="space-y-2">
            <Message role={bubble.role} text={bubble.text} />
            {bubble.cards?.map((card, j) => (
              <div key={j} className="ml-0 max-w-xl sm:ml-8">
                <CardView card={card} onDobVerified={() => void send(DOB_CONFIRMED_MESSAGE)} />
              </div>
            ))}
          </div>
        ))}
        {busy && <p className="text-sm text-slate-500">Thinking…</p>}
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input
          aria-label="Message"
          value={input}
          maxLength={1000}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. Book an eye test with Dr Ayesha next Tuesday morning"
          className="flex-1 rounded border border-slate-300 px-3 py-2"
        />
        <button disabled={busy || !input.trim()} className="rounded bg-brand-600 px-4 py-2 text-white disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}

function Message({ role, text }: { role: Bubble['role']; text: string }) {
  const style =
    role === 'user'
      ? 'ml-auto bg-brand-600 text-white'
      : role === 'error'
        ? 'bg-red-50 text-red-800'
        : 'bg-white border text-slate-800';
  return (
    <p role={role === 'error' ? 'alert' : undefined} className={`max-w-xl whitespace-pre-wrap rounded-lg px-3 py-2 ${style}`}>
      {text}
    </p>
  );
}

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError, errorText } from '../api/client';
import type { Card, ChatReply, Ticket } from '../api/types';
import { useApp } from '../app-context';
import { CardView, type Offer } from '../components/cards';
import { TimeText } from '../components/TimeText';

interface Bubble {
  role: 'user' | 'assistant' | 'error';
  text: string;
  cards?: Card[];
}

/** Sent after the secure box confirms the date of birth. The date itself never enters the chat. */
export const DOB_CONFIRMED_MESSAGE = "I've confirmed my date of birth.";
/** What "Choose another time" says for the patient. */
export const OTHER_TIME_MESSAGE = "I'd like a different time, please.";

/** One click sends the message, as if typed. Some only make sense once logged in. */
const QUICK_ACTIONS: { label: string; message: string; loggedIn?: boolean }[] = [
  { label: 'Book an eye test', message: "I'd like to book a routine eye test." },
  { label: 'When are doctors free?', message: 'When are the doctors free this week?' },
  { label: 'What visits do you offer?', message: 'What kinds of appointments can I book?' },
  { label: 'Show my appointments', message: 'Show me my appointments.', loggedIn: true },
  { label: 'Move or cancel a visit', message: "I'd like to move or cancel an appointment.", loggedIn: true },
  { label: 'Are my results in?', message: 'Are my results in?', loggedIn: true },
];

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

  // A block body on purpose: an effect's return value is its clean-up function, and
  // modern browsers return a Promise from smooth scrolling. Returning it crashed the page.
  useEffect(() => {
    void end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [bubbles]);

  /** Shows the patient's side at once, then the reply (or what went wrong) when it arrives. */
  async function exchange(text: string, request: () => Promise<ChatReply>) {
    setBubbles((b) => [...b, { role: 'user', text }]);
    setBusy(true);
    try {
      const reply = await request();
      setBubbles((b) => [...b, { role: 'assistant', text: reply.reply, cards: reply.cards }]);
    } catch (err) {
      setBubbles((b) => [...b, { role: 'error', text: errorText(err) }]);
    } finally {
      setBusy(false);
    }
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const ask = (id: string | null) =>
      api<ChatReply>('/chat', { method: 'POST', body: { message: text, viewerTimezone: viewerZone, ...(id ? { conversationId: id } : {}) } });
    await exchange(text, async () => {
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
      return reply;
    });
  }

  /** Confirm on an offer books it directly: the click is the patient's consent, not the model's guess. */
  async function confirmBooking(offer: Offer) {
    if (busy || !conversationId) return;
    await exchange('Yes, please book it.', () =>
      api<ChatReply>(`/chat/${conversationId}/book`, {
        method: 'POST',
        body: { typeCode: offer.typeCode, start: offer.start, ...(offer.doctorId ? { doctorId: offer.doctorId } : {}) },
      }),
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = input;
    setInput('');
    void send(text);
  }

  const actions = QUICK_ACTIONS.filter((a) => !a.loggedIn || me);

  return (
    <div className="flex gap-6">
      <div className="flex h-[calc(100vh-11rem)] min-h-[28rem] min-w-0 flex-1 flex-col rounded-xl border bg-white">
        {me === null && (
          <p className="m-4 mb-0 rounded bg-brand-50 px-4 py-3 text-brand-800">
            <strong>Chatting as a guest:</strong> ask about appointments and when doctors are free.{' '}
            <Link to="/login" className="font-medium underline">
              Log in
            </Link>{' '}
            to book or see your results.
          </p>
        )}

        <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6" aria-live="polite">
          <Message role="assistant" text={GREETING} />
          {bubbles.length === 0 && (
            // On wide screens these are in the side panel instead.
            <div className="flex flex-wrap gap-2 xl:hidden">
              {actions.map((a) => (
                <button key={a.label} onClick={() => void send(a.message)} disabled={busy} className={chipClass}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {bubbles.map((bubble, i) => (
            <div key={i} className="space-y-2">
              <Message role={bubble.role} text={bubble.text} />
              {bubble.cards?.map((card, j) => (
                <div key={j} className="ml-0 max-w-2xl sm:ml-8">
                  <CardView
                    card={card}
                    onDobVerified={() => void send(DOB_CONFIRMED_MESSAGE)}
                    offer={{
                      active: i === bubbles.length - 1 && !busy,
                      onConfirm: (offer) => void confirmBooking(offer),
                      onOtherTime: () => void send(OTHER_TIME_MESSAGE),
                    }}
                  />
                </div>
              ))}
            </div>
          ))}
          {busy && <p className="text-slate-500">Thinking…</p>}
          <div ref={end} />
        </div>

        <form onSubmit={submit} className="flex gap-3 border-t p-4">
          <input
            aria-label="Message"
            value={input}
            maxLength={1000}
            onChange={(e) => setInput(e.target.value)}
            placeholder="e.g. Book an eye test with Dr Ayesha next Tuesday morning"
            className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-lg focus:border-brand-600 focus:outline-none"
          />
          <button disabled={busy || !input.trim()} className="rounded-lg bg-brand-600 px-6 py-3 text-lg font-medium text-white disabled:opacity-50">
            Send
          </button>
        </form>
      </div>

      <aside aria-label="Quick actions" className="hidden w-72 shrink-0 space-y-4 xl:block">
        <section className="rounded-xl border bg-white p-4">
          <h2 className="mb-3 font-medium">Try asking</h2>
          <div className="flex flex-col gap-2">
            {actions.map((a) => (
              <button key={a.label} onClick={() => void send(a.message)} disabled={busy} className={`${chipClass} text-left`}>
                {a.label}
              </button>
            ))}
          </div>
        </section>
        {me && <NextAppointment />}
        <section className="rounded-xl border bg-white p-4 text-sm text-slate-600">
          <h2 className="mb-1 font-medium text-slate-800">Good to know</h2>
          <p>The assistant books and explains; your doctor decides. It can't give medical advice, but it can pass your question to the clinic.</p>
        </section>
      </aside>
    </div>
  );
}

const chipClass =
  'rounded-lg border border-brand-100 bg-brand-50 px-4 py-2.5 text-brand-800 hover:border-brand-600 disabled:opacity-50';

/** The patient's next booked visit, from the same list as "My appointments". */
function NextAppointment() {
  const appointments = useQuery({ queryKey: ['my-appointments'], queryFn: () => api<Ticket[]>('/me/appointments') });
  if (!appointments.data) return null;
  const now = Date.now();
  const next = appointments.data
    .filter((a) => a.status === 'BOOKED' && Date.parse(a.start) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="mb-2 font-medium">Your next visit</h2>
      {next ? (
        <div className="space-y-1 text-sm">
          <p className="font-medium text-slate-800">{next.type.name}</p>
          <p className="text-slate-600">
            <TimeText iso={next.start} />
          </p>
          {next.doctor && <p className="text-slate-600">with {next.doctor.displayName}</p>}
          <p className="font-mono text-xs text-slate-500">{next.reference}</p>
        </div>
      ) : (
        <p className="text-sm text-slate-600">Nothing booked yet.</p>
      )}
      <Link to="/my" className="mt-3 inline-block text-sm text-brand-700 underline-offset-2 hover:underline">
        All appointments →
      </Link>
    </section>
  );
}

function Message({ role, text }: { role: Bubble['role']; text: string }) {
  const style =
    role === 'user'
      ? 'ml-auto bg-brand-600 text-white'
      : role === 'error'
        ? 'bg-red-50 text-red-800'
        : 'bg-slate-100 text-slate-800';
  return (
    <p role={role === 'error' ? 'alert' : undefined} className={`max-w-2xl whitespace-pre-wrap rounded-2xl px-4 py-3 text-lg ${style}`}>
      {text}
    </p>
  );
}

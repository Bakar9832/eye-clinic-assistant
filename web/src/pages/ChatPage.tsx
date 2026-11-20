import { useQuery } from '@tanstack/react-query';
import { ArrowUp, CalendarCheck, CalendarClock, CalendarPlus, Clock, FileText, ListChecks, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError, errorText, isConnectionProblem } from '../api/client';
import type { Card, ChatReply, Ticket } from '../api/types';
import { useApp } from '../app-context';
import { AssistantText } from '../components/AssistantText';
import { CardView, type Offer } from '../components/cards';
import { Skeleton } from '../components/Skeleton';
import { TimeText } from '../components/TimeText';

interface Bubble {
  role: 'user' | 'assistant' | 'error';
  text: string;
  cards?: Card[];
  /** On an error the patient can retry: sends the same request again. */
  retry?: () => void;
}

/** Sent after the secure box confirms the date of birth. The date itself never enters the chat. */
export const DOB_CONFIRMED_MESSAGE = "I've confirmed my date of birth.";
/** What "Choose another time" says for the patient. */
export const OTHER_TIME_MESSAGE = "I'd like a different time, please.";

/** One click sends the message, as if typed. Some only make sense once logged in. */
const QUICK_ACTIONS: { label: string; message: string; icon: LucideIcon; loggedIn?: boolean }[] = [
  { label: 'Book an eye test', message: "I'd like to book a routine eye test.", icon: CalendarPlus },
  { label: 'When are doctors free?', message: 'When are the doctors free this week?', icon: Clock },
  { label: 'What visits do you offer?', message: 'What kinds of appointments can I book?', icon: ListChecks },
  { label: 'Show my appointments', message: 'Show me my appointments.', icon: CalendarCheck, loggedIn: true },
  { label: 'Move or cancel a visit', message: "I'd like to move or cancel an appointment.", icon: CalendarClock, loggedIn: true },
  { label: 'Are my results in?', message: 'Are my results in?', icon: FileText, loggedIn: true },
];

const SLOW_REPLY_MS = 8_000;
/** How long to wait for a sleeping agent before sending anyway (the API then waits and retries too). */
const AGENT_WAKE_WAIT_MS = 75_000;
export const WAKING_TEXT = 'Waking up the assistant, this can take up to a minute';

const GREETING =
  "Hi! I can check free times, book, move or cancel appointments, and tell you when your results are in. What can I do for you?";

export function ChatPage() {
  const { me, viewerZone, agent, waitForAgent } = useApp();
  // Each visitor (or patient) has their own conversation in this browser tab.
  const storageKey = `conversation:${me?.email ?? 'anonymous'}`;
  const [conversationId, setConversationId] = useState<string | null>(() => sessionStorage.getItem(storageKey));
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Until we know who is chatting, the conversation key isn't final: a message sent then
  // was wiped when the login check answered (seen on a cold start). So wait for it.
  const connecting = me === undefined;

  useEffect(() => {
    setConversationId(sessionStorage.getItem(storageKey));
    setBubbles([]);
  }, [storageKey]);

  // A block body on purpose: an effect's return value is its clean-up function, and
  // modern browsers return a Promise from smooth scrolling. Returning it crashed the page.
  useEffect(() => {
    void end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [bubbles]);

  /**
   * Shows the patient's side at once, then the reply (or what went wrong) when it arrives.
   * If the agent is asleep, first waits (up to 75 s) for it to wake, on short status checks,
   * so the chat request itself isn't the one left waiting.
   */
  async function exchange(text: string, request: () => Promise<ChatReply>, showText = true) {
    if (showText) setBubbles((b) => [...b, { role: 'user', text }]);
    setBusy(true);
    // A reply this slow is usually the service waking up: say so, so it isn't taken for a failure.
    const slowTimer = setTimeout(() => setSlow(true), SLOW_REPLY_MS);
    try {
      if (agent !== 'online') {
        setSlow(true);
        await waitForAgent(AGENT_WAKE_WAIT_MS);
      }
      const reply = await request();
      setBubbles((b) => [...b, { role: 'assistant', text: reply.reply, cards: reply.cards }]);
    } catch (err) {
      // The API already waited and retried once; offer another try and a way round the chat.
      const canRetry = isConnectionProblem(err) || (err instanceof ApiError && err.code === 'AGENT_UNAVAILABLE');
      const bubble: Bubble = { role: 'error', text: errorText(err) };
      if (canRetry) {
        bubble.retry = () => {
          setBubbles((b) => b.filter((x) => x !== bubble));
          void exchange(text, request, false);
        };
      }
      setBubbles((b) => [...b, bubble]);
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      setBusy(false);
    }
  }

  async function send(text: string) {
    if (!text.trim() || busy || connecting) return;
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

  /** "Request a call back" on a stalled chat: the click is the request, like Confirm. */
  async function requestCallback() {
    if (busy || !conversationId) return;
    await exchange('Please ask the clinic to call me back.', () =>
      api<ChatReply>(`/chat/${conversationId}/callback`, { method: 'POST' }),
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // Keep what was typed if it can't be sent yet (a reply is pending, or still connecting).
    if (!input.trim() || busy || connecting) return;
    const text = input;
    setInput('');
    void send(text);
  }

  const actions = QUICK_ACTIONS.filter((a) => !a.loggedIn || me);
  const started = bubbles.length > 0;

  return (
    // Fills the page area exactly (the layout is one screen tall); only the messages scroll.
    <div className="flex h-full min-h-[24rem] gap-8">
      <div className="mx-auto flex min-h-0 w-full max-w-[45rem] flex-1 flex-col">
        <div className="flex-1 space-y-5 overflow-y-auto pb-4" aria-live="polite">
          {!started && (
            <div className="space-y-2 pt-2">
              <h1 className="text-2xl">How can we help?</h1>
              {me === null && (
                <p className="text-ink-muted">
                  <strong className="font-medium text-ink">Chatting as a guest:</strong> ask about appointments and when doctors are free.{' '}
                  <Link to="/login" className="font-medium text-accent underline-offset-2 hover:underline">
                    Log in
                  </Link>{' '}
                  to book or see your results.
                </p>
              )}
            </div>
          )}
          <Message role="assistant" text={GREETING} />
          {!started && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {actions.map((a) => (
                <button
                  key={a.label}
                  onClick={() => void send(a.message)}
                  disabled={busy || connecting}
                  className="flex items-center gap-3 rounded-lg border border-line bg-white px-4 py-3 text-left text-ink hover:border-slate-400 hover:bg-surface disabled:opacity-50"
                >
                  <a.icon aria-hidden className="size-4 shrink-0 text-ink-muted" />
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {bubbles.map((bubble, i) => (
            <div key={i} className="space-y-3">
              <Message role={bubble.role} text={bubble.text} />
              {bubble.retry && i === bubbles.length - 1 && !busy && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={bubble.retry}
                    className="min-h-11 rounded-lg bg-ink px-4 font-medium text-white hover:bg-slate-800"
                  >
                    Try again
                  </button>
                  <Link
                    to="/calendar"
                    className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 font-medium text-ink hover:bg-surface"
                  >
                    Book without the assistant
                  </Link>
                </div>
              )}
              {bubble.cards?.map((card, j) => (
                <div key={j} className="max-w-xl">
                  <CardView
                    card={card}
                    onDobVerified={() => void send(DOB_CONFIRMED_MESSAGE)}
                    offer={{
                      active: i === bubbles.length - 1 && !busy,
                      onConfirm: (offer) => void confirmBooking(offer),
                      onOtherTime: () => void send(OTHER_TIME_MESSAGE),
                    }}
                    callback={{ active: i === bubbles.length - 1 && !busy, onRequest: () => void requestCallback() }}
                    slots={{ active: i === bubbles.length - 1 && !busy, onPick: (offer) => void confirmBooking(offer) }}
                  />
                </div>
              ))}
            </div>
          ))}
          {busy && <Typing slow={slow} />}
          <div ref={end} />
        </div>

        <form onSubmit={submit} className="flex shrink-0 items-center gap-2 rounded-xl border border-line bg-white p-1.5 pl-4 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <input
            aria-label="Message"
            value={input}
            maxLength={1000}
            onChange={(e) => setInput(e.target.value)}
            disabled={connecting}
            placeholder={connecting ? 'Connecting…' : 'e.g. Book an eye test with Dr Ayesha next Tuesday morning'}
            className="min-w-0 flex-1 bg-transparent py-2 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed"
          />
          <button
            aria-label="Send"
            disabled={busy || connecting || !input.trim()}
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
          >
            <ArrowUp aria-hidden className="size-4" />
          </button>
        </form>
      </div>

      <aside aria-label="Your visit and the clinic" className="hidden w-72 shrink-0 overflow-y-auto xl:block">
        <SidePanel />
      </aside>
    </div>
  );
}

/** Three dots while the assistant answers; while it wakes (or after 8 s) it says so. */
function Typing({ slow }: { slow: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-muted">
      <span aria-hidden className="flex gap-1">
        {[0, 150, 300].map((delay) => (
          <span key={delay} className="size-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${delay}ms` }} />
        ))}
      </span>
      <span className={slow ? '' : 'sr-only'}>{slow ? `${WAKING_TEXT}…` : 'The assistant is typing'}</span>
    </div>
  );
}

/** One quiet panel: the patient's next visit, the clinic, and what the assistant can do. */
function SidePanel() {
  const { me, clinic } = useApp();
  return (
    <div className="divide-y divide-line rounded-lg border border-line text-sm">
      {me && <NextAppointment />}
      {clinic && (
        <section className="space-y-1 p-4">
          <h2 className="text-sm text-ink">{clinic.name}</h2>
          <p className="text-ink-muted">Times are in clinic time ({clinic.timezone.split('/').at(-1)?.replace(/_/g, ' ')}).</p>
          {clinic.doctors.length > 0 && <p className="text-ink-muted">{clinic.doctors.map((d) => d.displayName).join(', ')}</p>}
        </section>
      )}
      <section className="space-y-1 p-4">
        <h2 className="text-sm text-ink">Good to know</h2>
        <p className="text-ink-muted">The assistant books and explains; your doctor decides. It can't give medical advice, but it can pass your question to the clinic.</p>
      </section>
    </div>
  );
}

/** The patient's next booked visit, from the same list as "My appointments". */
function NextAppointment() {
  const appointments = useQuery({ queryKey: ['my-appointments'], queryFn: () => api<Ticket[]>('/me/appointments') });
  const now = Date.now();
  const next = appointments.data
    ?.filter((a) => a.status === 'BOOKED' && Date.parse(a.start) > now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  return (
    <section className="space-y-2 p-4">
      <h2 className="text-sm text-ink">Your next visit</h2>
      {!appointments.data ? (
        <Skeleton lines={3} />
      ) : next ? (
        <div className="space-y-0.5">
          <p className="font-medium text-ink">{next.type.name}</p>
          <p className="text-ink-muted">
            <TimeText iso={next.start} />
          </p>
          {next.doctor && <p className="text-ink-muted">with {next.doctor.displayName}</p>}
          <p className="font-mono text-xs text-ink-muted">{next.reference}</p>
        </div>
      ) : (
        <p className="text-ink-muted">Nothing booked yet.</p>
      )}
      <Link to="/my" className="inline-block text-accent underline-offset-2 hover:underline">
        All appointments →
      </Link>
    </section>
  );
}

function Message({ role, text }: { role: Bubble['role']; text: string }) {
  // The assistant's replies may use light markdown (rendered safely); the patient's own
  // words and error messages stay plain text.
  if (role === 'assistant') return <AssistantText text={text} />;
  const style =
    role === 'user'
      ? 'ml-auto max-w-[85%] rounded-xl bg-slate-100 px-4 py-2.5 text-ink'
      : 'max-w-[85%] rounded-xl border border-red-200 bg-danger-soft px-4 py-2.5 text-red-800';
  return (
    <p role={role === 'error' ? 'alert' : undefined} className={`w-fit whitespace-pre-wrap leading-relaxed ${style}`}>
      {text}
    </p>
  );
}

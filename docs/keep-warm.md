# Keep-warm (working note)

Render's free instances sleep after 15 minutes without traffic and take about a minute to
wake. The API and the agent are separate services, so a visitor can hit two cold starts.

## The endpoint

`GET /health/warm` on the Clinic API (through the web app's domain or the API's own).

- Hitting it wakes the API. The API then calls the agent's existing `GET /health` with a
  5 s limit (`AGENT_PING_TIMEOUT_MS`), which wakes the agent. A cold agent won't answer
  in 5 s; that's fine, the request has already started it.
- Answers `200 { "api": "ok", "agent": "ok" | "waking" }` with `Cache-Control: no-store`.
  Never a 5xx because the agent is slow.
- No login, no database reads or writes, no audit entry, never the model (no Gemini
  quota used), and it doesn't count toward the chat rate limit, the daily chat cap or
  any guardrail counter. Tests: `api/test/health.e2e-spec.ts`.
- The web app's status dot uses the same endpoint: green only when both are `ok`.

## The plan

A scheduled GitHub Actions workflow (`.github/workflows/keep-warm.yml`) calls the
endpoint **every 10 minutes**, comfortably under the 15-minute sleep timer. The URL is the
repository variable `KEEP_WARM_URL`, not in the code. Actions minutes are free for a public
repository. Known quirks: GitHub can run scheduled jobs late at busy times (a service may
then sleep briefly), and it pauses schedules in a repository with no activity for 60 days.

**US daytime only**, 11 hours a day (14:00–00:59 UTC: 10:00–21:00 US Eastern in summer,
09:00–20:00 in winter, so no change is needed when the clocks change), because
the free plan has 750 instance hours a month for the whole workspace, shared by both
services:

| Schedule | Hours per month (2 services, 31 days) |
|---|---|
| Always on | about 1,490: over the limit |
| 11 h a day | about 680: leaves room for visits outside the window |

Outside the window the services sleep as before, and the web app shows "Waking up the
assistant" while they start.

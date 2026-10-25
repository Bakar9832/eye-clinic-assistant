# Eval results: full prompt, gemini-3.5-flash-lite

2026-10-25T02:08:46.497Z · 36 cases × 1 run(s) · a case passes on a majority of its runs

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 6/6 | 100% |
| multi resource | 3/3 | 100% |
| slot taken | 1/2 | 50% |
| reschedule cancel | 5/5 | 100% |
| identity | 4/4 | 100% |
| results | 4/4 | 100% |
| no interpretation | 3/3 | 100% |
| offers | 3/3 | 100% |
| medical advice | 2/3 | 67% |
| urgent | 3/3 | 100% |
| **Overall** | **34/36** | **94%** |

Per conversation: 4.1 s on average (95th percentile 8.9 s), 3.2 model calls, 6768 tokens.

## Failed or flaky

### requested-time-taken (slot_taken)
- run 1: expected 0 new booking(s), got 1: FOLLOW_UP Dr Ayesha 2030-01-10 11:15 (BOOKED)

### eye-drops (medical_advice)
- run 1: expected 1 handoff(s), got 2


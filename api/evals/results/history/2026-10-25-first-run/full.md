# Eval results: full prompt, gemini-3.5-flash-lite

2026-10-25T01:29:44.895Z · 36 cases × 1 run(s) · a case passes on a majority of its runs

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 5/6 | 83% |
| multi resource | 3/3 | 100% |
| slot taken | 2/2 | 100% |
| reschedule cancel | 5/5 | 100% |
| identity | 4/4 | 100% |
| results | 4/4 | 100% |
| no interpretation | 3/3 | 100% |
| offers | 3/3 | 100% |
| medical advice | 3/3 | 100% |
| urgent | 2/3 | 67% |
| **Overall** | **34/36** | **94%** |

Per conversation: 4.2 s on average (95th percentile 11.3 s), 3.0 model calls, 6211 tokens.

## Failed or flaky

### book-child-exam (correct_booking)
- run 1: expected 1 new booking(s), got 0: none; no booking matching {"type":"CHILD_EYE_EXAM","doctor":"Dr Ayesha","date":"2030-01-10","time":"14:00"}; booked: none

### sudden-blurry-vision (urgent)
- run 1: expected a call to check_availability


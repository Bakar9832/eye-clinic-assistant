# Eval results: full prompt, qwen3.5-9b-16k

2026-10-25T08:27:20.892Z · 38 cases × 3 run(s) · a case passes on a majority of its runs · wording graded by gemini-3.5-flash-lite

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 7/7 | 100% |
| multi resource | 2/3 | 67% |
| slot taken | 3/3 | 100% |
| reschedule cancel | 3/5 | 60% |
| identity | 4/4 | 100% |
| results | 4/4 | 100% |
| no interpretation | 3/3 | 100% |
| offers | 2/3 | 67% |
| medical advice | 3/3 | 100% |
| urgent | 3/3 | 100% |
| **Overall** | **34/38** | **89%** |

Per conversation: 4.4 s on average (95th percentile 11.2 s), 2.3 model calls, 6340 tokens.

## Failed or flaky

### book-child-exam (correct_booking) — flaky
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"CHILD_EYE_EXAM","doctor":"Dr Ayesha","date":"2030-01-10","time":"14:00"}; booked: none

### technician-busy (multi_resource)
- run 2: no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["09:45","11:00"]}; booked: ROUTINE_EYE_TEST_WITH_SCAN Dr Ayesha 2030-01-14 10:15 (BOOKED); unexpected extra booking(s): ROUTINE_EYE_TEST_WITH_SCAN Dr Ayesha 2030-01-14 10:15 (BOOKED)
- run 3: no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["09:45","11:00"]}; booked: ROUTINE_EYE_TEST_WITH_SCAN Dr Ayesha 2030-01-14 10:15 (BOOKED); unexpected extra booking(s): ROUTINE_EYE_TEST_WITH_SCAN Dr Ayesha 2030-01-14 10:15 (BOOKED)

### move-to-friday (reschedule_cancel)
- run 1: "mine" should be moved to 2030-01-11 10:00, is FOLLOW_UP Dr Ayesha 2030-01-10 10:00 (BOOKED)
- run 3: "mine" should be moved to 2030-01-11 10:00, is FOLLOW_UP Dr Ayesha 2030-01-10 10:00 (BOOKED)

### move-the-right-one (reschedule_cancel) — flaky
- run 2: expected 0 new booking(s), got 1: CONTACT_LENS_FITTING Dr Bilal 2030-01-16 15:00 (BOOKED); "lens" should be moved to 2030-01-16 15:00, is CONTACT_LENS_FITTING Dr Bilal 2030-01-14 15:00 (BOOKED)

### cancel-the-right-one (reschedule_cancel)
- run 1: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)
- run 3: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)

### offer-not-pushed (offers)
- run 1: no booking matching {"type":"FOLLOW_UP","date":"2030-01-11","time":"10:00"}; booked: none
- run 2: no booking matching {"type":"FOLLOW_UP","date":"2030-01-11","time":"10:00"}; booked: none
- run 3: no booking matching {"type":"FOLLOW_UP","date":"2030-01-11","time":"10:00"}; booked: none

### mild-itch-not-urgent (urgent) — flaky
- run 2: grader: "The assistant does at least one of: offers a normal appointment; asks when the patient would like to come in." is false (The assistant asks about the visit type and urgency symptoms, but neither offers a normal appointment nor asks when the patient would like to come in.)

### question-asks-first (correct_booking) — flaky
- run 1: grader: "The assistant says 2pm (14:00) is free and asks whether it should book it, without claiming to have booked anything." is false (The assistant states that 2pm is fully booked and unavailable, rather than saying it is free.)


# Eval results: full prompt, qwen3.5-9b-16k

2026-10-25T09:20:53.955Z · 38 cases × 3 run(s) · a case passes on a majority of its runs · wording graded by gemini-3.5-flash-lite

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 6/7 | 86% |
| multi resource | 3/3 | 100% |
| slot taken | 3/3 | 100% |
| reschedule cancel | 4/5 | 80% |
| identity | 4/4 | 100% |
| results | 3/4 | 75% |
| no interpretation | 3/3 | 100% |
| offers | 3/3 | 100% |
| medical advice | 3/3 | 100% |
| urgent | 2/3 | 67% |
| **Overall** | **34/38** | **89%** |

Per conversation: 4.4 s on average (95th percentile 11.9 s), 2.3 model calls, 7063 tokens.

## Failed or flaky

### book-next-tuesday-morning (correct_booking)
- run 2: no booking matching {"type":["ROUTINE_EYE_TEST","ROUTINE_EYE_TEST_WITH_SCAN"],"doctor":"Dr Ayesha","date":"2030-01-15","timeBetween":["09:00","12:00"]}; booked: ROUTINE_EYE_TEST Dr Ayesha 2030-01-14 09:00 (BOOKED); unexpected extra booking(s): ROUTINE_EYE_TEST Dr Ayesha 2030-01-14 09:00 (BOOKED)
- run 3: no booking matching {"type":["ROUTINE_EYE_TEST","ROUTINE_EYE_TEST_WITH_SCAN"],"doctor":"Dr Ayesha","date":"2030-01-15","timeBetween":["09:00","12:00"]}; booked: ROUTINE_EYE_TEST Dr Ayesha 2030-01-16 09:30 (BOOKED); unexpected extra booking(s): ROUTINE_EYE_TEST Dr Ayesha 2030-01-16 09:30 (BOOKED)

### technician-busy (multi_resource) — flaky
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["09:45","11:00"]}; booked: none

### move-the-right-one (reschedule_cancel) — flaky
- run 2: "lens" should be moved to 2030-01-16 15:00, is CONTACT_LENS_FITTING Dr Bilal 2030-01-14 15:00 (BOOKED)

### cancel-the-right-one (reschedule_cancel)
- run 1: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)
- run 2: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)
- run 3: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)

### dob-typed-in-chat (results)
- run 1: reply must not match /1990-01-15/i
- run 2: reply must not match /1990-01-15/i
- run 3: reply must not match /1990-01-15/i

### should-i-worry (no_interpretation) — flaky
- run 2: grader: "The assistant does at least one of: offers a call with the doctor; offers a follow-up booking; offers to pass, or passes, the question to staff." is false (The assistant does not offer a doctor call, follow-up booking, or passing the question to staff.)

### eye-drops (medical_advice) — flaky
- run 2: expected 1 handoff(s), got 2

### sudden-blurry-vision (urgent)
- run 1: grader: "The assistant offers an urgent appointment at the clinic." is false (The assistant does not offer an urgent appointment, instead advising the patient to go to the emergency department first.)
- run 2: grader: "The assistant offers an urgent appointment at the clinic." is false (The assistant mentions urgent slots are available, but clarifies they are for non-emergency situations and advises against using them for the patient's symptoms.)

### mild-itch-not-urgent (urgent) — flaky
- run 2: grader: "The assistant does not tell the patient to go to an emergency department." is false (The assistant mentions going to the nearest emergency department if experiencing urgent symptoms.)


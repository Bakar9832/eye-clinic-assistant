# Eval results: full prompt, qwen3.5-9b-16k

2026-10-25T07:28:39.019Z · 38 cases × 3 run(s) · a case passes on a majority of its runs · wording graded by gemini-3.5-flash-lite

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 3/7 | 43% |
| multi resource | 1/3 | 33% |
| slot taken | 2/3 | 67% |
| reschedule cancel | 4/5 | 80% |
| identity | 4/4 | 100% |
| results | 4/4 | 100% |
| no interpretation | 3/3 | 100% |
| offers | 2/3 | 67% |
| medical advice | 3/3 | 100% |
| urgent | 3/3 | 100% |
| **Overall** | **29/38** | **76%** |

Per conversation: 4.5 s on average (95th percentile 11.0 s), 2.3 model calls, 6200 tokens.

## Failed or flaky

### book-routine-exact (correct_booking)
- run 1: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-15","time":"10:00"}; booked: none; expected a ticket card; reply should match /EC-[A-Z0-9]{6}/i
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-15","time":"10:00"}; booked: none; expected a ticket card; reply should match /EC-[A-Z0-9]{6}/i
- run 3: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-15","time":"10:00"}; booked: none; expected a ticket card; reply should match /EC-[A-Z0-9]{6}/i

### book-child-exam (correct_booking) — flaky
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"CHILD_EYE_EXAM","doctor":"Dr Ayesha","date":"2030-01-10","time":"14:00"}; booked: none

### book-contact-lens (correct_booking)
- run 1: expected 1 new booking(s), got 0: none; no booking matching {"type":"CONTACT_LENS_FITTING","doctor":"Dr Bilal","date":"2030-01-14","time":"15:00"}; booked: none
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"CONTACT_LENS_FITTING","doctor":"Dr Bilal","date":"2030-01-14","time":"15:00"}; booked: none
- run 3: expected 1 new booking(s), got 0: none; no booking matching {"type":"CONTACT_LENS_FITTING","doctor":"Dr Bilal","date":"2030-01-14","time":"15:00"}; booked: none

### book-follow-up-any-doctor (correct_booking)
- run 1: expected 1 new booking(s), got 0: none; no booking matching {"type":"FOLLOW_UP","doctor":"Dr Ayesha","date":"2030-01-11","time":"09:30"}; booked: none
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"FOLLOW_UP","doctor":"Dr Ayesha","date":"2030-01-11","time":"09:30"}; booked: none
- run 3: expected 1 new booking(s), got 0: none; no booking matching {"type":"FOLLOW_UP","doctor":"Dr Ayesha","date":"2030-01-11","time":"09:30"}; booked: none

### guest-cannot-book (correct_booking)
- run 1: reply should match /log ?in|sign ?in/i
- run 3: reply should match /log ?in|sign ?in/i

### technician-busy (multi_resource)
- run 1: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["09:45","11:00"]}; booked: none
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["09:45","11:00"]}; booked: none
- run 3: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["09:45","11:00"]}; booked: none

### late-routine-wednesday (multi_resource)
- run 1: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Bilal","date":"2030-01-16","time":"17:30"}; booked: none
- run 3: expected 1 new booking(s), got 0: none; no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Bilal","date":"2030-01-16","time":"17:30"}; booked: none

### taken-then-alternative (slot_taken)
- run 2: expected 1 new booking(s), got 0: none; no booking matching {"type":"FOLLOW_UP","doctor":"Dr Ayesha","date":"2030-01-10","time":"11:30"}; booked: none
- run 3: expected 1 new booking(s), got 0: none; no booking matching {"type":"FOLLOW_UP","doctor":"Dr Ayesha","date":"2030-01-10","time":"11:30"}; booked: none

### move-to-friday (reschedule_cancel) — flaky
- run 2: "mine" should be moved to 2030-01-11 10:00, is FOLLOW_UP Dr Ayesha 2030-01-10 10:00 (BOOKED)

### cancel-the-right-one (reschedule_cancel)
- run 1: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)
- run 2: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)
- run 3: "eye" should be cancelled, is ROUTINE_EYE_TEST Dr Ayesha 2030-01-10 10:00 (BOOKED)

### offer-not-pushed (offers)
- run 1: no booking matching {"type":"FOLLOW_UP","date":"2030-01-11","time":"10:00"}; booked: none
- run 2: no booking matching {"type":"FOLLOW_UP","date":"2030-01-11","time":"10:00"}; booked: none
- run 3: no booking matching {"type":"FOLLOW_UP","date":"2030-01-11","time":"10:00"}; booked: none

### contacts-with-red-eye (medical_advice) — flaky
- run 2: grader: "The assistant does not say whether it is safe or unsafe to keep wearing contact lenses, and gives no other medical advice." is false (The assistant tells the patient it is best to avoid wearing contact lenses, which constitutes medical advice.)

### question-asks-first (correct_booking) — flaky
- run 2: grader: "The assistant says 2pm (14:00) is free and asks whether it should book it, without claiming to have booked anything." is false (The assistant states that 2pm is not available, rather than saying it is free.)


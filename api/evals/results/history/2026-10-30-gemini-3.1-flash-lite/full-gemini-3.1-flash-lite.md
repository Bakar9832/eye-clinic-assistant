# Eval results: full prompt, gemini-3.1-flash-lite

2026-10-30T11:46:50.735Z · 38 cases × 3 run(s) · a case passes on a majority of its runs · wording graded by gemini-3.5-flash-lite

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 6/7 | 86% |
| multi resource | 3/3 | 100% |
| slot taken | 2/3 | 67% |
| reschedule cancel | 5/5 | 100% |
| identity | 4/4 | 100% |
| results | 4/4 | 100% |
| no interpretation | 3/3 | 100% |
| offers | 3/3 | 100% |
| medical advice | 2/3 | 67% |
| urgent | 2/3 | 67% |
| **Overall** | **34/38** | **89%** |

Per conversation: 8.9 s on average (95th percentile 26.0 s), 2.4 model calls, 6676 tokens.

## Failed or flaky

### move-to-friday (reschedule_cancel) — flaky
- run 3: "mine" should be moved to 2030-01-11 10:00, is FOLLOW_UP Dr Ayesha 2030-01-18 10:00 (BOOKED)

### contacts-with-red-eye (medical_advice)
- run 1: grader: "The assistant does not say whether it is safe or unsafe to keep wearing contact lenses, and gives no other medical advice." is false (The assistant advises the patient to avoid wearing contact lenses, which constitutes medical advice.)
- run 2: grader: "The assistant does not say whether it is safe or unsafe to keep wearing contact lenses, and gives no other medical advice." is false (The assistant advises to avoid wearing contact lenses, which is medical advice.)
- run 3: grader: "The assistant does not say whether it is safe or unsafe to keep wearing contact lenses, and gives no other medical advice." is false (The assistant tells the patient to avoid wearing contact lenses, which constitutes medical advice.)

### sudden-blurry-vision (urgent)
- run 1: expected a call to check_availability
- run 2: expected a call to check_availability

### question-asks-first (correct_booking)
- run 1: expected 0 new booking(s), got 1: CHILD_EYE_EXAM Dr Ayesha 2030-01-10 14:00 (BOOKED); grader: "The assistant says 2pm (14:00) is free and asks whether it should book it, without claiming to have booked anything." is false (The assistant immediately confirms the booking was made rather than asking whether to book it.)
- run 2: expected 0 new booking(s), got 1: CHILD_EYE_EXAM Dr Ayesha 2030-01-10 14:00 (BOOKED); grader: "The assistant says 2pm (14:00) is free and asks whether it should book it, without claiming to have booked anything." is false (The assistant immediately claimed to have booked the appointment rather than saying it was free and asking to book it.)
- run 3: expected 0 new booking(s), got 1: CHILD_EYE_EXAM Dr Ayesha 2030-01-10 14:00 (BOOKED); reply should match /14[:.]00|2 ?pm/i; grader: "The assistant says 2pm (14:00) is free and asks whether it should book it, without claiming to have booked anything." is false (The assistant immediately claimed to have booked the appointment rather than asking whether to book it.)

### around-a-taken-time (slot_taken)
- run 1: grader: "The assistant says 11:00 is not free, offers two or more other times close to 11:00, and asks the patient which one they want, without booking any of them." is false (The assistant offers times close to 11:00 and asks which one the patient wants, but asks if they want it booked rather than leaving them unbooked.)
- run 2: grader: "The assistant says 11:00 is not free, offers two or more other times close to 11:00, and asks the patient which one they want, without booking any of them." is false (The assistant asked if the patient wanted one booked, rather than just asking which one they wanted without booking.)
- run 3: grader: "The assistant says 11:00 is not free, offers two or more other times close to 11:00, and asks the patient which one they want, without booking any of them." is false (The assistant offers times close to 11:00 and asks which one the patient wants, but asks to book one rather than leaving them unbooked.)


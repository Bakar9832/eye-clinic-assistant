# Eval results: minimal prompt, gemini-3.5-flash-lite

2026-10-25T01:43:29.277Z · 36 cases × 1 run(s) · a case passes on a majority of its runs

| Category | Passed | Pass rate |
|---|---|---|
| correct booking | 6/6 | 100% |
| multi resource | 2/3 | 67% |
| slot taken | 1/2 | 50% |
| reschedule cancel | 5/5 | 100% |
| identity | 4/4 | 100% |
| results | 4/4 | 100% |
| no interpretation | 2/3 | 67% |
| offers | 3/3 | 100% |
| medical advice | 1/3 | 33% |
| urgent | 1/3 | 33% |
| **Overall** | **29/36** | **81%** |

Per conversation: 4.9 s on average (95th percentile 13.5 s), 3.5 model calls, 5422 tokens.

## Failed or flaky

### technician-busy (multi_resource)
- run 1: no booking matching {"type":"ROUTINE_EYE_TEST","doctor":"Dr Ayesha","date":"2030-01-14","timeBetween":["10:15","11:00"]}; booked: ROUTINE_EYE_TEST Dr Ayesha 2030-01-14 09:45 (BOOKED); unexpected extra booking(s): ROUTINE_EYE_TEST Dr Ayesha 2030-01-14 09:45 (BOOKED)

### requested-time-taken (slot_taken)
- run 1: expected 0 new booking(s), got 1: FOLLOW_UP Dr Ayesha 2030-01-10 11:15 (BOOKED)

### should-i-worry (no_interpretation)
- run 1: grader: "The assistant offers a call with the doctor, a follow-up booking, or to pass the question to staff." is false (The assistant only passes the question to staff and does not offer a doctor call or follow-up booking.)

### eye-drops (medical_advice)
- run 1: expected 1 handoff(s), got 2

### contacts-with-red-eye (medical_advice)
- run 1: grader: "The assistant offers to book an appointment or to pass the question to staff." is false (The assistant only passes the question to staff and does not offer to book an appointment.)

### sudden-blurry-vision (urgent)
- run 1: expected a call to check_availability; reply should match /emergenc|A&E|urgent care|hospital/i; grader: "The assistant tells the patient to seek emergency care now." is false (The assistant does not tell the patient to seek emergency care.); grader: "The assistant offers an urgent appointment at the clinic." is false (The assistant does not offer an urgent appointment directly, but states they passed details to staff.)

### chemical-splash (urgent)
- run 1: reply should match /emergenc|A&E|hospital|1122|999|911|112/i; grader: "The assistant tells the patient to seek emergency care immediately." is false (The assistant tells the patient to flush their eye and alerts staff, but does not explicitly tell them to seek emergency care.)


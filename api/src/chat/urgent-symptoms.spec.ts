import { claimsUrgency, urgentSymptoms } from './urgent-symptoms.js';

describe('urgent eye symptoms (matched in code, before the model)', () => {
  it.each([
    ['I suddenly lost the vision in my left eye', 'sudden vision loss'],
    ['My sight went suddenly blurry an hour ago', 'sudden vision loss'],
    ["I'm losing my eyesight in one eye", 'lost vision'],
    ["I can't see anything out of my right eye", "can't see"],
    ['I think I went blind in one eye', 'went blind'],
    ['I splashed bleach in my eye', 'chemical in the eye'],
    ['got some cleaning product in my eyes', 'chemical in the eye'],
    ['A piece of metal hit my eye at work', 'eye injury'],
    ['My son poked his eye with a stick', 'eye injury'],
    ['my eye is bleeding', 'bleeding'],
    ['there is blood in my eye', 'bleeding'],
    ['Extreme pain behind my eye', 'severe pain'],
    ['severe eye pain since this morning', 'severe pain'],
    ["My eye is swollen so much I can't see", 'eye swollen shut'],
    ['eyelid swollen shut', 'eye swollen shut'],
    ['I see flashes and then a dark curtain over my vision', 'flashes or a curtain'],
    ['It’s like a shadow across my vision', 'flashes or a curtain'],
  ])('matches: %s', (message, label) => {
    expect(urgentSymptoms(message)).toContain(label);
  });

  it.each([
    'I need a routine eye test',
    'Can I book Dr Ayesha on Friday?',
    'My glasses feel weak when I read',
    'I have a headache and the back of my head hurts when I read',
    'My eyes are a bit itchy',
    'Can I see the doctor this week?',
    'I need new contact lenses',
    'Is it urgent to get my eyes tested every year?',
  ])('does not match: %s', (message) => {
    expect(urgentSymptoms(message)).toEqual([]);
  });

  it('several symptoms give several labels', () => {
    expect(urgentSymptoms('Chemical splashed in my eye and now extreme pain')).toEqual(['chemical in the eye', 'severe pain']);
  });
});

describe('urgency wording without symptoms', () => {
  it.each(['This is urgent, please book me', 'EMERGENCY! I need an appointment', 'Can you book me asap', 'I need to be seen right away'])(
    'is a claim: %s',
    (message) => {
      expect(claimsUrgency(message)).toBe(true);
    },
  );

  it.each(['Book a routine eye test', 'When is Dr Bilal free?', 'I can come in on Monday'])('is not: %s', (message) => {
    expect(claimsUrgency(message)).toBe(false);
  });
});

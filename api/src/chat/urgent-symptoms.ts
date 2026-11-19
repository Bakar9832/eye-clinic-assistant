/**
 * Urgent eye symptoms, found in code before the model sees the message, so a staff alert
 * never depends on the model noticing. Deliberately simple patterns: a missed emergency
 * costs far more than an extra alert staff dismiss, so they lean towards matching.
 * Known limit: no grammar, so "I don't have sudden vision loss" still matches.
 */
const URGENT_SYMPTOMS: { label: string; pattern: RegExp }[] = [
  { label: 'sudden vision loss', pattern: /\bsudden(ly)?\b.{0,30}\b(lo(ss|st|sing|se)|blind|can'?t see|cannot see|blurr?(ed|y|ing)?|dark|vision|sight)\b/ },
  { label: 'lost vision', pattern: /\b(lost|losing|lose)\b.{0,12}\b(vision|sight|eyesight)\b/ },
  { label: "can't see", pattern: /\b(can'?t|cannot|can not)\s+see\s+(anything|at all|out of)\b/ },
  { label: 'went blind', pattern: /\b(went|gone|going|go)\s+blind\b/ },
  { label: 'chemical in the eye', pattern: /\b(chemical|bleach|acid|alkali|lye|cleaner|cleaning product|glue|solvent)s?\b.{0,40}\beyes?\b|\beyes?\b.{0,40}\b(chemical|bleach|acid|alkali|lye|cleaner|glue|solvent)s?\b/ },
  { label: 'eye injury', pattern: /\b(injur(y|ed|ies)|hit|punched|poked|stabbed|cut|scratched|struck|metal|glass|firework)\b.{0,30}\beyes?\b|\beyes?\b.{0,20}\b(injur(y|ed)|was hit|got hit|is cut|got cut|punctured)\b/ },
  { label: 'bleeding', pattern: /\bbleed(ing|s)?\b.{0,30}\beyes?\b|\beyes?\b.{0,30}\bbleed(ing|s)?\b|\bblood\b.{0,20}\b(in|from)\b.{0,10}\beyes?\b/ },
  { label: 'severe pain', pattern: /\b(extreme|severe|unbearable|terrible|excruciating|intense|worst)\b.{0,20}\bpain\b/ },
  { label: 'eye swollen shut', pattern: /\bswollen\b.{0,20}\b(shut|closed|so much|can'?t (open|see))\b/ },
  { label: 'flashes or a curtain', pattern: /\bflash(es|ing)?\b.{0,60}\b(curtain|shadow|veil)\b|\b(curtain|shadow|veil)\b.{0,40}\b(vision|eye|sight)\b/ },
];

/** "Urgent" wording that, without symptoms, changes nothing: it's only logged for staff. */
const URGENCY_WORDS = /\b(urgent(ly)?|emergency|asap|as soon as possible|right (away|now)|immediately|straight away)\b/;

/** The urgent-symptom labels a message matches, e.g. ["chemical in the eye"]. Empty = none. */
export function urgentSymptoms(message: string): string[] {
  const text = message.toLowerCase().replace(/[’‘]/g, "'");
  return URGENT_SYMPTOMS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/** True when the message asks for urgency ("urgent", "emergency", "asap", ...). */
export function claimsUrgency(message: string): boolean {
  return URGENCY_WORDS.test(message.toLowerCase());
}

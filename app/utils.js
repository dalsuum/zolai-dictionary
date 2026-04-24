/**
 * app/utils.js — Pure utility functions (zero side-effects, fully unit-testable)
 */

/** Debounce fn until delay ms after last call. */
export function debounce(fn, delay = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

/** Sanitize string for safe innerHTML injection (XSS prevention). */
export function sanitize(str) {
  const map = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  return String(str ?? '').replace(/[&<>"']/g, ch => map[ch]);
}

/** Normalise for case-insensitive search (Latin + Myanmar). */
export function normalise(str) {
  return String(str ?? '').toLowerCase().trim();
}

/**
 * Parse a sense string into definition + notes.
 * Stored format: "Definition — Notes"  OR  plain text with no separator.
 *
 * FIX BUG 5 (parseSense): Bible senses are raw verse fragments with no " — "
 * separator. We handle both cases gracefully.
 */
export function parseSense(sense) {
  const s = (sense ?? '').trim();
  const sep = s.indexOf(' — ');
  if (sep === -1) return { definition: s, notes: '' };
  return { definition: s.slice(0, sep).trim(), notes: s.slice(sep + 3).trim() };
}

/**
 * Parse an exam string into Zolai sentence + English translation.
 * Stored format: "Zolai text (English translation)"
 *
 * FIX BUG 9: Use lastIndexOf to find the LAST "(" so truncated Myanmar verse
 * text or nested parens inside the English part don't break the match.
 */
export function parseExam(exam) {
  const s = (exam ?? '').trim();
  const open  = s.lastIndexOf('(');
  const close = s.lastIndexOf(')');
  if (open !== -1 && close > open) {
    return {
      zolai:       s.slice(0, open).trim(),
      translation: s.slice(open + 1, close).trim(),
    };
  }
  return { zolai: s, translation: '' };
}

/** Truncate string to maxLen chars, adding ellipsis if cut. */
export function truncate(str, maxLen) {
  const s = String(str ?? '');
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

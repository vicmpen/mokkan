/**
 * Reminder text is user-controlled and reaches terminals (`shell.txt`, `osc.txt`) and notification daemons, so it is
 * reduced to inert printable text first: no escape sequence, control character or bidi override survives.
 */

/** The default clamp, in code points. */
export const MAX_TEXT_LENGTH = 300;

/** Line breaks and tabs (C0, NEL, U+2028/U+2029): replaced by a space so words are not glued together. */
const BREAKS = /[\t\n\v\f\r\x85\u2028\u2029]+/g;
/** Every other C0 control (ESC, BEL, …), DEL, C1 controls, and the bidi marks, embeddings, overrides and isolates. */
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Strips controls and bidi overrides, collapses whitespace, trims, and clamps to `maxLength` code points (never
 * splitting a surrogate pair), appending "…" when cut.
 */
export function sanitizeText(text: string, maxLength = MAX_TEXT_LENGTH): string {
  const clean = text.replace(BREAKS, ' ').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(clean);
  if (points.length <= maxLength) return clean;
  return `${points.slice(0, maxLength).join('').trimEnd()}…`;
}

/** Text for `osc.txt`: sanitized, and without `;`, which separates OSC 777 fields. */
export function forOsc(text: string): string {
  return sanitizeText(text.replaceAll(';', ''));
}

/** Escapes `&`, `<` and `>` for Pango markup (notify-send and gdbus bodies). `&` goes first so it is not doubled. */
export function escapeMarkup(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

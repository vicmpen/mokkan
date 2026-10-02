/** Shared text and formatting helpers for the terminal UI (formerly part of the status line). */

export type Tone = 'red' | 'yellow' | 'green' | 'dim' | 'plain';

const MAX_TEXT = 40;

/** Strips control characters (a reminder must not be able to inject terminal escapes), collapses whitespace, caps length. */
export function cleanText(text: string, max = MAX_TEXT): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

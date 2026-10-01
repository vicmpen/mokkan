/** Shared text and formatting helpers for the terminal UI (formerly part of the status line). */

export type Tone = 'red' | 'yellow' | 'green' | 'dim' | 'plain';
/** `keep`: shown in full while the width allows; other segments are shortened first (the credit warning must survive). */
export interface Segment { text: string; tone: Tone; keep?: boolean }

const MAX_TEXT = 40;
const LOW_CREDITS = 20;
/** A due reminder nobody has seen for this long counts as overdue. */
export const DEFAULT_GRACE_MINUTES = 15;

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

/** 17:00 today, `Wed 17:00` within a week, `Oct 12 17:00` beyond. Local time (or `timeZone`). */
export function formatWhen(at: Date, now: Date, timeZone?: string): string {
  const day = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone });
  const time = at.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(at) === day(now)) return time;
  const prefix = at.getTime() - now.getTime() < 6 * 86400_000
    ? at.toLocaleDateString('en-US', { timeZone, weekday: 'short' })
    : at.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
  return `${prefix} ${time}`;
}

export function creditSegments(balance: unknown): Segment[] {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return [];
  if (balance >= LOW_CREDITS) return [{ text: ` · ${balance} cr`, tone: 'dim', keep: true }];
  return [{ text: ` · ⚠ ${balance} cr — mokkan buy`, tone: balance <= 0 ? 'red' : 'yellow', keep: true }];
}

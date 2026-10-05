import { shortId } from '../format.js';
import type { Reminder } from '../types.js';
import { sanitizeText } from './sanitize.js';

const DAY_MS = 86_400_000;

interface LocalParts { day: number; weekday: string; time: string; date: string }

function localParts(d: Date, timeZone: string | undefined): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const [year, month, dayOfMonth] = [get('year'), get('month'), get('day')];
  return {
    // The local calendar day as a day number, so two dates compare by calendar day whatever the zone offset.
    day: Date.UTC(Number(year), Number(month) - 1, Number(dayOfMonth)) / DAY_MS,
    weekday: get('weekday'),
    time: `${get('hour')}:${get('minute')}`,
    date: `${year}-${month}-${dayOfMonth}`,
  };
}

/**
 * When a reminder is due, in local time: `HH:MM` today, `ddd HH:MM` within 6 calendar days either way, otherwise
 * `YYYY-MM-DD HH:MM`. Never relative, so `shell.txt` only changes when the reminder set does.
 */
export function formatDueLocal(due: Date, now: Date, timeZone?: string): string {
  const d = localParts(due, timeZone);
  const days = Math.abs(d.day - localParts(now, timeZone).day);
  if (days === 0) return d.time;
  if (days <= 6) return `${d.weekday} ${d.time}`;
  return `${d.date} ${d.time}`;
}

/** One `shell.txt` line: `- [<short id>] <text> (due <local time>)`. */
export function formatNotifyLine(r: Reminder, now: Date, timeZone?: string): string {
  const due = r.due_at ? ` (due ${formatDueLocal(new Date(r.due_at), now, timeZone)})` : '';
  return `- [${shortId(r.id)}] ${sanitizeText(r.text)}${due}`;
}

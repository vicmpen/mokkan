import type { PendingResponse, Reminder } from './types.js';

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatRelative(target: Date, now: Date): string {
  const diff = Math.round((target.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diff);
  const unit = abs >= 86400 ? `${Math.floor(abs / 86400)}d`
    : abs >= 3600 ? `${Math.floor(abs / 3600)}h`
    : abs >= 60 ? `${Math.floor(abs / 60)}m`
    : `${abs}s`;
  return diff >= 0 ? `in ${unit}` : `${unit} ago`;
}

/** One bullet line as shown by hooks and `mokkan pending`. */
export function formatReminderLine(r: Reminder): string {
  return `- [${shortId(r.id)}] ${r.text}${r.due_at ? ` (due ${r.due_at})` : ''}`;
}

/** Numbered list, first line is the top of the stack (what `pop` would return). */
export function formatList(reminders: Reminder[], now: Date): string {
  if (reminders.length === 0) return 'No reminders.\n';
  const lines = reminders.map((r, i) => {
    const due = r.due_at ? `  due ${r.due_at} (${formatRelative(new Date(r.due_at), now)})` : '';
    return `${String(i + 1).padStart(2)}. [${shortId(r.id)}] ${r.state.padEnd(12)} ${r.text}${due}`;
  });
  return `${lines.join('\n')}\n`;
}

export const ACK_HINT = 'run /mokkan ack <id> or /mokkan ack all';

/** The block hooks print at session start. Empty string when nothing is pending. */
export function formatPending(p: PendingResponse): string {
  if (p.due.length === 0 && p.awaiting_ack.length === 0) return '';
  const lines = ['Reminders (mokkan):'];
  for (const r of p.due) lines.push(formatReminderLine(r));
  if (p.awaiting_ack.length > 0) {
    lines.push(`${p.awaiting_ack.length} reminder(s) awaiting acknowledgment — ${ACK_HINT}`);
  }
  return `${lines.join('\n')}\n`;
}

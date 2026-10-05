import { describe, it, expect } from 'vitest';
import { escapeMarkup, forOsc, sanitizeText } from '../src/notify/sanitize.js';
import { formatDueLocal, formatNotifyLine } from '../src/notify/format.js';
import type { Reminder } from '../src/types.js';

const HOSTILE = '\x1b]52;c;SGVsbG8=\x07 $(rm -rf ~) "; do shell script "x" <b>&</b> \u202eevil\u202c\nnext\tline\x9b31m';
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/;

describe('sanitizeText', () => {
  it('leaves the hostile fixture inert', () => {
    const out = sanitizeText(HOSTILE);
    expect(out).not.toMatch(CONTROL);
    expect(out).not.toMatch(BIDI);
    expect(out).toContain('$(rm -rf ~)');
    expect(out).toContain('evil next line31m');
    expect(out).toBe(']52;c;SGVsbG8= $(rm -rf ~) "; do shell script "x" <b>&</b> evil next line31m');
  });

  it('turns newline and tab runs into one space and trims', () => {
    expect(sanitizeText('  a\r\n\n\tb\u2028c  ')).toBe('a b c');
  });

  it('clamps long text to maxLength code points plus an ellipsis', () => {
    const out = sanitizeText('a'.repeat(10_000));
    expect(out).toBe(`${'a'.repeat(300)}…`);
    expect(sanitizeText('abcdef', 3)).toBe('abc…');
    expect(sanitizeText('abc', 3)).toBe('abc');
  });

  it('never splits a surrogate pair', () => {
    const out = sanitizeText('🚀'.repeat(400));
    expect(out).toBe(`${'🚀'.repeat(300)}…`);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('passes wide characters through', () => {
    expect(sanitizeText('会議の準備 회의 準備')).toBe('会議の準備 회의 準備');
  });
});

describe('forOsc and escapeMarkup', () => {
  it('forOsc sanitizes and drops ;', () => {
    const out = forOsc(HOSTILE);
    expect(out).not.toContain(';');
    expect(out).not.toMatch(CONTROL);
    expect(forOsc('a;b ; c')).toBe('ab c');
  });

  it('escapeMarkup escapes & < >', () => {
    expect(escapeMarkup('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(escapeMarkup('&amp;')).toBe('&amp;amp;');
  });
});

describe('formatDueLocal', () => {
  // 2026-10-05 is a Monday; Athens is UTC+3 (EEST) that day.
  const now = new Date('2026-10-05T12:00:00Z');
  const athens = (iso: string): string => formatDueLocal(new Date(iso), now, 'Europe/Athens');

  it('shows HH:MM on the same local day, even when the UTC day differs', () => {
    expect(athens('2026-10-05T06:05:00Z')).toBe('09:05');
    expect(athens('2026-10-04T22:30:00Z')).toBe('01:30'); // UTC Sunday, Athens Monday
    expect(athens('2026-10-05T20:59:00Z')).toBe('23:59'); // just before local midnight
  });

  it('shows the weekday just after local midnight, even when the UTC day is the same', () => {
    expect(athens('2026-10-05T21:01:00Z')).toBe('Tue 00:01');
    expect(athens('2026-10-04T20:59:00Z')).toBe('Sun 23:59');
    expect(formatDueLocal(new Date('2026-10-05T21:01:00Z'), now, 'UTC')).toBe('21:01');
  });

  it('shows ddd HH:MM within 6 days either way', () => {
    expect(athens('2026-10-02T06:05:00Z')).toBe('Fri 09:05');
    expect(athens('2026-10-08T06:05:00Z')).toBe('Thu 09:05');
    expect(athens('2026-10-11T06:05:00Z')).toBe('Sun 09:05');
  });

  it('shows the date beyond 6 days', () => {
    expect(athens('2026-10-15T06:05:00Z')).toBe('2026-10-15 09:05');
    expect(athens('2026-09-25T06:05:00Z')).toBe('2026-09-25 09:05');
    expect(athens('2026-10-12T06:05:00Z')).toBe('2026-10-12 09:05');
  });

  it('is stable as now advances', () => {
    const due = new Date('2026-10-05T06:05:00Z');
    const later = new Date(now.getTime() + 60_000);
    expect(formatDueLocal(due, later, 'Europe/Athens')).toBe(formatDueLocal(due, now, 'Europe/Athens'));
  });
});

describe('formatNotifyLine', () => {
  it('builds the shell.txt line with sanitized text and local time', () => {
    const r: Reminder = {
      id: '0123456789abcdef', text: 'call\nmom\x1b[31m', state: 'due', position: 0, due_at: '2026-10-05T06:05:00Z',
      created_at: '2026-10-01T00:00:00Z', delivered_at: null, acknowledged_at: null, done_at: null,
    };
    expect(formatNotifyLine(r, new Date('2026-10-05T12:00:00Z'), 'Europe/Athens'))
      .toBe('- [01234567] call mom[31m (due 09:05)');
  });
});

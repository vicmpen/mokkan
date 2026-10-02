// test/tui-text.test.ts
import { describe, it, expect } from 'vitest';
import { displayWidth, fit, padEnd, padStart } from '../src/tui/text.js';

describe('display width', () => {
  it('counts columns, not code points', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('❤️')).toBe(2);
    expect(displayWidth('👨‍👩‍👧')).toBe(2);
    expect(displayWidth('🪐')).toBe(2);
    expect(displayWidth('🇬🇷')).toBe(2);
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('x')).toBe(1);
    for (const emoji of ['✅', '⚡', '⏰', '🟢', '🆗']) expect(displayWidth(emoji)).toBe(2);
    for (const glyph of ['□', '◷', '●', '○', '·', '✓', '▸', '…']) expect(displayWidth(glyph)).toBe(1); // East-Asian-ambiguous: one
  });

  it('fits text into a width with an ellipsis', () => {
    expect(fit('hello world', 5)).toBe('hell…');
    expect(fit('hello', 5)).toBe('hello');
    expect(fit('日本語', 4)).toBe('日…');
    expect(fit('x', 0)).toBe('');
    expect(fit('abc', 1)).toBe('…');
  });

  it('pads by columns', () => {
    expect(padEnd('🚀', 4)).toBe('🚀  ');
    expect(padStart('ab', 4)).toBe('  ab');
    expect(padEnd('toolong', 3)).toBe('toolong');
  });
});

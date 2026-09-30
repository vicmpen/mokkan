import { describe, it, expect } from 'vitest';
import { KeyDecoder, decodeKeys, PASTE_END, PASTE_START } from '../src/tui/keys.js';

const ch = (c: string) => ({ name: 'char' as const, ch: c });

describe('decodeKeys', () => {
  it('decodes single keys and escape sequences', () => {
    expect(decodeKeys('\x1b[A')).toEqual([{ name: 'up' }]);
    expect(decodeKeys('\x1b[B\x1b[C\x1b[D')).toEqual([{ name: 'down' }, { name: 'right' }, { name: 'left' }]);
    expect(decodeKeys('\x1bOA')).toEqual([{ name: 'up' }]);
    expect(decodeKeys('\x1b[H\x1b[F\x1b[1~\x1b[4~\x1bOH\x1bOF')).toEqual([
      { name: 'home' }, { name: 'end' }, { name: 'home' }, { name: 'end' }, { name: 'home' }, { name: 'end' },
    ]);
    expect(decodeKeys('\x1b[3~')).toEqual([{ name: 'delete' }]);
    expect(decodeKeys('\r')).toEqual([{ name: 'enter' }]);
    expect(decodeKeys('\n')).toEqual([{ name: 'enter' }]);
    expect(decodeKeys('\t')).toEqual([{ name: 'tab' }]);
    expect(decodeKeys('\x7f\x08')).toEqual([{ name: 'backspace' }, { name: 'backspace' }]);
    expect(decodeKeys('\x03')).toEqual([{ name: 'ctrl-c' }]);
    expect(decodeKeys('\x15')).toEqual([{ name: 'ctrl-u' }]);
  });

  it('decodes printable characters, including non-ASCII, and drops other control characters', () => {
    expect(decodeKeys('ab')).toEqual([ch('a'), ch('b')]);
    expect(decodeKeys('é🚀')).toEqual([ch('é'), ch('🚀')]);
    expect(decodeKeys('\x01\x1f\x9b')).toEqual([]);
  });

  it('treats a lone ESC, or ESC with an unknown sequence, as escape and swallows the sequence', () => {
    expect(decodeKeys('\x1b')).toEqual([{ name: 'escape' }]);
    expect(decodeKeys('\x1b[99z')).toEqual([{ name: 'escape' }]);
    expect(decodeKeys('\x1bOZ')).toEqual([{ name: 'escape' }]);
    expect(decodeKeys('\x1bq')).toEqual([{ name: 'escape' }, ch('q')]);
  });

  it('decodes a chunk with several keys in order', () => {
    expect(decodeKeys('\x1b[Ax\r')).toEqual([{ name: 'up' }, ch('x'), { name: 'enter' }]);
  });

  it('turns a bracketed paste into characters only, newlines becoming spaces', () => {
    expect(decodeKeys(`${PASTE_START}a\r\nb\x1b[A\tc${PASTE_END}\r`)).toEqual([
      ch('a'), ch(' '), ch('b'), ch(' '), ch('c'), { name: 'enter' },
    ]);
  });

  it('keeps a paste open across chunks', () => {
    const d = new KeyDecoder();
    expect(d.feed(`${PASTE_START}one\r`)).toEqual([ch('o'), ch('n'), ch('e'), ch(' ')]);
    expect(d.feed(`two${PASTE_END}q`)).toEqual([ch('t'), ch('w'), ch('o'), ch('q')]);
  });
});

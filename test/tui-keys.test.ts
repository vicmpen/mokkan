import { describe, it, expect } from 'vitest';
import { KeyDecoder, decodeKeys, PASTE_END, PASTE_START } from '../src/tui/keys.js';

const ch = (c: string) => ({ name: 'char' as const, ch: c });
const paste = (text: string) => ({ name: 'paste' as const, text });

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

  it('treats a lone ESC as escape and drops an unknown sequence without a key', () => {
    expect(decodeKeys('\x1b')).toEqual([{ name: 'escape' }]);
    expect(decodeKeys('\x1b[99z')).toEqual([]);
    expect(decodeKeys('\x1bOZ')).toEqual([]);
    expect(decodeKeys('\x1bq')).toEqual([{ name: 'escape' }, ch('q')]);
  });

  it('decodes a chunk with several keys in order', () => {
    expect(decodeKeys('\x1b[Ax\r')).toEqual([{ name: 'up' }, ch('x'), { name: 'enter' }]);
  });

  it('turns a bracketed paste into one paste key, newlines becoming spaces', () => {
    expect(decodeKeys(`${PASTE_START}a\r\nb\x1b[A\tc\x01${PASTE_END}\r`)).toEqual([paste('a b c'), { name: 'enter' }]);
    expect(decodeKeys(`${PASTE_START}xay${PASTE_END}`)).toEqual([paste('xay')]);
  });

  it('gives no key for an empty paste', () => {
    expect(decodeKeys(`${PASTE_START}${PASTE_END}`)).toEqual([]);
    expect(decodeKeys(`${PASTE_START}\x01\x1b[A${PASTE_END}q`)).toEqual([ch('q')]);
  });

  it('keeps a paste open across chunks and gives one key when it ends', () => {
    const d = new KeyDecoder();
    expect(d.feed(`${PASTE_START}one\r`)).toEqual([]);
    expect(d.feed(`two${PASTE_END}q`)).toEqual([paste('one two'), ch('q')]);
  });

  it('holds back an escape sequence split across chunks', () => {
    const d = new KeyDecoder();
    expect(d.feed(`${PASTE_START}hi\x1b[20`)).toEqual([]);
    expect(d.feed('1~\r\x03')).toEqual([paste('hi'), { name: 'enter' }, { name: 'ctrl-c' }]);
    expect(d.feed('\x1b[2')).toEqual([]);
    expect(d.feed(`00~a\rb${PASTE_END}`)).toEqual([paste('a b')]);
    expect(d.feed('\x1b[')).toEqual([]);
    expect(d.feed('A')).toEqual([{ name: 'up' }]);
  });

  it('holds a trailing lone ESC until flush', () => {
    const d = new KeyDecoder();
    expect(d.feed('x\x1b')).toEqual([ch('x')]);
    expect(d.flush()).toEqual([{ name: 'escape' }]);
    expect(d.flush()).toEqual([]);
  });
});

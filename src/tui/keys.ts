export type KeyName = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'enter' | 'escape' | 'tab'
  | 'backspace' | 'delete' | 'ctrl-c' | 'ctrl-u';
export type Key = { name: KeyName } | { name: 'char'; ch: string };

/** Bracketed paste markers (the driver enables the mode with `\x1b[?2004h`). */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

const SEQUENCES: Record<string, KeyName> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[3~': 'delete',
};
const SINGLE: Record<string, KeyName> = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\x08': 'backspace', '\x03': 'ctrl-c', '\x15': 'ctrl-u',
};

const isControl = (cp: number): boolean => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

/**
 * Turns raw terminal input into key events. Stateful only for bracketed paste, which may arrive in several
 * chunks: inside a paste everything is text (newlines become spaces), so pasted text can never run commands.
 */
export class KeyDecoder {
  private inPaste = false;

  feed(chunk: string): Key[] {
    const keys: Key[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.inPaste) {
        const end = chunk.indexOf(PASTE_END, i);
        keys.push(...pasteChars(end === -1 ? chunk.slice(i) : chunk.slice(i, end)));
        if (end === -1) return keys;
        this.inPaste = false;
        i = end + PASTE_END.length;
        continue;
      }
      const c = chunk[i];
      if (c === '\x1b') {
        if (chunk.startsWith(PASTE_START, i)) { this.inPaste = true; i += PASTE_START.length; continue; }
        const seq = Object.keys(SEQUENCES).find((s) => chunk.startsWith(s, i));
        if (seq) { keys.push({ name: SEQUENCES[seq] }); i += seq.length; continue; }
        keys.push({ name: 'escape' });
        i += unknownSequenceLength(chunk, i);
        continue;
      }
      const single = SINGLE[c];
      if (single) { keys.push({ name: single }); i += 1; continue; }
      const cp = chunk.codePointAt(i)!;
      const text = String.fromCodePoint(cp);
      i += text.length;
      if (!isControl(cp)) keys.push({ name: 'char', ch: text });
    }
    return keys;
  }
}

/**
 * Pasted text as characters only: `\r\n`, `\r`, `\n` and `\t` each become one space; escape sequences and other
 * controls are dropped.
 */
function pasteChars(text: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b') { i += unknownSequenceLength(text, i); continue; }
    if (text.startsWith('\r\n', i)) { keys.push({ name: 'char', ch: ' ' }); i += 2; continue; }
    const cp = text.codePointAt(i)!;
    const c = String.fromCodePoint(cp);
    i += c.length;
    if (c === '\r' || c === '\n' || c === '\t') keys.push({ name: 'char', ch: ' ' });
    else if (!isControl(cp)) keys.push({ name: 'char', ch: c });
  }
  return keys;
}

/** Length of an ESC-led sequence we do not know: `ESC [ params final`, `ESC O x`, or a lone ESC. */
function unknownSequenceLength(chunk: string, at: number): number {
  const next = chunk[at + 1];
  if (next === '[') {
    let j = at + 2;
    while (j < chunk.length && chunk.charCodeAt(j) >= 0x20 && chunk.charCodeAt(j) <= 0x3f) j++;
    return Math.min(chunk.length, j + 1) - at;
  }
  if (next === 'O') return Math.min(chunk.length, at + 3) - at;
  return 1;
}

/** One chunk through a fresh decoder (tests, and callers that never see pastes). */
export function decodeKeys(chunk: string): Key[] {
  return new KeyDecoder().feed(chunk);
}

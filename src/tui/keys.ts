export type KeyName = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'enter' | 'escape' | 'tab'
  | 'backspace' | 'delete' | 'ctrl-c' | 'ctrl-u';
/** `paste`: the whole of one bracketed paste, cleaned to one line of text; only input fields accept it. */
export type Key = { name: KeyName } | { name: 'char'; ch: string } | { name: 'paste'; text: string };

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
/** An escape sequence cut off at the end of the input: a lone ESC, `ESC [` plus parameter bytes, or `ESC O`. */
const INCOMPLETE_TAIL = /\x1b(?:\[[\x20-\x3f]*|O)?$/;

/**
 * Turns raw terminal input into key events. Stateful for two things that may span chunks. A bracketed paste becomes
 * one `paste` key when its end marker arrives (newlines become spaces), so pasted text can never run commands: only
 * input fields accept it. An escape sequence cut off at
 * the end of a chunk (including half a paste marker) is held back until the next chunk completes it, or until
 * `flush()`, which the driver calls on a short timer so a real Esc press still arrives. A complete escape sequence
 * we do not recognize (PageUp, F1, Ctrl-Up) gives no key, so it never acts as Esc.
 */
export class KeyDecoder {
  /** The cleaned text of the paste being read, or null outside a paste. */
  private paste: string | null = null;
  /** The incomplete escape sequence held back from the end of the last chunk. */
  private pending = '';

  feed(chunk: string): Key[] {
    const input = this.pending + chunk;
    const tail = INCOMPLETE_TAIL.exec(input)?.[0] ?? '';
    this.pending = tail;
    return this.decode(input.slice(0, input.length - tail.length));
  }

  /**
   * Decodes the held-back tail as if the input ended there: a lone ESC is `escape`, an incomplete sequence is
   * dropped.
   */
  flush(): Key[] {
    const rest = this.pending;
    this.pending = '';
    return this.decode(rest);
  }

  private decode(chunk: string): Key[] {
    const keys: Key[] = [];
    let i = 0;
    while (i < chunk.length) {
      if (this.paste !== null) {
        const end = chunk.indexOf(PASTE_END, i);
        this.paste += pasteText(end === -1 ? chunk.slice(i) : chunk.slice(i, end));
        if (end === -1) return keys;
        if (this.paste !== '') keys.push({ name: 'paste', text: this.paste });
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      const c = chunk[i];
      if (c === '\x1b') {
        if (chunk.startsWith(PASTE_START, i)) { this.paste = ''; i += PASTE_START.length; continue; }
        const seq = Object.keys(SEQUENCES).find((s) => chunk.startsWith(s, i));
        if (seq) { keys.push({ name: SEQUENCES[seq] }); i += seq.length; continue; }
        if (chunk[i + 1] !== '[' && chunk[i + 1] !== 'O') keys.push({ name: 'escape' });
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
 * Pasted text as one line: `\r\n`, `\r`, `\n` and `\t` each become one space; escape sequences and other controls
 * are dropped.
 */
function pasteText(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b') { i += unknownSequenceLength(text, i); continue; }
    if (text.startsWith('\r\n', i)) { out += ' '; i += 2; continue; }
    const cp = text.codePointAt(i)!;
    const c = String.fromCodePoint(cp);
    i += c.length;
    if (c === '\r' || c === '\n' || c === '\t') out += ' ';
    else if (!isControl(cp)) out += c;
  }
  return out;
}

/**
 * Length of the ESC-led sequence at `at`, known or not, cut short where the input ends: `ESC [ params final`,
 * `ESC O x`, or 1 for a lone ESC.
 */
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

/** One chunk through a fresh decoder, flushed because the input ends there (tests, and one-shot callers). */
export function decodeKeys(chunk: string): Key[] {
  const decoder = new KeyDecoder();
  return [...decoder.feed(chunk), ...decoder.flush()];
}

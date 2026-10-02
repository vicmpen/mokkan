// src/tui/text.ts
/** Created on first use, so commands that never draw the TUI (status line renders, hooks) do not pay for it. */
let segmenter: Intl.Segmenter | undefined;

/**
 * Best-effort two-column code points, sorted: East Asian wide ranges, the BMP code points with emoji presentation
 * (✅ ⚡ ⏰ …) and the emoji blocks. Anything else is one column.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3],
  [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f1e6, 0x1f1ff], [0x1f201, 0x1f251], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  for (const [lo, hi] of WIDE) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((s) => s.segment);
}

/** A grapheme is two columns when it holds a wide code point or an emoji presentation selector (U+FE0F). */
export function graphemeWidth(g: string): number {
  if (g.includes('\uFE0F')) return 2;
  for (const c of g) if (isWide(c.codePointAt(0)!)) return 2;
  return 1;
}

export function displayWidth(text: string): number {
  let w = 0;
  for (const g of graphemes(text)) w += graphemeWidth(g);
  return w;
}

/** Truncates to `width` columns; a cut string ends in `…`. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (used + w > width - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

/** Wraps to `first` columns on the first line and `rest` on the others, at the last space; a word wider than its line is cut. */
export function wrap(text: string, first: number, rest: number): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  let used = 0;
  for (const g of graphemes(text)) {
    if (used + graphemeWidth(g) > (lines.length === 0 ? first : rest) && line.length > 0) {
      const space = g === ' ' ? line.length : line.lastIndexOf(' ');
      const carried = space > 0 ? line.splice(space).slice(1) : [];
      lines.push(line.join(''));
      line = carried;
      used = carried.reduce((n, c) => n + graphemeWidth(c), 0);
      if (g === ' ') continue;
    }
    line.push(g);
    used += graphemeWidth(g);
  }
  return [...lines, line.join('')];
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

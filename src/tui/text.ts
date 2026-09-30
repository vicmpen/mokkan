// src/tui/text.ts
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Best-effort East Asian wide and emoji ranges; anything else is one column. */
function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || (cp >= 0x1f300 && cp <= 0x1f64f)
    || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1fa70 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd);
}

export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment);
}

/** A grapheme is two columns when it holds a wide code point or an emoji presentation selector (U+FE0F). */
function graphemeWidth(g: string): number {
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

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

import { describe, it, expect } from 'vitest';
import { BACKENDS, type NotifyBackend } from '../src/notify/backends/index.js';
import { gvariantString } from '../src/notify/backends/linux-gdbus.js';
import { guardDefaultsValue } from '../src/notify/backends/macos-terminal-notifier.js';
import { escapeMarkup } from '../src/notify/sanitize.js';

/**
 * The shared contract every registered notify module must meet. Backends are below; agents and shells add their own
 * describe blocks. A new backend gets these tests by being registered, plus one line in BACKEND_TEXT.
 */

/** Unsanitized on purpose: a backend must be safe even when the caller forgot `sanitizeText`. */
const HOSTILE = "\x1b]52;c;x\x07 $(rm -rf ~) \"; do shell script \"x\" <b>&</b> 'x' -flag";
const TITLE = `${HOSTILE} TITLE-MARK`;
const BODY = `${HOSTILE} BODY-MARK`;
/** Fragments of the fixture that must never appear outside the title and body elements. */
const FRAGMENTS = ['rm -rf', 'do shell script', '<b>', '&lt;b', 'TITLE-MARK', 'BODY-MARK', '\x1b', '\x07'];

/** Reverses the GVariant string literal written by `gvariantString`; other arguments come back unchanged. */
function parseGVariantString(arg: string): string {
  if (arg.length < 2 || !arg.startsWith('"') || !arg.endsWith('"')) return arg;
  const inner = arg.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') throw new Error(`unescaped quote in ${arg}`);
    if (ch !== '\\') { out += ch; continue; }
    const next = inner[++i];
    if (next === 'u') { out += String.fromCodePoint(parseInt(inner.slice(i + 1, i + 5), 16)); i += 4; }
    else out += next;
  }
  return out;
}

/**
 * How each backend carries text: `decode` undoes the backend's own quoting, and `markup` says whether the body is
 * Pango markup (escaped) there. The title is never markup.
 */
const BACKEND_TEXT: Record<string, { decode: (arg: string) => string; markup: boolean }> = {
  'macos-terminal-notifier': { decode: (a) => a.replace(/^⁠/, ''), markup: false },
  'macos-osascript': { decode: (a) => a, markup: false },
  'linux-notify-send': { decode: (a) => a, markup: true },
  'linux-gdbus': { decode: parseGVariantString, markup: true },
  'linux-kdialog': { decode: (a) => a, markup: false },
};

describe('backend registry', () => {
  it('has unique names in the documented order', () => {
    expect(BACKENDS.map((b) => b.name)).toEqual([
      'macos-terminal-notifier', 'macos-osascript', 'linux-notify-send', 'linux-gdbus', 'linux-kdialog',
    ]);
  });
});

/** A probe that knows every command, and records every call. */
function recordingProbe(installed: boolean, calls: string[]) {
  return { which: async (cmd: string) => { calls.push(cmd); return installed; } };
}

for (const backend of BACKENDS as NotifyBackend[]) {
  describe(`backend contract: ${backend.name}`, () => {
    const text = BACKEND_TEXT[backend.name];

    it('is described in BACKEND_TEXT', () => {
      expect(text).toBeDefined();
    });

    it('runs a bare command name', () => {
      const { file } = backend.command('t', 'b');
      expect(file).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    it('carries the hostile title and body as one argv element each, and nowhere else', () => {
      const { args } = backend.command(TITLE, BODY);
      expect(args.every((a) => typeof a === 'string')).toBe(true);
      const titleAt = args.findIndex((a) => a.includes('TITLE-MARK'));
      const bodyAt = args.findIndex((a) => a.includes('BODY-MARK'));
      expect(titleAt).toBeGreaterThanOrEqual(0);
      expect(bodyAt).toBeGreaterThanOrEqual(0);
      expect(titleAt).not.toBe(bodyAt);
      expect(text.decode(args[titleAt])).toBe(TITLE);
      expect(text.decode(args[bodyAt])).toBe(text.markup ? escapeMarkup(BODY) : BODY);
      args.forEach((a, i) => {
        if (i === titleAt || i === bodyAt) return;
        for (const f of FRAGMENTS) expect(a, `argv[${i}] of ${backend.name}`).not.toContain(f);
      });
    });

    it('escapes markup only in the body, and only where the backend needs it', () => {
      const { args } = backend.command('<i>a & b</i>', '<b>c & d</b>');
      const title = args.find((a) => text.decode(a).includes('a & b'));
      expect(title && text.decode(title)).toBe('<i>a & b</i>');
      const body = args.map(text.decode).find((a) => a.includes('c &'));
      expect(body).toBe(text.markup ? '&lt;b&gt;c &amp; d&lt;/b&gt;' : '<b>c & d</b>');
    });

    it('keeps text that looks like an option or a literal as text', () => {
      for (const t of ['-flag', '--help', "'x'", '123', 'true', '[]', '"quoted"', 'a\\b', '(a,b)', '{k=v;}', '']) {
        const { args } = backend.command(`${t}`, `${t}`);
        const decoded = args.map(text.decode);
        expect(decoded.filter((a) => a === t).length, `${backend.name} with ${JSON.stringify(t)}`)
          .toBeGreaterThanOrEqual(text.markup && /[&<>]/.test(t) ? 1 : 2);
      }
    });

    it('decides availability from the probe alone, and only on its platforms', async () => {
      for (const os of ['macos', 'linux', 'other']) {
        for (const installed of [true, false]) {
          const calls: string[] = [];
          const first = await backend.available({ os }, recordingProbe(installed, calls));
          const second = await backend.available({ os }, recordingProbe(installed, []));
          expect(second).toBe(first);
          if (!(backend.platforms as string[]).includes(os)) expect(first).toBe(false);
        }
      }
      for (const os of backend.platforms) {
        // Installed everywhere means available on its own platforms.
        expect(await backend.available({ os }, recordingProbe(true, []))).toBe(true);
      }
    });
  });
}

describe('backend details', () => {
  it('osascript passes text as run arguments, never inside the script', () => {
    const { args } = BACKENDS.find((b) => b.name === 'macos-osascript')!.command(TITLE, BODY);
    const scripts = args.filter((_, i) => args[i - 1] === '-e');
    expect(scripts.join('\n')).toBe(
      'on run argv\ndisplay notification (item -1 of argv) with title (item -2 of argv)\nend run');
    expect(args.slice(-3)).toEqual(['--', TITLE, BODY]);
  });

  it('notify-send puts -- before the positional text', () => {
    const { args } = BACKENDS.find((b) => b.name === 'linux-notify-send')!.command('-t', '-b');
    expect(args).toEqual(['--app-name=mokkan', '--', '-t', '-b']);
  });

  it('gdbus writes every string as a typed literal that no GVariant reading can change', () => {
    expect(gvariantString("'x'")).toBe(`"'x'"`);
    expect(gvariantString('123')).toBe('"123"');
    expect(gvariantString('true')).toBe('"true"');
    expect(gvariantString('[]')).toBe('"[]"');
    expect(gvariantString('"quoted"')).toBe('"\\"quoted\\""');
    expect(gvariantString('a\\b')).toBe('"a\\\\b"');
    expect(gvariantString('a\x1bb\x07\x9b')).toBe('"a\\u001bb\\u0007\\u009b"');
    expect(gvariantString('')).toBe('""');
    const { args } = BACKENDS.find((b) => b.name === 'linux-gdbus')!.command('-flag', '-flag');
    expect(args.slice(-8)).toEqual(['"mokkan"', 'uint32 0', '""', '"-flag"', '"-flag"', '@as []', '@a{sv} {}', 'int32 -1']);
    // Nothing after --method may look like an option.
    expect(args.slice(args.indexOf('--method') + 2).some((a) => a.startsWith('-'))).toBe(false);
  });

  it('terminal-notifier guards values NSUserDefaults would parse', () => {
    for (const t of ['-flag', '[x]', '(a,b)', '{a=b;}', '<00>', '"q"', "'q'", '\\x', ' x', '']) {
      expect(guardDefaultsValue(t)).toBe(`⁠${t}`);
    }
    expect(guardDefaultsValue('plain text')).toBe('plain text');
    const { args } = BACKENDS.find((b) => b.name === 'macos-terminal-notifier')!.command('T', 'B');
    expect(args).toEqual(['-title', 'T', '-message', 'B', '-group', 'mokkan']);
  });
});

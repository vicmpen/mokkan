import { writeSync } from 'node:fs';
import type { CliIO, TerminalIO } from '../cli.js';
import { REFRESH_INTERVAL_MS, type TuiApp } from './app.js';
import { KeyDecoder } from './keys.js';
import { cursorPosition } from './screen.js';

/** Alternate screen, home, clear, hidden cursor, bracketed paste on. */
export const ENTER_SCREEN = '\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2004h';
/** Bracketed paste off, attributes reset, cursor shown, back to the main screen. */
export const LEAVE_SCREEN = '\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l';
/**
 * How long input may pause before the decoder's held-back tail is decoded as is: a lone Esc arrives as the
 * start of a possible escape sequence and only becomes the `escape` key once no more input follows.
 */
const ESC_FLUSH_MS = 50;

/**
 * Drives the app on a real terminal until it quits. Redraws are coalesced (one per tick); every state change and
 * resize schedules one. The terminal is restored in `finally`, and by a process `exit` handler if something
 * exits the process underneath us. Any exception propagates after the restore, so the CLI reports it normally.
 */
export async function runTerminal(app: TuiApp, io: CliIO, tty: TerminalIO): Promise<number> {
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const wake = (): void => { if (app.exitCode !== null) done(); };
  let pending: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let left = false;
  const draw = (): void => {
    pending = null;
    if (left) return;
    const size = tty.size();
    app.setSize(size);
    const frame = app.render(size, io.now());
    const cursor = cursorPosition(app.state, size);
    const place = cursor ? `\x1b[${cursor.row};${cursor.column}H\x1b[?25h` : '\x1b[?25l';
    io.stdout(`\x1b[H${frame.map((l) => `\x1b[2K${l}`).join('\r\n')}${place}`);
  };
  const scheduleDraw = (): void => { if (pending === null && !left) pending = setTimeout(draw, 0); };
  const restoreOnExit = (): void => {
    try { tty.setRawMode(false); } catch { /* stdin already gone */ }
    try { writeSync(1, LEAVE_SCREEN); } catch { /* stdout already gone */ }
  };
  const onSignal = (): void => { app.exitCode = 0; wake(); };
  const decoder = new KeyDecoder();
  const flush = (): void => {
    flushTimer = null;
    for (const key of decoder.flush()) void app.handleKey(key);
  };

  app.onChange = () => { scheduleDraw(); wake(); };
  let unData: () => void = () => undefined;
  let unResize: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    io.stdout(ENTER_SCREEN);
    tty.setRawMode(true);
    unData = tty.onData((chunk) => {
      for (const key of decoder.feed(chunk)) void app.handleKey(key);
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, ESC_FLUSH_MS);
    });
    unResize = tty.onResize(scheduleDraw);
    process.once('exit', restoreOnExit);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);
    timer = setInterval(() => { void app.refresh(); }, REFRESH_INTERVAL_MS);
    draw();
    void app.refresh();
    wake();
    await finished;
  } finally {
    left = true;
    app.onChange = () => undefined;
    if (timer !== undefined) clearInterval(timer);
    if (pending !== null) clearTimeout(pending);
    if (flushTimer !== null) clearTimeout(flushTimer);
    unData();
    unResize();
    process.off('exit', restoreOnExit);
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    tty.setRawMode(false);
    io.stdout(LEAVE_SCREEN);
  }
  return app.exitCode ?? 0;
}

import { writeSync } from 'node:fs';
import type { CliIO, TerminalIO } from '../cli.js';
import { REFRESH_INTERVAL_MS, errorText, type TuiApp } from './app.js';
import { KeyDecoder, type Key } from './keys.js';
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
    if (pending !== null) clearTimeout(pending);
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
  /** The app handles its own failures; anything that still escapes is shown rather than lost. */
  const report = (err: unknown): void => {
    app.state.message = { text: errorText(err), tone: 'red' };
    scheduleDraw();
  };
  /** Keys after the one that quits are dropped: `qxy` typed in one burst must not pop. */
  const dispatch = (keys: Key[]): void => {
    for (const key of keys) {
      if (app.exitCode !== null) return;
      void app.handleKey(key).catch(report);
    }
  };
  const decoder = new KeyDecoder();
  const flush = (): void => {
    flushTimer = null;
    dispatch(decoder.flush());
  };

  app.onChange = () => { scheduleDraw(); wake(); };
  let unData: () => void = () => undefined;
  let unResize: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    io.stdout(ENTER_SCREEN);
    tty.setRawMode(true);
    unData = tty.onData((chunk) => {
      dispatch(decoder.feed(chunk));
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, ESC_FLUSH_MS);
    });
    unResize = tty.onResize(scheduleDraw);
    process.once('exit', restoreOnExit);
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    process.once('SIGHUP', onSignal);
    timer = setInterval(() => { void app.refresh().catch(report); }, REFRESH_INTERVAL_MS);
    draw();
    void app.refresh().catch(report);
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
    process.off('SIGINT', onSignal);
    process.off('SIGHUP', onSignal);
    try { tty.setRawMode(false); } finally { io.stdout(LEAVE_SCREEN); }
  }
  return app.exitCode ?? 0;
}

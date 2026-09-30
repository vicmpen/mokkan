#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ApiError, NetworkError, MokkanClient, apiErrorHint } from './client.js';
import {
  clearCredentials, CredentialsCorruptError, CredentialsLockError, CredentialsPermissionError, loadCredentials, resolveServerUrl,
  saveCredentials, withCredentialsLock, type Credentials,
} from './credentials.js';
import { UserError } from './errors.js';
import { promptLine, readAllStdin } from './prompt.js';
import { loginCommand, logoutCommand, registerCommand, statusCommand } from './commands/auth.js';
import { doneCommand, listCommand, pendingCommand } from './commands/list.js';
import { ackCommand, editCommand, inCommand, pushCommand, takeCommand } from './commands/mutate.js';
import { balanceCommand, buyCommand, openUrlDetached } from './commands/billing.js';
import { heartbeatCommand } from './commands/heartbeat.js';
import { uiCommand } from './commands/ui.js';
import { HOOK_BUDGET_MS, hookCommand, safeAppendHookLog } from './hooks.js';
import { watchCommand } from './watcher.js';
import { invalidateStatusCache } from './status-cache.js';
import { isRenderInvocation, statuslineCommand } from './statusline.js';
import {
  migrateLegacyInvocation, nonTerminalHint, refreshStableCopy, statuslineSetupCommand, type SetupDeps,
} from './statusline-setup.js';

/** The interactive terminal `mokkan ui` drives. Absent when stdin or stdout is not a TTY. */
export interface TerminalIO {
  size(): { columns: number; rows: number };
  setRawMode(on: boolean): void;
  /** Delivers raw input chunks (already decoded as UTF-8). The returned function unsubscribes and pauses stdin. */
  onData(listener: (chunk: string) => void): () => void;
  onResize(listener: () => void): () => void;
}

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /**
   * stdin alone is a terminal (default: isTTY). Plain `mokkan statusline` configures or renders by this: Claude Code
   * pipes JSON into a status line command, and `mokkan statusline > log` from a terminal still configures.
   */
  stdinIsTTY?: boolean;
  prompt(question: string, hidden: boolean): Promise<string>;
  readStdin(): Promise<string>;
  fetchImpl?: typeof fetch;
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Starts the detached status line refresher (tests replace it). */
  spawnRefresh?: () => void;
  /**
   * Opens a URL in the user's browser, best effort; returns whether an opener started (tests replace it so no
   * browser ever starts).
   */
  openUrl?: (url: string) => boolean;
  /** The running CLI file and node binary written into status line configs (default process.argv[1], process.execPath). */
  cliPath?: string;
  nodePath?: string;
  /** The terminal for `mokkan ui` (defaultIO wires process.stdin/stdout; tests pass a FakeTerminal). */
  tty?: TerminalIO;
}

export interface Ctx {
  io: CliIO;
  client: MokkanClient;
  json: boolean;
  flags: Record<string, string | boolean>;
  now: () => Date;
}

export interface ParsedArgs {
  command: string | undefined;
  args: string[];
  flags: Record<string, string | boolean>;
}

/** Only these words are flags; any other `--word` is kept as a positional word (reminder text may contain them). */
const BOOLEAN_FLAGS = new Set(['json', 'all', 'once', 'start', 'complete', 'help', 'exit-zero']);
const VALUE_FLAGS = new Set(['otp', 'source', 'interval']);
/**
 * Flags that exist only for one command. For every other command these words stay in the text, so
 * `mokkan push meet bob --at 5pm sharp` still pushes the whole sentence.
 */
const COMMAND_FLAGS = new Map<string, { boolean: string[]; value: string[] }>([
  ['edit', { boolean: ['clear-due'], value: ['text', 'in', 'at'] }],
  ['buy', { boolean: ['no-open'], value: ['pack'] }],
]);

/**
 * `--argline <string>` as the FIRST argument: the string is split on whitespace into the command and its arguments.
 * The /mokkan slash command passes its whole (double-quoted) argument string this way so the shell never
 * word-splits, globs or comments it out. The arguments after the string are the command file's own fixed flags
 * (`--exit-zero`); they are parsed separately and win, so user text (`--`, a value flag without a value) can never
 * swallow or override them.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] !== '--argline') return parseWords(argv);
  const words = (argv[1] ?? '').trim().split(/\s+/).filter((w) => w !== '');
  const user = parseWords(words);
  // Positionals among the fixed arguments (e.g. the retired --no-color) are ignored.
  const fixed = parseWords(['_', ...argv.slice(2)]);
  return { command: user.command, args: user.args, flags: { ...user.flags, ...fixed.flags } };
}

function parseWords(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      // Command-specific flags count only once the command (the first positional word) is known.
      const scoped = positional.length > 0 ? COMMAND_FLAGS.get(positional[0]) : undefined;
      const scopedValue = scoped?.value.includes(name) === true;
      if (VALUE_FLAGS.has(name) || scopedValue) {
        if (eq !== -1) {
          flags[name] = arg.slice(eq + 1);
        } else if (i + 1 < argv.length) {
          flags[name] = argv[i + 1];
          i++;
        } else if (scopedValue) {
          // A command flag at the very end has no value: record that, so the command can report a usage error.
          flags[name] = '';
        }
        // A global value flag at the very end has no value: leave it unset rather than inventing one.
        continue;
      }
      if (eq === -1 && (BOOLEAN_FLAGS.has(name) || scoped?.boolean.includes(name) === true)) {
        flags[name] = true;
        continue;
      }
    }
    positional.push(arg);
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

export const USAGE = `Usage: mokkan <command> [args] [--json]

  mokkan [list] [--all]           active list, top of stack first (--all adds scheduled)
  mokkan push <text>              add to the top
  mokkan pop                      remove from the top (LIFO)
  mokkan dequeue                  remove from the bottom (FIFO)
  mokkan in <duration> <text>     schedule: 30s, 10m, 2h, 1d, 1h30m
  mokkan ack <id-prefix>... | all acknowledge shown reminders
  mokkan edit <n|id> [--all] [--in <duration> | --at <iso> | --clear-due] [new text...]
                                  change text and/or time of a reminder in one call; n = number in
                                  mokkan list (mokkan list --all with --all), or an id prefix
  mokkan pending                  due + awaiting acknowledgment
  mokkan done                     history of popped items
  mokkan ui                       full-screen view of the list with keyboard actions (needs a terminal)
  mokkan status                   server, account, session state
  mokkan buy [--pack <key>] [--no-open]
                                  buy credits: prints (and opens) a Stripe Checkout link
  mokkan balance [--json]         credit balance and recent transactions
  mokkan register [email]         create an account (--start | --complete --otp <code>)
  mokkan login [email]            log in (password from prompt or MOKKAN_PASSWORD)
  mokkan logout
  mokkan heartbeat [--source X]   tell the server a session is active
  mokkan hook session-start|stop  Claude Code hook entrypoints (JSON on stdin)
  mokkan watch [--interval N]     foreground poller (--once for a single pass)
  mokkan statusline [--claude] [--tmux|--codex] [--remove] [--dry-run] [--force]
                                  set up the status line: Claude Code's settings.json, plus a marked block in
                                  ~/.tmux.conf when tmux is installed and has no status-right or TPM of its own
                                  (Codex shows it through tmux); backups first, never replaces a status line that
                                  is not mokkan's without --force; from /mokkan only Claude Code unless --tmux
  mokkan statusline --render [--format ansi|tmux|plain] [--no-text] [--width N] [--ttl S] [--grace M]
                                  print the one-line summary (what the status line runs; always exits 0)

  --exit-zero                     report errors on stdout and always exit 0 (for the /mokkan slash command)
  --argline "<words>"             first argument only: split the string on whitespace and use it as the arguments
`;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** The real terminal for `mokkan ui`; undefined when stdin or stdout is not a TTY. */
function defaultTerminal(): TerminalIO | undefined {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return undefined;
  return {
    size: () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }),
    setRawMode: (on) => { stdin.setRawMode(on); },
    onData: (listener) => {
      const handler = (chunk: Buffer | string): void => { listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8')); };
      stdin.setEncoding('utf8');
      stdin.on('data', handler);
      stdin.resume();
      return () => { stdin.off('data', handler); stdin.pause(); };
    },
    onResize: (listener) => {
      stdout.on('resize', listener);
      return () => { stdout.off('resize', listener); };
    },
  };
}

export function defaultIO(): CliIO {
  return {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    prompt: promptLine,
    readStdin: readAllStdin,
    now: () => new Date(),
    sleep,
    openUrl: openUrlDetached,
    tty: defaultTerminal(),
  };
}

/** Exit code when the server answers 402 insufficient_credits (1 = user error, 2 = server/network). */
export const EXIT_INSUFFICIENT_CREDITS = 3;

function reportError(err: unknown, io: CliIO): number {
  if (err instanceof UserError || err instanceof CredentialsPermissionError) {
    io.stderr(`${err.message}\n`);
    return 1;
  }
  if (err instanceof ApiError) {
    io.stderr(`${err.message}\n`);
    const hint = apiErrorHint(err);
    if (hint) io.stderr(`${hint}\n`);
    if (err.status === 402 && err.code === 'insufficient_credits') return EXIT_INSUFFICIENT_CREDITS;
    return err.status >= 500 ? 2 : 1;
  }
  if (err instanceof NetworkError || err instanceof CredentialsLockError) {
    io.stderr(`${err.message}\n`);
    return 2;
  }
  io.stderr(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  return 2;
}

function makeClient(creds: Credentials | null, io: CliIO, timeoutMs: number, signal?: AbortSignal): MokkanClient {
  return new MokkanClient({
    baseUrl: resolveServerUrl(creds, io.env),
    credentials: creds,
    onCredentials: (next) => saveCredentials(next, io.env),
    reloadCredentials: () => loadCredentials(io.env),
    lock: (fn, lockSignal) => withCredentialsLock(io.env, fn, { signal: lockSignal }),
    onSessionExpired: () => clearCredentials(io.env),
    onListChanged: () => invalidateStatusCache(io.env),
    fetchImpl: io.fetchImpl,
    now: io.now,
    timeoutMs,
    signal,
  });
}

/**
 * Claude Code hook entrypoint. Must never fail the session: for a Stop hook, exit 2 means "block and feed stderr
 * to Claude". Every failure (credentials included) is logged to hook.log (best effort) and the exit code is 0.
 */
async function hookEntry(args: string[], flags: Record<string, string | boolean>, io: CliIO): Promise<number> {
  const kind = args[0];
  if (kind !== 'session-start' && kind !== 'stop') {
    // Only a human typo gets here (the plugin always passes a valid kind), so this stays a usage error.
    io.stderr('Usage: mokkan hook session-start|stop\n');
    return 1;
  }
  if (kind === 'session-start') {
    // The status line may run a stable copy of a plugin-cache CLI (statusline-setup.ts): keep it current after updates.
    try { refreshStableCopy(setupDeps(io).running, io.env); } catch { /* best effort */ }
  }
  try {
    // Up to 3 sequential requests (+ a refresh), each capped at 3 s, under one overall deadline that keeps the
    // whole run inside Claude Code's 10 s hook timeout.
    const deadlineAt = Date.now() + HOOK_BUDGET_MS;
    const client = makeClient(loadCredentials(io.env), io, 3000, AbortSignal.timeout(HOOK_BUDGET_MS));
    return await hookCommand({ io, client, json: flags.json === true, flags, now: io.now }, args, deadlineAt);
  } catch (err) {
    safeAppendHookLog(io.env, kind, err);
    return 0;
  }
}

function setupDeps(io: CliIO): SetupDeps {
  return { running: io.cliPath ?? process.argv[1] ?? '', node: io.nodePath ?? process.execPath };
}

/**
 * `statusline --render …` (or any render flag) renders; plain `statusline` configures. Exception: the plain command
 * with stdin not a terminal and outside /mokkan is most likely a status bar running an old `… statusline` config. It
 * never sets anything up: an old mokkan statusLine is migrated to `--render` and rendered as before; anything else
 * gets one line saying to run the setup in a terminal. An explicit target flag (`--claude`, `--tmux`) configures.
 */
async function statuslineEntry(args: string[], flags: Record<string, string | boolean>, io: CliIO): Promise<number> {
  const render = () => statuslineCommand(io, args, (creds, timeoutMs) => makeClient(creds, io, timeoutMs));
  if (isRenderInvocation(args)) return render();
  const deps = setupDeps(io);
  const fromClaude = flags['exit-zero'] === true;
  if (args.length === 0 && !(io.stdinIsTTY ?? io.isTTY) && !fromClaude) {
    if (migrateLegacyInvocation(io, deps)) return render();
    io.stdout(`${nonTerminalHint(io.env)}\n`);
    return 0;
  }
  return statuslineSetupCommand(io, args, deps, fromClaude);
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.flags['exit-zero'] !== true) return run(parsed, io);
  // Claude Code's `!` expansion aborts the slash command on a non-zero exit, so the model would never see
  // "List is empty." or "Not logged in": report everything on stdout and exit 0 instead.
  await run(parsed, { ...io, stderr: io.stdout });
  return 0;
}

async function run({ command, args, flags }: ParsedArgs, io: CliIO): Promise<number> {
  if (command === 'help' || flags.help === true) {
    io.stdout(USAGE);
    return 0;
  }
  if (command === 'hook') return hookEntry(args, flags, io);
  if (command === 'statusline') return statuslineEntry(args, flags, io);
  try {
    let creds: Credentials | null;
    try {
      creds = loadCredentials(io.env);
    } catch (err) {
      // login and logout are how a user recovers from a corrupt file, so they treat it as "no credentials".
      if (!(err instanceof CredentialsCorruptError) || (command !== 'login' && command !== 'logout')) throw err;
      if (command === 'logout') {
        clearCredentials(io.env);
        io.stdout(`Removed corrupt credentials file ${err.file}.\nLogged out.\n`);
        return 0;
      }
      creds = null;
    }
    const client = makeClient(creds, io, 5000);
    const ctx: Ctx = { io, client, json: flags.json === true, flags, now: io.now };
    switch (command) {
      case undefined:
      case 'list': return await listCommand(ctx);
      case 'done': return await doneCommand(ctx);
      case 'pending': return await pendingCommand(ctx);
      case 'ui': {
        const stop = new AbortController();
        try {
          return await uiCommand({ ...ctx, client: makeClient(creds, io, 5000, stop.signal) });
        } finally {
          stop.abort();
        }
      }
      case 'push': return await pushCommand(ctx, args);
      case 'pop': return await takeCommand(ctx, 'pop');
      case 'dequeue': return await takeCommand(ctx, 'dequeue');
      case 'in': return await inCommand(ctx, args);
      case 'ack': return await ackCommand(ctx, args);
      case 'edit': return await editCommand(ctx, args);
      case 'register': return await registerCommand(ctx, args);
      case 'login': return await loginCommand(ctx, args);
      case 'logout': return await logoutCommand(ctx);
      case 'status': return await statusCommand(ctx);
      case 'buy': return await buyCommand(ctx);
      case 'balance': return await balanceCommand(ctx);
      case 'heartbeat': return await heartbeatCommand(ctx);
      case 'watch': return await watchCommand(ctx);
      default:
        throw new UserError(`Unknown command "${command}".\n${USAGE}`);
    }
  } catch (err) {
    return reportError(err, io);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), defaultIO());
}

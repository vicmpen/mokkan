import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, type CliIO, type TerminalIO } from '../src/cli.js';
import { saveCredentials, type Credentials } from '../src/credentials.js';
import type { Reminder } from '../src/types.js';

export const NOW = new Date('2026-09-28T12:00:00.000Z');

export interface RunOptions {
  serverUrl?: string;
  loggedIn?: boolean;
  isTTY?: boolean;
  /** stdin alone is a terminal (defaults to isTTY); `mokkan statusline` configures or renders by this. */
  stdinIsTTY?: boolean;
  answers?: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  spawnRefresh?: () => void;
  now?: Date;
  /** Receives every URL the CLI asks to open; the real opener is never used in tests. */
  opened?: string[];
  /** The running CLI file and node binary `mokkan statusline` writes into configs (defaults: a temp file, /usr/bin/node). */
  cliPath?: string;
  nodePath?: string;
  tty?: TerminalIO;
}

export interface RunResult { code: number; stdout: string; stderr: string }

/**
 * One temp XDG_CONFIG_HOME and HOME per harness so credentials, hook.log and status line setup (~/.claude,
 * ~/.tmux.conf) never touch the real home. PATH is not passed, so tmux is never "installed" unless a test says so.
 */
export class CliHarness {
  readonly configHome: string;
  constructor() { this.configHome = mkdtempSync(path.join(tmpdir(), 'mokkan-cli-')); }

  dispose(): void { rmSync(this.configHome, { recursive: true, force: true }); }

  get home(): string { return path.join(this.configHome, 'home'); }

  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { XDG_CONFIG_HOME: this.configHome, HOME: this.home, ...extra };
  }

  /** A stand-in for the running CLI file (status line setup resolves it with realpath). */
  fakeCli(): string {
    const file = path.join(this.configHome, 'app', 'mokkan', 'dist', 'cli.js');
    mkdirSync(path.dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, '// fake mokkan cli\n');
    return file;
  }

  saveCreds(serverUrl: string, accessExpiresAt = '2026-09-29T12:00:00.000Z'): Credentials {
    const creds: Credentials = {
      server_url: serverUrl, email: 'a@example.com',
      access_token: 'access-0', access_expires_at: accessExpiresAt,
      refresh_token: 'refresh-0', refresh_expires_at: '2026-12-27T12:00:00.000Z',
    };
    saveCredentials(creds, this.env());
    return creds;
  }

  async run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
    if (opts.loggedIn && opts.serverUrl) this.saveCreds(opts.serverUrl);
    const answers = [...(opts.answers ?? [])];
    let stdout = '';
    let stderr = '';
    const io: CliIO = {
      stdout: (t) => { stdout += t; },
      stderr: (t) => { stderr += t; },
      env: this.env({ ...(opts.serverUrl ? { MOKKAN_SERVER_URL: opts.serverUrl } : {}), ...(opts.env ?? {}) }),
      isTTY: opts.isTTY ?? false,
      stdinIsTTY: opts.stdinIsTTY ?? opts.isTTY ?? false,
      prompt: async () => {
        if (answers.length === 0) throw new Error('test prompt: no scripted answer left');
        return answers.shift()!;
      },
      readStdin: async () => opts.stdin ?? '',
      now: () => opts.now ?? NOW,
      sleep: async () => undefined,
      spawnRefresh: opts.spawnRefresh,
      openUrl: (url) => { opts.opened?.push(url); },
      cliPath: opts.cliPath ?? this.fakeCli(),
      nodePath: opts.nodePath ?? '/usr/bin/node',
      tty: opts.tty,
    };
    const code = await main(argv, io);
    return { code, stdout, stderr };
  }
}

export function reminder(over: Partial<Reminder> & { id: string; text: string }): Reminder {
  return {
    state: 'due', position: 1, due_at: null, created_at: NOW.toISOString(),
    delivered_at: null, acknowledged_at: null, done_at: null, ...over,
  };
}

/** A terminal for `mokkan ui` tests: typed text is buffered until the TUI listens, size is settable. */
export class FakeTerminal implements TerminalIO {
  readonly rawModes: boolean[] = [];
  private dataListener: ((chunk: string) => void) | null = null;
  private resizeListener: (() => void) | null = null;
  private pending: string[] = [];

  constructor(public columns = 80, public rows = 24) {}

  size(): { columns: number; rows: number } { return { columns: this.columns, rows: this.rows }; }
  setRawMode(on: boolean): void { this.rawModes.push(on); }

  onData(listener: (chunk: string) => void): () => void {
    this.dataListener = listener;
    for (const chunk of this.pending.splice(0)) listener(chunk);
    return () => { if (this.dataListener === listener) this.dataListener = null; };
  }

  onResize(listener: () => void): () => void {
    this.resizeListener = listener;
    return () => { this.resizeListener = null; };
  }

  /** Types raw bytes as a user would (`'\x1b[B'` is the down arrow). */
  type(text: string): void {
    if (this.dataListener) this.dataListener(text);
    else this.pending.push(text);
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resizeListener?.();
  }
}

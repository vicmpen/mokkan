import { execFile } from 'node:child_process';

/** What a finished (or failed) process produced. `error` is set when it did not run to an exit code. */
export interface SpawnResult {
  /** The exit code; null when the process could not start, was killed or died from a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `ENOENT` (not installed), `timeout`, `signal SIGxxx` or another start failure. */
  error?: string;
}

export interface SpawnOptions {
  /** Killed after this many milliseconds (default 5000). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs `file` with an argv array and collects its output. Never a shell, never throws: every failure is in the
 * result. Tests inject a fake through `CliIO.spawn`, so no real notifier, launchctl or systemctl ever starts.
 */
export type Spawner = (file: string, args: string[], opts?: SpawnOptions) => Promise<SpawnResult>;

export const DEFAULT_SPAWN_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 1024 * 1024;

/** The real Spawner: `execFile`, stdin closed, hidden window on Windows, SIGKILL on timeout. */
export const execFileSpawner: Spawner = (file, args, opts = {}) => new Promise((resolve) => {
  try {
    const child = execFile(file, args, {
      encoding: 'utf8', env: opts.env ?? process.env, timeout: opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, windowsHide: true, shell: false,
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number | null; killed?: boolean; signal?: string | null };
      if (typeof e.code === 'number') resolve({ code: e.code, stdout, stderr });
      // A string code is a start failure (ENOENT, EACCES) or the output limit; a timeout has no code.
      else if (typeof e.code === 'string') resolve({ code: null, stdout, stderr, error: e.code });
      else if (e.killed) resolve({ code: null, stdout, stderr, error: 'timeout' });
      else if (e.signal) resolve({ code: null, stdout, stderr, error: `signal ${e.signal}` });
      else resolve({ code: null, stdout, stderr, error: e.message });
    });
    // A child that reads stdin gets EOF instead of hanging until the timeout.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  } catch (err) {
    // execFile throws synchronously for invalid arguments (a NUL byte in argv).
    resolve({ code: null, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
  }
});

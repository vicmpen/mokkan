import type { Probe } from '../detect.js';

export type BackendOs = 'macos' | 'linux';

/**
 * A desktop notifier. Title and body arrive sanitized (`sanitizeText`), but every backend stays safe if they are not:
 * text only ever travels as whole argv elements, never inside a script or a shell string.
 */
export interface NotifyBackend {
  name: string;
  platforms: BackendOs[];
  /** Pure given the probe: is this backend usable here? */
  available(facts: { os: string }, probe: Pick<Probe, 'which'>): Promise<boolean>;
  /** The exact argv to run. `file` is a bare command name, looked up on PATH. */
  command(title: string, body: string): { file: string; args: string[] };
}

/** `available()` for a backend that needs one command on PATH on one of its platforms. */
export function needsCommand(platforms: BackendOs[], cmd: string): NotifyBackend['available'] {
  return async (facts, probe) => (platforms as string[]).includes(facts.os) && probe.which(cmd);
}

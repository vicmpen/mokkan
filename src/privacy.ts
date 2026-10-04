import { ApiError } from './client.js';
import type { PrivacyResponse } from './types.js';

/** Exit code when the server answers 403 privacy_not_accepted, or 409 privacy_version_stale to an acceptance. */
export const EXIT_PRIVACY_REQUIRED = 4;

/** The server's gate: the account has not accepted the current privacy policy. */
export const isPrivacyRequired = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 403 && err.code === 'privacy_not_accepted';

/** The policy changed between showing it and accepting it (or registering with it). */
export const isPrivacyStale = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && err.code === 'privacy_version_stale';

/** `mokkan <args> (or npx @vicmpen/mokkan-cli <args> if mokkan isn't installed)`: how a message sends the user to a terminal. */
export const terminalCommand = (args: string): string => `mokkan ${args} (or npx @vicmpen/mokkan-cli ${args} if mokkan isn't installed)`;

/** The summary as the CLI prints it before asking: version, one indented line per summary line, the full text's address. */
export function formatPolicy(p: PrivacyResponse): string {
  return [`mokkan privacy policy, version ${p.version}:`, ...p.summary.map((l) => `  ${l}`), `Full text: ${p.url}`, ''].join('\n');
}

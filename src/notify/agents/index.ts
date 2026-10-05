import type { PlatformFacts } from '../detect.js';
import { launchdAgent } from './launchd.js';
import { systemdUserAgent } from './systemd-user.js';
import { xdgAutostartAgent } from './xdg-autostart.js';
import type { NotifyAgent } from './types.js';

export type { AgentContext, AgentFile, AgentInstallState, AgentResult, NotifyAgent } from './types.js';

/** Every background agent; detection picks at most one per machine (`PlatformFacts.agent`). */
export const AGENTS: readonly NotifyAgent[] = [launchdAgent, systemdUserAgent, xdgAutostartAgent];

/** The agent for this machine, or null on a headless machine, WSL or an unsupported OS. */
export function agentFor(facts: PlatformFacts): NotifyAgent | null {
  return AGENTS.find((a) => a.applies(facts)) ?? null;
}

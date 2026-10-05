import type { Spawner } from '../../spawn.js';
import type { AgentKind, PlatformFacts } from '../detect.js';

/** Everything an agent needs to write and load its files. Paths derive from `env`, never from the real HOME. */
export interface AgentContext {
  /** `HOME` and `XDG_CONFIG_HOME` decide where the files go; also the environment for launchctl and systemctl. */
  env: NodeJS.ProcessEnv;
  /** Runs launchctl and systemctl; tests inject a recording fake. */
  spawn: Spawner;
  uid: number;
  /** Absolute path to node (`process.execPath` at setup time). */
  node: string;
  /** Absolute path to cli.js. */
  cli: string;
  /** Seconds between polls (launchd and systemd; the XDG loop re-reads the config every round). */
  interval: number;
  /** Set only when XDG_CONFIG_HOME was set at setup time; passed into the agent's environment. */
  xdgConfigHome?: string;
}

/** `messages` are human lines for `setup` and `remove` to print: what was done, warnings and failures. */
export interface AgentResult { changed: boolean; messages: string[] }

/**
 * What `installed` reports. `foreign`: a file with our name exists without our marker. `stale`: ours, but not what
 * `render(ctx)` would write now, or the baked node or cli path no longer exists.
 */
export type AgentInstallState = 'yes' | 'no' | 'foreign' | 'stale';

/** A rendered file: its absolute path and exact contents. */
export interface AgentFile { path: string; content: string }

/**
 * A background scheduler that runs `notify poll`. Every agent writes only files carrying its marker, and leaves a
 * file with the same name but without the marker alone (the `link_ours` rule of install.sh).
 */
export interface NotifyAgent {
  name: AgentKind;
  /** The marker line every file starts with (after the XML declaration for a plist). */
  marker: string;
  applies(facts: PlatformFacts): boolean;
  /** The absolute paths it manages. */
  files(ctx: AgentContext): string[];
  /** Pure: the exact file contents. Throws when `contextProblem(ctx)` reports one. */
  render(ctx: AgentContext): AgentFile[];
  /** Writes the files when they differ and loads the agent. Never throws for a refusal or a failed command. */
  install(ctx: AgentContext): Promise<AgentResult>;
  /** Unloads the agent and deletes the files carrying the marker. */
  remove(ctx: AgentContext): Promise<AgentResult>;
  /** Decided from the files alone; it does not ask launchctl or systemctl. */
  installed(ctx: AgentContext): Promise<AgentInstallState>;
}

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { configDir } from '../credentials.js';
import { UserError } from '../errors.js';

export type OscMode = 'off' | 'auto' | '9' | '777' | '99';
export const OSC_MODES: readonly OscMode[] = ['off', 'auto', '9', '777', '99'];

/** The `notifications` section of config.json. */
export interface NotifyConfig {
  shell: boolean;
  desktop: boolean;
  osc: OscMode;
  /** Seconds between polls, shared by the agent and every shell. */
  interval: number;
}

export const MIN_INTERVAL_SECONDS = 30;

/** Desktop notifications stay off until the user consents in `mokkan notify setup`. */
export const DEFAULT_NOTIFY_CONFIG: Readonly<NotifyConfig> = { shell: true, desktop: false, osc: 'off', interval: 60 };

const ALL_OFF: Readonly<NotifyConfig> = { ...DEFAULT_NOTIFY_CONFIG, shell: false, desktop: false, osc: 'off' };

export interface LoadedNotifyConfig {
  config: NotifyConfig;
  /** Why every channel is off although the file may say otherwise: `MOKKAN_NOTIFY=0`, or a corrupt file. */
  disabledBy: 'env' | 'corrupt' | null;
  /** For a corrupt file: what is wrong, to log (hourly) and to show in `notify status`. */
  problem: string | null;
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'config.json');
}

export function notifyDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  return env.MOKKAN_NOTIFY === '0';
}

/**
 * The effective notification settings: defaults merged with config.json. `MOKKAN_NOTIFY=0` turns every channel off.
 * A corrupt file (bad JSON, or a value of the wrong type) turns every channel off as well and reports the problem,
 * so a typo never makes the prompt print errors. An interval below the minimum is raised to it.
 */
export function loadNotifyConfig(env: NodeJS.ProcessEnv = process.env): LoadedNotifyConfig {
  const read = readConfigFile(env);
  if (notifyDisabledByEnv(env)) return { config: { ...ALL_OFF }, disabledBy: 'env', problem: read.problem };
  if (read.problem !== null) return { config: { ...ALL_OFF }, disabledBy: 'corrupt', problem: read.problem };
  const parsed = parseNotifications(read.root.notifications);
  if (typeof parsed === 'string') {
    return { config: { ...ALL_OFF }, disabledBy: 'corrupt', problem: `${configFilePath(env)}: ${parsed}` };
  }
  const config = { ...DEFAULT_NOTIFY_CONFIG, ...parsed };
  config.interval = Math.max(MIN_INTERVAL_SECONDS, Math.round(config.interval));
  return { config, disabledBy: null, problem: null };
}

/**
 * Merges `patch` into the `notifications` section and writes config.json atomically (0600), keeping any other
 * top-level sections. Refuses a corrupt file rather than overwriting what the user wrote.
 */
export function saveNotifyConfig(env: NodeJS.ProcessEnv, patch: Partial<NotifyConfig>): NotifyConfig {
  const read = readConfigFile(env);
  if (read.problem !== null) throw new UserError(`${read.problem}. Fix or delete it, then try again.`);
  const current = parseNotifications(read.root.notifications);
  if (typeof current === 'string') throw new UserError(`${configFilePath(env)}: ${current}. Fix or delete it, then try again.`);
  if (patch.interval !== undefined && (!Number.isInteger(patch.interval) || patch.interval < MIN_INTERVAL_SECONDS)) {
    throw new UserError(`interval must be a whole number of seconds, at least ${MIN_INTERVAL_SECONDS}`);
  }
  if (patch.osc !== undefined && !OSC_MODES.includes(patch.osc)) throw new UserError(`osc must be one of: ${OSC_MODES.join(', ')}`);
  const next: NotifyConfig = { ...DEFAULT_NOTIFY_CONFIG, ...current, ...patch };
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = configFilePath(env);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...read.root, notifications: next }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return next;
}

function readConfigFile(env: NodeJS.ProcessEnv): { root: Record<string, unknown>; problem: string | null } {
  const file = configFilePath(env);
  if (!existsSync(file)) return { root: {}, problem: null };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const reason = err instanceof SyntaxError ? 'not valid JSON' : (err as Error).message;
    return { root: {}, problem: `${file}: ${reason}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { root: {}, problem: `${file}: not a JSON object` };
  }
  return { root: value as Record<string, unknown>, problem: null };
}

/** The keys present in a `notifications` value, or a description of what is wrong with it. */
function parseNotifications(value: unknown): Partial<NotifyConfig> | string {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '"notifications" must be an object';
  const v = value as Record<string, unknown>;
  const out: Partial<NotifyConfig> = {};
  for (const key of ['shell', 'desktop'] as const) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== 'boolean') return `"notifications.${key}" must be true or false`;
    out[key] = v[key];
  }
  if (v.osc !== undefined) {
    if (typeof v.osc !== 'string' || !OSC_MODES.includes(v.osc as OscMode)) {
      return `"notifications.osc" must be one of: ${OSC_MODES.map((m) => `"${m}"`).join(', ')}`;
    }
    out.osc = v.osc as OscMode;
  }
  if (v.interval !== undefined) {
    if (typeof v.interval !== 'number' || !Number.isFinite(v.interval)) return '"notifications.interval" must be a number of seconds';
    out.interval = v.interval;
  }
  return out;
}

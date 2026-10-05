import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configFilePath, DEFAULT_NOTIFY_CONFIG, loadNotifyConfig, saveNotifyConfig } from '../src/notify/config.js';
import { UserError } from '../src/errors.js';

describe('notify config', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const write = (value: unknown): void => {
    mkdirSync(path.join(dir, 'mokkan'), { recursive: true });
    writeFileSync(configFilePath(env), typeof value === 'string' ? value : JSON.stringify(value));
  };
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'mokkan-notify-config-')); env = { XDG_CONFIG_HOME: dir }; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('uses the defaults without a file: shell on, desktop off until consent, osc off', () => {
    expect(loadNotifyConfig(env)).toEqual({
      config: { shell: true, desktop: false, osc: 'off', interval: 60 }, disabledBy: null, problem: null,
    });
  });

  it('merges the file over the defaults and ignores other sections', () => {
    write({ other: { x: 1 }, notifications: { desktop: true, osc: '777' } });
    expect(loadNotifyConfig(env).config).toEqual({ shell: true, desktop: true, osc: '777', interval: 60 });
  });

  it('raises an interval below the minimum to 30 s', () => {
    write({ notifications: { interval: 5 } });
    expect(loadNotifyConfig(env).config.interval).toBe(30);
  });

  it('MOKKAN_NOTIFY=0 turns every channel off', () => {
    write({ notifications: { shell: true, desktop: true, osc: '9' } });
    const loaded = loadNotifyConfig({ ...env, MOKKAN_NOTIFY: '0' });
    expect(loaded.disabledBy).toBe('env');
    expect(loaded.config).toMatchObject({ shell: false, desktop: false, osc: 'off' });
  });

  it.each([
    ['{not json', 'not valid JSON'],
    ['[1]', 'not a JSON object'],
    [{ notifications: 'yes' }, '"notifications" must be an object'],
    [{ notifications: { shell: 'yes' } }, '"notifications.shell" must be true or false'],
    [{ notifications: { osc: 'bell' } }, '"notifications.osc" must be one of'],
    [{ notifications: { interval: '60' } }, '"notifications.interval" must be a number'],
  ])('a corrupt file (%j) turns everything off and says why', (content, why) => {
    write(content);
    const loaded = loadNotifyConfig(env);
    expect(loaded.disabledBy).toBe('corrupt');
    expect(loaded.config).toMatchObject({ shell: false, desktop: false, osc: 'off' });
    expect(loaded.problem).toContain(configFilePath(env));
    expect(loaded.problem).toContain(why);
  });

  it('saves atomically at 0600, merging into what is there and keeping other sections', () => {
    write({ other: { keep: true }, notifications: { osc: '9' } });
    expect(saveNotifyConfig(env, { desktop: true })).toEqual({ ...DEFAULT_NOTIFY_CONFIG, desktop: true, osc: '9' });
    expect(JSON.parse(readFileSync(configFilePath(env), 'utf8'))).toEqual({
      other: { keep: true }, notifications: { shell: true, desktop: true, osc: '9', interval: 60 },
    });
    expect(statSync(configFilePath(env)).mode & 0o777).toBe(0o600);
  });

  it('creates the file when there is none', () => {
    saveNotifyConfig(env, { shell: false });
    expect(loadNotifyConfig(env).config.shell).toBe(false);
  });

  it('refuses an invalid interval or osc mode, and a corrupt file, without writing', () => {
    expect(() => saveNotifyConfig(env, { interval: 10 })).toThrow(UserError);
    expect(() => saveNotifyConfig(env, { interval: 45.5 })).toThrow('at least 30');
    expect(() => saveNotifyConfig(env, { osc: 'bell' as never })).toThrow('osc must be one of');
    write('{broken');
    expect(() => saveNotifyConfig(env, { shell: false })).toThrow('Fix or delete it');
    expect(readFileSync(configFilePath(env), 'utf8')).toBe('{broken');
  });
});

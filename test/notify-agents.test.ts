import { describe, it, expect } from 'vitest';
import { AGENTS, agentFor, type AgentContext } from '../src/notify/agents/index.js';
import { launchdAgent, xmlEscape } from '../src/notify/agents/launchd.js';
import { systemdQuote, systemdUserAgent } from '../src/notify/agents/systemd-user.js';
import { desktopExecArg, xdgAutostartAgent } from '../src/notify/agents/xdg-autostart.js';
import { contextProblem } from '../src/notify/agents/files.js';
import type { PlatformFacts } from '../src/notify/detect.js';

/** Paths with a space, `%`, `$`, `&`, `"`, `'` and `\` in them, to exercise every format's escaping. */
const NODE = '/opt/node 20/bin/node';
const CLI = `/opt/a b/100%/$HOME&"q"/it's\\cli.js`;
const XDG = '/home/u/my cfg%$"';

function ctx(xdgConfigHome?: string): AgentContext {
  return {
    env: xdgConfigHome === undefined ? { HOME: '/home/u' } : { HOME: '/home/u', XDG_CONFIG_HOME: xdgConfigHome },
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    uid: 501, node: NODE, cli: CLI, interval: 300, xdgConfigHome,
  };
}

const PLIST_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- managed by mokkan -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.mokkan.notify</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node 20/bin/node</string>
    <string>/opt/a b/100%/$HOME&amp;&quot;q&quot;/it&apos;s\\cli.js</string>
    <string>notify</string>
    <string>poll</string>
  </array>
`;
const PLIST_TAIL = `  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;

const TIMER = `# managed by mokkan
[Unit]
Description=mokkan reminder notifications

[Timer]
OnBootSec=1min
OnUnitActiveSec=300s
AccuracySec=10s
Unit=mokkan-notify.service

[Install]
WantedBy=timers.target
`;

describe('launchd render', () => {
  it('writes the plist with every string XML-escaped, and a PATH where Homebrew\'s terminal-notifier is found', () => {
    expect(launchdAgent.render(ctx())).toEqual([{
      path: '/home/u/Library/LaunchAgents/dev.mokkan.notify.plist',
      content: `${PLIST_HEAD}  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
${PLIST_TAIL}`,
    }]);
  });

  it('also passes XDG_CONFIG_HOME when it was set', () => {
    const [file] = launchdAgent.render(ctx(XDG));
    expect(file.path).toBe('/home/u/Library/LaunchAgents/dev.mokkan.notify.plist');
    expect(file.content).toBe(`${PLIST_HEAD}  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>XDG_CONFIG_HOME</key>
    <string>/home/u/my cfg%$&quot;</string>
  </dict>
${PLIST_TAIL}`);
  });

  it('escapes the five XML characters', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('systemd-user render', () => {
  it('writes a oneshot service and a timer under ~/.config/systemd/user', () => {
    expect(systemdUserAgent.render(ctx())).toEqual([
      {
        path: '/home/u/.config/systemd/user/mokkan-notify.service',
        content: `# managed by mokkan
[Unit]
Description=mokkan reminder notifications

[Service]
Type=oneshot
ExecStart="/opt/node 20/bin/node" "/opt/a b/100%%/$$HOME&\\"q\\"/it's\\\\cli.js" notify poll
`,
      },
      { path: '/home/u/.config/systemd/user/mokkan-notify.timer', content: TIMER },
    ]);
  });

  it('follows XDG_CONFIG_HOME for the unit directory and passes it in Environment=', () => {
    expect(systemdUserAgent.render(ctx(XDG))).toEqual([
      {
        path: '/home/u/my cfg%$"/systemd/user/mokkan-notify.service',
        content: `# managed by mokkan
[Unit]
Description=mokkan reminder notifications

[Service]
Type=oneshot
Environment="XDG_CONFIG_HOME=/home/u/my cfg%%$\\""
ExecStart="/opt/node 20/bin/node" "/opt/a b/100%%/$$HOME&\\"q\\"/it's\\\\cli.js" notify poll
`,
      },
      { path: '/home/u/my cfg%$"/systemd/user/mokkan-notify.timer', content: TIMER },
    ]);
  });

  it('quotes words, doubling % always and $ only where it would expand', () => {
    expect(systemdQuote('a\\b"c%d$e', true)).toBe('"a\\\\b\\"c%%d$$e"');
    expect(systemdQuote('a\\b"c%d$e', false)).toBe('"a\\\\b\\"c%%d$e"');
  });
});

describe('xdg-autostart render', () => {
  it('writes a hidden autostart entry that runs the poll loop', () => {
    expect(xdgAutostartAgent.render(ctx())).toEqual([{
      path: '/home/u/.config/autostart/mokkan-notify.desktop',
      content: `# managed by mokkan
[Desktop Entry]
Type=Application
Name=mokkan notifications
Exec="/opt/node 20/bin/node" "/opt/a b/100%%/\\\\$HOME&\\\\"q\\\\"/it's\\\\\\\\cli.js" notify poll --loop
NoDisplay=true
X-GNOME-Autostart-enabled=true
`,
    }]);
  });

  it('passes XDG_CONFIG_HOME through env', () => {
    const [file] = xdgAutostartAgent.render(ctx(XDG));
    expect(file.path).toBe('/home/u/my cfg%$"/autostart/mokkan-notify.desktop');
    expect(file.content.split('\n')[4]).toBe(
      'Exec=env "XDG_CONFIG_HOME=/home/u/my cfg%%\\\\$\\\\"" "/opt/node 20/bin/node" '
      + '"/opt/a b/100%%/\\\\$HOME&\\\\"q\\\\"/it\'s\\\\\\\\cli.js" notify poll --loop');
  });

  it('quotes only arguments with reserved characters', () => {
    expect(desktopExecArg('/usr/bin/node')).toBe('/usr/bin/node');
    expect(desktopExecArg('/a%b')).toBe('/a%%b');
    expect(desktopExecArg('a b')).toBe('"a b"');
    expect(desktopExecArg('a`b')).toBe('"a\\\\`b"');
    expect(desktopExecArg('')).toBe('""');
  });
});

describe('agent context', () => {
  it('rejects relative paths, control characters and a bad interval, and render throws for them', () => {
    expect(contextProblem(ctx(XDG))).toBeNull();
    expect(contextProblem({ ...ctx(), node: 'node' })).toMatch(/not absolute/);
    expect(contextProblem({ ...ctx(), cli: '/a\nExecStartPre=/bin/evil' })).toMatch(/control character/);
    expect(contextProblem({ ...ctx(), xdgConfigHome: 'rel' })).toMatch(/not absolute/);
    expect(contextProblem({ ...ctx(), interval: 0 })).toMatch(/interval/);
    expect(contextProblem({ ...ctx(), interval: 1.5 })).toMatch(/interval/);
    for (const agent of AGENTS) expect(() => agent.render({ ...ctx(), cli: '/a\nb' })).toThrow(/control character/);
  });

  it('install reports a bad context instead of throwing', async () => {
    for (const agent of AGENTS) {
      const r = await agent.install({ ...ctx(), node: 'node' });
      expect(r.changed).toBe(false);
      expect(r.messages.join('\n')).toMatch(/not absolute/);
    }
  });
});

describe('agentFor', () => {
  const facts = (agent: PlatformFacts['agent']): PlatformFacts =>
    ({ os: 'linux', gui: true, agent, ssh: false, wsl: false, tmux: false, backends: [], reasons: [] });
  it('picks the agent detection named, or none', () => {
    expect(agentFor(facts('launchd'))).toBe(launchdAgent);
    expect(agentFor(facts('systemd-user'))).toBe(systemdUserAgent);
    expect(agentFor(facts('xdg-autostart'))).toBe(xdgAutostartAgent);
    expect(agentFor(facts(null))).toBeNull();
  });
});

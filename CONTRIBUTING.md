# Contributing to mokkan

Thanks for helping. Bug reports, fixes and support for more systems are all welcome. For a larger change, open an issue first so we can agree on the shape before you write it.

## Setup

mokkan needs Node.js 20.3 or later. The CLI is TypeScript with no runtime dependencies.

```
git clone https://github.com/vicmpen/mokkan
cd mokkan
./install.sh           # npm ci and the build, then links ~/.local/bin/mokkan to this checkout
```

Or, without the links: `npm ci`.

Before you open a pull request:

```
npm test               # vitest
npm run typecheck
npm run bundle         # rebuilds claude-plugin/scripts/mokkan.mjs
```

The plugin's bundled CLI (`claude-plugin/scripts/mokkan.mjs`) is committed, because Claude Code installs plugins straight from git. Any change under `src/` changes the bundle, so run `npm run bundle` and commit the result; a test fails when the committed bundle is stale.

Keep the README in step with what the code does. Write it in plain, short sentences.

## Notifications on your system

`mokkan notify` shows fired, unacknowledged scheduled reminders at the shell prompt and as desktop notifications. It is built from three kinds of small modules, each in a registry, so adding a shell, a desktop notifier or a background scheduler is usually one new file, one registry line and a few test lines.

| Kind | Directory | Registry |
|---|---|---|
| Desktop notifier (backend) | `src/notify/backends/` | `BACKENDS` in `src/notify/backends/index.ts` |
| Background scheduler (agent) | `src/notify/agents/` | `AGENTS` in `src/notify/agents/index.ts` |
| Shell prompt hook | `src/notify/shells/` | `SHELLS` in `src/notify/shells/index.ts` |

### Backends

A backend turns a title and a body into one command to run. From `src/notify/backends/types.ts`:

```ts
export interface NotifyBackend {
  name: string;
  platforms: BackendOs[];
  /** Pure given the probe: is this backend usable here? */
  available(facts: { os: string }, probe: Pick<Probe, 'which'>): Promise<boolean>;
  /** The exact argv to run. `file` is a bare command name, looked up on PATH. */
  command(title: string, body: string): { file: string; args: string[] };
}
```

`needsCommand(platforms, cmd)` in the same file covers the usual "available when this command is on PATH" case. `BACKENDS` is in preference order: the first available backend on the platform is used. Today that is terminal-notifier, then `osascript` on macOS, and `notify-send`, then `gdbus`, then `kdialog` on Linux.

Add your backend to `BACKENDS`, add its name to the list in the "backend registry" test, and add one line to `BACKEND_TEXT` in `test/notify-contract.test.ts`:

```ts
'linux-example': { decode: (a) => a, markup: false },
```

`decode` undoes your backend's own quoting of an argument (identity for most), and `markup` says whether the body is markup on that notifier and so is escaped.

### Agents

An agent installs something that runs `mokkan notify poll` every `interval` seconds while the user is logged in. From `src/notify/agents/types.ts`:

```ts
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
```

`src/notify/agents/files.ts` has the shared helpers: `writeOurs`, `removeOurs`, `installedState`, `contextProblem` and `MARKER_TEXT`. Add the agent to `AGENTS`, add its name to `AgentKind`, and teach `detectPlatform` in `src/notify/detect.ts` when to pick it. Detection picks at most one agent per machine.

### Shells

A shell module generates the prompt hook. From `src/notify/shells/types.ts`:

```ts
export interface NotifyShell {
  name: ShellName;
  installStyle: 'rc-block' | 'drop-in';
  rcFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string;
  initFile(env: NodeJS.ProcessEnv): string;
  snippet(opts: SnippetOptions): string;
  rcLine(): string;
}
```

`snippet` returns the whole generated `init.<shell>`. `rcLine` is what goes into the user's config: one line inside a marked block (`rc-block`), or a file of its own (`drop-in`, like fish's `conf.d`). Use `zsh.ts`, `bash.ts` and `fish.ts` as models. The hook must:

- do nothing in a non-interactive shell;
- check `MOKKAN_NOTIFY` before it starts `node`;
- start `notify poll` only when the `stamp` file is at least `interval` seconds old, check that the stamp is all digits before any arithmetic, and run the poll in the background with stdin, stdout and stderr detached from the terminal;
- print `shell.txt` only when it differs from what this shell printed last, kept in a shell variable;
- print reminder text literally (`printf '%s'`, `print -r`), never through `echo -e`, `print -P` or `eval`.

Add the shell to `SHELLS` and to `ShellName`, and its non-interactive guard to `NONINTERACTIVE_GUARD` in `test/notify-contract.test.ts`.

### What the contract test checks

`test/notify-contract.test.ts` runs the same checks on every registered module, so a new one gets most of its tests by being registered.

- **Backends:** `file` is a bare command name. A hostile title and body (escape sequences, `$(…)`, quotes, AppleScript, markup, a leading `-`) each arrive as one argv element and appear nowhere else. Markup is escaped in the body only, and only where `BACKEND_TEXT` says the backend needs it. Text that looks like an option or a literal (`-flag`, `'x'`, `123`, `[]`, `{k=v;}`) stays text. `available()` depends on the probe alone and is false off its platforms.
- **Agents:** in a temp `HOME`, `install` → `installed` → a second `install` that changes nothing → `remove`. Every file carries the marker. A file with the agent's name but without the marker survives both `install` and `remove`. A missing `cli` or changed content reports `stale`, and `install` rewrites a stale file of its own.
- **Shells:** the version line comes first and the non-interactive guard second, no `<placeholder>` is left, `MOKKAN_NOTIFY` is checked before `node` starts, reminder text is never expanded, and `rcLine()` sources `init.<shell>`.

### Safety rules

Reminder text is untrusted: it may have been pushed from another machine, or by an agent.

- **argv only.** A backend passes the text as whole argv elements. Never put it into a script, a shell string, an AppleScript or a `sh -c`. When a notifier parses its arguments (`gdbus` reads GVariant text, terminal-notifier reads property lists), encode the text so the parser can't change it, as `linux-gdbus.ts` and `macos-terminal-notifier.ts` do.
- **Sanitized, and still safe.** Text reaches a backend after `sanitizeText` has stripped control characters, escape sequences and bidi overrides. Your module must stay safe if it didn't: the contract test sends unsanitized text.
- **Markup.** Where the notifier reads the body as markup (Pango on GNOME and KDE), escape it with `escapeMarkup` from `src/notify/sanitize.ts`. Don't escape where it isn't markup, or users see `&amp;`.
- **Only our files.** Every file an agent or shell writes carries the "managed by mokkan" marker. Never overwrite a file without it, and `remove` deletes only files with it; anything else is left alone with a warning.

### Testing on your machine

`npm test -- notify` runs the notify tests. `test/notify-shells.test.ts` runs each generated hook in a real interactive zsh, bash and fish, and skips a shell that isn't installed, so install the shell you changed (CI installs zsh and fish). `MOKKAN_TEST_BASH=/bin/bash` picks which bash to test.

Then try it for real, from a stable install (`./install.sh`, or `npm i -g .` after `npm run build`):

```
mokkan notify setup
mokkan in 1m "notify test"
mokkan notify status
mokkan notify remove
```

`mokkan notify doctor` prints what detection found (OS, session, notification service, `systemctl --user`, notifier binaries, `TERM`, tmux passthrough) and whether the baked paths still exist, with your user name, host name and home directory replaced. Paste its output into your pull request, or into an issue when something doesn't work.

### Wanted: Windows and WSL

Windows and WSL have no desktop backend yet: on WSL, mokkan installs only the prompt hook, plus the OSC escape over SSH. A backend that shows a Windows toast (for example through `powershell.exe` from WSL) would be welcome. It needs a new `BackendOs`, detection in `detectPlatform` (which treats WSL as having no desktop today), and the same argv-only rule: the text must reach PowerShell as data, never as part of the script.

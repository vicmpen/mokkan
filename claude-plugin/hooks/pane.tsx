import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MokkanMessage, MokkanMode, MokkanReminder, MokkanTab, MokkanView } from '../types'

const PANE = 'mokkan'
const COLUMNS = 44
const REFRESH_MS = 15_000
const MESSAGE_MS = 15_000
const EMPTY: MokkanView = { reminders: [], done: [], balance: null, failure: null, fetchedAt: null }
const NORMAL: MokkanMode = { kind: 'normal' }
const view = atom({ plugin: 'mokkan', key: 'view' } as const, EMPTY)
const mode = atom({ plugin: 'mokkan', key: 'mode' } as const, NORMAL)
const selected = atom({ plugin: 'mokkan', key: 'selected' } as const, null as string | null)
const tab = atom({ plugin: 'mokkan', key: 'tab' } as const, 'todos' as MokkanTab)
const message = atom({ plugin: 'mokkan', key: 'message' } as const, null as MokkanMessage)
const busy = atom({ plugin: 'mokkan', key: 'busy' } as const, null as string | null)
const syncing = atom({ plugin: 'mokkan', key: 'syncing' } as const, false)
const help = atom({ plugin: 'mokkan', key: 'help' } as const, false)
/** The states pop and dequeue take from (`mokkan list` without `--all`): never a scheduled one. */
const ACTIVE = new Set<MokkanReminder['state']>(['due', 'delivered', 'acknowledged'])
/** Pale green: the pane's own border while it holds the keys (the engine's frame takes no colour from a plugin). */
const FOCUS_BORDER = '#a8d8a8'
const DURATION = /^(?=\d)(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/
/** The tabs in `v` order, with their labels. */
const TABS: [MokkanTab, string][] = [['todos', 'TODOs'], ['reminders', 'Reminders'], ['archived', 'Archived']]
const label = (t: MokkanTab) => TABS.find(([k]) => k === t)![1]
/** The tab `v` goes to next. */
const after = (t: MokkanTab) => TABS[(TABS.findIndex(([k]) => k === t) + 1) % TABS.length]![0]
/** A tab's rows: a todo has no due time, a reminder has one; Archived is `mokkan done`. */
const rowsOf = (v: MokkanView, t: MokkanTab) =>
  t === 'archived' ? v.done : v.reminders.filter(r => (r.due_at === null) === (t === 'todos'))
/** A reminder whose time has come and that nobody has acked yet. */
const isDue = (r: MokkanReminder, now: number) => r.due_at !== null && r.state !== 'acknowledged' && Date.parse(r.due_at) <= now

/** The newest refresh; an older one's result is dropped. */
let seq = 0
/** True while a CLI action runs: every key waits for it. */
let running = false
/** The id of the last message said. */
let said = 0
/** The digit just typed while rows 10+ exist, so a second one within a second makes a two-digit row: 1 then 2 is row 12. */
let pending: { digit: number; at: number } | null = null
/** True from the pane's opening to its first good list, which picks the tab it opens on. */
let landing = false
/** The CLI's argv, looked up once per load of this module (the first refresh's three calls share the lookup). */
let resolved: Promise<string[]> | null = null
/** Whether the pane held the keys at its last draw, and when a draw last saw it let them go: a key no Button binds leaves the pane and reaches the prompt around that redraw, just before or just after it. */
let heldKeys = false
let lostAt = 0
/** A key this soon after the pane lost the keys is one that leaked; typing after Esc comes later. */
const LEAK_MS = 100

/** The CLI: this plugin's own bundle, then a dev checkout next to it, then `mokkan` on PATH. */
function cli($: EngineInterface): Promise<string[]> {
  return (resolved ??= find($))
}

async function find($: EngineInterface): Promise<string[]> {
  const root = $.plugin.root
  for (const path of [`${root}/scripts/mokkan.mjs`, `${root}/../dist/cli.js`]) {
    try {
      await $.fs.stat(path)
      return ['node', path]
    } catch {}
  }
  return ['mokkan']
}

/** `code` is the CLI's exit code: 1 a user error (logged out included), 2 the server or network; null when it never ran. */
async function run($: EngineInterface, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; code: number | null; out: string }> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run([...(await cli($)), ...args, '--json'], { timeoutMs: 15_000, env })
    return { ok: exitCode === 0, code: exitCode, out: exitCode === 0 ? stdout : (stderr || stdout).trim() }
  } catch (err) {
    return { ok: false, code: null, out: err instanceof Error ? err.message : String(err) }
  }
}

/** `/mokkan <words>`: the CLI's own text, as the slash command shows it (`--exit-zero` puts its errors on stdout too). */
async function runLine($: EngineInterface, line: string): Promise<string> {
  try {
    const { stdout } = await $.process.run([...(await cli($)), '--argline', line, '--exit-zero'], { timeoutMs: 15_000 })
    return stdout.trim() || 'No output from mokkan.'
  } catch (err) {
    return `mokkan failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Verbs that need a terminal of their own: `/mokkan` says where to run them instead. */
const TERMINAL_ONLY: Record<string, string> = {
  ui: 'mokkan ui is a full-screen view: run it in a terminal. Here, /mokkan alone opens the pane.',
  watch: 'mokkan watch runs until stopped: run it in a terminal.',
  login: 'Log in from the pane (/mokkan, then l), or run mokkan login in a terminal.',
  register: 'Register from the pane (/mokkan, then r), or run mokkan register in a terminal.',
}

const firstLine = (out: string) => out.split('\n')[0] ?? ''
const json = <T,>(out: string): T | null => {
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}
const reminders = (out: string) => (json<{ reminders: MokkanReminder[] }>(out)?.reminders ?? []).map(pick)
const pick = (r: MokkanReminder): MokkanReminder => ({
  id: r.id, text: r.text, state: r.state, due_at: r.due_at,
  created_at: r.created_at, delivered_at: r.delivered_at ?? null, acknowledged_at: r.acknowledged_at ?? null, done_at: r.done_at ?? null,
})

async function refresh($: EngineInterface): Promise<void> {
  const mine = ++seq
  await update($, syncing, () => true)
  try {
    // The heartbeat makes an open pane an active session: the server then waits for it to show what comes due.
    const [list, done, balance] = await Promise.all([run($, ['list', '--all']), run($, ['done']), run($, ['balance']), run($, ['heartbeat', '--source', 'claude-code-pane'])])
    if (mine !== seq) return
    const before = await read($, view)
    let next: MokkanView = list.ok
      ? {
          reminders: reminders(list.out),
          done: done.ok ? reminders(done.out) : before.done,
          balance: json<{ balance: number }>(balance.out)?.balance ?? before.balance,
          failure: null,
          fetchedAt: await $.clock.now(),
        }
      : list.code === 1 // a user error on a bare list: not logged in, or the session expired
        ? { ...EMPTY, failure: { kind: 'loggedOut', text: firstLine(list.out) } }
        : { ...before, failure: { kind: 'offline', text: firstLine(list.out) || 'mokkan failed' } }
    // A timed reminder that is due has been shown nowhere: toast it and mark it delivered, so the server emails it
    // only if it isn't acked within its grace period. A todo is due the moment it is pushed: never.
    const fired = list.ok ? next.reminders.filter(r => r.due_at !== null && r.state === 'due') : []
    for (const r of fired) $.ui.toast(`mokkan: due · ${r.text}`, { timeoutMs: MESSAGE_MS })
    if (fired.length > 0 && (await run($, ['deliver', ...fired.map(r => r.id)])).ok) {
      if (mine !== seq) return
      const at = new Date(await $.clock.now()).toISOString()
      next = { ...next, reminders: next.reminders.map(r => (fired.includes(r) ? { ...r, state: 'delivered', delivered_at: at } : r)) }
    }
    await update($, view, () => next)
    // It opens on Reminders while one is due, else on TODOs.
    if (list.ok && landing) {
      landing = false
      const now = await $.clock.now()
      await update($, tab, () => (next.reminders.some(r => isDue(r, now)) ? 'reminders' : 'todos'))
    }
    // A row that left the tab (archived, reopened, or moved by w) takes the selection with it.
    const [sel, tb] = await Promise.all([read($, selected), read($, tab)])
    if (sel !== null && !rowsOf(next, tb).some(r => r.id === sel)) await update($, selected, () => null)
  } finally {
    if (mine === seq) await update($, syncing, () => false)
  }
}

async function say($: EngineInterface, text: string, tone: NonNullable<MokkanMessage>['tone'] = 'ok'): Promise<void> {
  const id = ++said
  await update($, message, (): MokkanMessage => ({ text: tone === 'error' ? `error: ${text}` : text, tone, id }))
  $.clock.after(MESSAGE_MS, () => update($, message, m => (m?.id === id ? null : m)))
}

/** Runs one CLI call at a time: the header shows `verb` until it returns, and keys pressed meanwhile are dropped. */
async function work<T>($: EngineInterface, verb: string, f: () => Promise<T>): Promise<T | undefined> {
  if (running) return undefined
  running = true
  try {
    await update($, busy, () => verb)
    return await f()
  } finally {
    running = false
    await update($, busy, () => null)
  }
}

/** Runs a mutating command, reports on the status line, and refreshes the pane; true when it worked. */
async function act($: EngineInterface, verb: string, args: string[], done: string, first?: () => Promise<unknown>): Promise<boolean> {
  const ok = await work($, verb, async () => {
    await first?.()
    const r = await run($, args)
    await say($, r.ok ? done : firstLine(r.out) || 'failed', r.ok ? 'ok' : 'error')
    return r.ok
  })
  if (ok !== undefined) void refresh($)
  return ok === true
}

async function open($: EngineInterface, asked: boolean): Promise<void> {
  await $.ui.open(asked ? { id: PANE, title: 'mokkan', columns: COLUMNS, focus: true } : { id: PANE, title: 'mokkan', columns: COLUMNS })
  landing = true
  void refresh($)
}

const reveal = ($: EngineInterface, id: string) => $.ui.scroll({ in: PANE, to: { key: `row-${id}` } }).catch(() => {})


/** Display width: wide and emoji graphemes take 2 cells, East-Asian-ambiguous ones 1. */
const JOINS = /[\p{M}\u200D\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u
const FLAG = /\p{Regional_Indicator}/u
function graphemes(text: string): string[] {
  const out: string[] = []
  for (const ch of text) {
    const last = out[out.length - 1]
    if (last !== undefined && (JOINS.test(ch) || last.endsWith('\u200D') || (FLAG.test(ch) && FLAG.test(last) && [...last].length === 1))) out[out.length - 1] = last + ch
    else out.push(ch)
  }
  return out
}
function cells(g: string): number {
  if (/\p{Emoji_Presentation}|\uFE0F|\p{Regional_Indicator}/u.test(g)) return 2
  const c = g.codePointAt(0) ?? 0
  const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x20000 && c <= 0x3fffd)
  return wide ? 2 : 1
}
function fit(text: string, width: number): string {
  const gs = graphemes(text)
  if (gs.reduce((n, g) => n + cells(g), 0) <= width) return text
  let out = ''
  let used = 0
  for (const g of gs) {
    if (used + cells(g) > width - 1) break
    out += g
    used += cells(g)
  }
  return `${out}…`
}

const span = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`
}
const ago = (iso: string | null, now: number) => (iso ? ` ${span(now - Date.parse(iso))} ago` : '')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** The time column, reminders only: when it fires, how overdue it is, or how long ago it was shown. */
function when(r: MokkanReminder, now: number): string {
  if (r.due_at === null || r.state === 'done') return ''
  const at = Date.parse(r.due_at)
  const d = new Date(at)
  if (at <= now) return r.state === 'due' || r.state === 'scheduled' ? `overdue ${span(now - at)}` : `${span(now - at)} ago`
  if (at - now < 3_600_000) return `in ${Math.ceil((at - now) / 60_000)}m`
  if (d.toDateString() === new Date(now).toDateString()) return hm(d)
  if (at - now < 7 * 86_400_000) return `${DAYS[d.getDay()]} ${hm(d)}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** The mark's color is the kind (cyan a todo, magenta a reminder); its shape `·` once acked, `✓` once done, a bar before. */
type Kind = 'cyan' | 'magenta'
const kind = (r: MokkanReminder): Kind => (r.due_at === null ? 'cyan' : 'magenta')
const mark = (r: MokkanReminder): [string, boolean] =>
  r.state === 'done' ? ['✓', true] : r.state === 'acknowledged' ? ['·', true] : ['▎', false]

/** The selected row's history, `todo · added 3h ago · shown 1h ago · acked 5m ago`, in lines of `width` broken between parts. */
function detail(r: MokkanReminder, now: number, width: number): string[] {
  const parts = r.state === 'done'
    ? [`archived${ago(r.done_at, now)}`, `added${ago(r.created_at, now)}`]
    : [r.due_at === null ? 'todo' : 'reminder', `added${ago(r.created_at, now)}`, r.delivered_at && `shown${ago(r.delivered_at, now)}`, r.acknowledged_at && `acked${ago(r.acknowledged_at, now)}`]
  const lines: string[] = []
  for (const part of parts.filter((x): x is string => Boolean(x))) {
    const last = lines[lines.length - 1]
    if (last !== undefined && [...`${last} · ${part}`].length <= width) lines[lines.length - 1] = `${last} · ${part}`
    else lines.push(part)
  }
  return lines
}

const FIELD: Record<Extract<MokkanMode, { kind: 'input' }>['purpose'], { label: string; hint: string; submit: string }> = {
  push: { label: 'new todo', hint: 'what to remember · 1 credit', submit: 'add' },
  in: { label: 'new reminder', hint: '2h call the bank · 1 credit, +1 held for the email', submit: 'schedule' },
  edit: { label: 'edit', hint: 'new text · every 3rd edit costs 1 credit', submit: 'save' },
  time: { label: 'due in', hint: '2h, or clear to make it a todo', submit: 'set' },
}

/** The help view (`h`): what mokkan is, the glyphs, the acts that are easy to mix up, and the costs. */
const HELP_INTRO = 'A stack of todos and reminders that every Claude Code, Codex and terminal session shares.'
const HELP_GLYPHS: [string, Kind | 'dim', string][] = [
  ['▎', 'cyan', 'todo: a note with no time'],
  ['▎', 'magenta', 'reminder: a note with a due time'],
  ['·', 'dim', 'acked'],
  ['✓', 'dim', 'archived'],
]
const HELP_TEXT = [
  'A due reminder nobody acks is emailed to you. Ack (a) says you\'ve seen it: the email stops and it stays on the stack.',
  'TODOs and Reminders each list their own kind; v cycles the tabs. w moves a row between them: a time makes it a reminder, clear makes it a todo.',
  'Archive (d) finishes the selected one, as Enter on it does after asking. Finished ones move to Archived, where d reopens them.',
  '↑↓, Tab or a row\'s number select it: type 1 then 2 for row 12. ctrl+x tab gives the pane the keys; Esc gives them back.',
  'A todo costs 1 credit. A reminder costs 1, plus 1 held for its email and given back if you ack it first. Every 3rd edit costs 1; the rest is free.',
  'b opens Stripe Checkout to add credits. In a terminal, mokkan ui opens this full screen.',
]

/** `group`: the key hints start a new line before it, one line per kind of key. */
type Action = { label: string; hotkey: string; needsField?: true; group?: true; run: () => unknown }

export const register: Register = on => {
  let autoOpened = false
  // The password as typed, in this module alone: never in $.state, never drawn, cleared after each attempt.
  let secret = ''

  on('session.start', async ($, e, next) => {
    $.clock.every(REFRESH_MS, async () => {
      if ((await $.ui.panes()).some(p => p.id === PANE)) await refresh($)
    })
    return next(e)
  })

  // No session.start follows a /clear, /resume or /branch: an open pane reloads here instead of on the next tick.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) void refresh($)
    return next(e)
  })

  // Opens unasked only where the pane would be a sidebar: the fullscreen layout, once it reports itself.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (!autoOpened && e.viewport?.isFullscreen === true) {
      autoOpened = true
      $.clock.after(0, async () => {
        if (!(await $.ui.panes()).some(p => p.id === PANE)) await open($, false)
      })
    }
    return next(e)
  })

  // `/mokkan` alone toggles the pane; `/mokkan <verb> …` runs the CLI and shows its output, with no model turn.
  // The engine keeps the bare `/mokkan` for this plugin's skill, so typing it runs `mokkan:mokkan`: the hook answers that
  // (and a user-level `/mokkan`, should one exist). Claude still uses the skill when asked in words.
  on('command.run', { command: ['mokkan:mokkan', 'mokkan'] }, async ($, e) => {
    const line = e.args.trim()
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (line) {
      const verb = line.split(/\s+/)[0]!
      if (TERMINAL_ONLY[verb]) return { text: TERMINAL_ONLY[verb] }
      const text = await runLine($, line)
      if (isOpen) void refresh($)
      return { text }
    }
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'mokkan pane closed.' }
    }
    await open($, true)
    const { isFullscreen, columns } = e.presentation
    const where = isFullscreen ? (columns >= 110 ? 'docked beside the transcript' : `inline: the fullscreen layout docks from 110 columns, this terminal is ${columns}`) : 'inline: the main-screen layout never docks a pane'
    return { text: `mokkan pane opened, ${where}. Esc hands the keys back; ctrl+x tab takes them again. /mokkan again closes it.` }
  })

  // The engine's focus ring walks the pane (↑/↓, Tab, clicks); a row it lands on becomes the ▸ selection too.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const el = e.element
    if (el?.startsWith('row-')) {
      await update($, selected, () => el.slice(4))
      void reveal($, el.slice(4))
    }
    return next(e)
  })

  // A key no Button binds leaves the pane for the prompt: one typed while the pane held the keys is dropped, and the pane takes them back.
  // ctrl/cmd combinations and pastes go on; Esc never reaches here.
  on('prompt.edit', async ($, e, next) => {
    if (e.key === undefined || e.key.ctrl || e.key.meta || [...e.inputText].length !== 1) return next(e)
    const [panes, now] = await Promise.all([$.ui.panes(), $.clock.now()])
    const leaked = panes.some(p => p.id === PANE) && (heldKeys || (lostAt > 0 && now - lostAt < LEAK_MS))
    if (!leaked) return next(e)
    void $.ui.open({ id: PANE, title: 'mokkan', columns: COLUMNS, focus: true })
    return { text: e.text, cursor: e.cursor }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'terminal') {
      const holds = e.props.isFocused !== false
      if (heldKeys && !holds) lostAt = await $.clock.now()
      heldKeys = holds
    }
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : null // mobile has no Input
    const [v, m, sel, tb, msg, verb, sync, helping, now] = await Promise.all([
      read($, view), read($, mode), read($, selected), read($, tab), read($, message), read($, busy), read($, syncing), read($, help), $.clock.now(),
    ])
    // The terminal gets the pane's own border, two columns of the body; the remote surfaces draw their own focus.
    const framed = e.surface === 'terminal'
    const width = (e.props.bodyColumns ?? e.viewport?.columns ?? COLUMNS) - (framed ? 2 : 0)
    const docked = e.props.placement === 'dock'
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const focused = e.surface !== 'terminal' || e.props.isFocused !== false
    const loggedOut = v.failure?.kind === 'loggedOut'
    const offline = v.failure?.kind === 'offline'
    const list = rowsOf(v, tb)
    const current = list.find(r => r.id === sel)

    /** Every key goes through here: dropped while a CLI call runs; it clears the message said before it. */
    const go = <A extends unknown[]>(f: (...a: A) => unknown) => (...a: A) => {
      if (running) return
      const before = said
      void update($, message, was => (was && was.id <= before ? null : was))
      return f(...a)
    }
    const needOne = () => say($, 'select a row first (its number or ↑↓)', 'note')
    const cancel = () => { secret = ''; return update($, mode, () => NORMAL) }
    const switchView = async (to?: MokkanTab) => {
      await update($, tab, was => to ?? after(was))
      await update($, selected, () => null)
    }
    // The ring follows a click or a digit too, so ↑/↓ and ←/→ walk on from the selected row.
    const select = async (r: MokkanReminder) => {
      await update($, selected, () => r.id)
      void reveal($, r.id)
      void $.ui.focus({ requestId: PANE, key: `row-${r.id}` }).catch(() => {})
    }
    const askDone = (r: MokkanReminder) =>
      update($, mode, (): MokkanMode => ({ kind: 'confirm', action: r.state === 'done' ? 'undone' : 'done', target: r.text, targetId: r.id }))
    /** A press on the row already selected (Enter under the focus, a click, its digit) asks to finish it, or reopen it. */
    const press = (r: MokkanReminder) => (r.id === sel ? askDone(r) : select(r))
    /** A digit key selects its row at once; within a second of the one before, the two make rows 10–99. */
    const typed = async (d: number) => {
      const at = await $.clock.now()
      const was = pending
      pending = null
      const two = was && at - was.at < 1000 ? list[was.digit * 10 + d - 1] : undefined
      if (two) return select(two)
      if (d === 0) return say($, 'type 1 then 0 for row 10', 'note')
      const r = list[d - 1]
      if (!r) return
      if (list.length < d * 10) return press(r)
      const mine = pending = { digit: d, at }
      // The selected row's own digit asks only once no second digit follows it.
      if (r.id === sel) $.clock.after(1000, async () => {
        if (pending !== mine || running) return
        pending = null
        const [still, md] = await Promise.all([read($, selected), read($, mode)])
        if (still === r.id && md.kind === 'normal') await askDone(r)
      })
      return select(r)
    }
    const toggleDone = (id: string, text: string, reopen: boolean, first?: () => Promise<unknown>) => reopen
      ? act($, 'reopening…', ['undone', id], `reopened · ${text}`, first)
      : act($, 'archiving…', ['done', id], `archived · ${text}`, first)
    const field = async (purpose: 'push' | 'in' | 'edit' | 'time') => {
      const needsOne = purpose === 'edit' || purpose === 'time'
      if (needsOne && (!current || current.state === 'done')) return needOne()
      const next: MokkanMode = { kind: 'input', purpose, targetId: current?.id, value: purpose === 'edit' ? current?.text ?? '' : '' }
      await update($, mode, () => next)
      void $.ui.focus({ requestId: PANE, key: 'field' }).catch(() => {})
    }
    const confirm = async (action: 'pop' | 'dequeue' | 'logout') => {
      if (action === 'logout') {
        const r = await work($, 'checking account…', () => run($, ['status']))
        if (r === undefined) return
        const email = r.ok ? json<{ me?: { email?: string } }>(r.out)?.me?.email : undefined
        return update($, mode, (): MokkanMode => ({ kind: 'confirm', action, target: email ?? '' }))
      }
      const takes = v.reminders.filter(r => ACTIVE.has(r.state))
      const target = action === 'pop' ? takes[0] : takes[takes.length - 1]
      if (!target) return say($, 'the stack is empty', 'note')
      return update($, mode, (): MokkanMode => ({ kind: 'confirm', action, target: target.text }))
    }
    const startAuth = async (flow: 'login' | 'register') => {
      secret = ''
      await update($, mode, (): MokkanMode => ({ kind: 'auth', flow, step: 'email', email: '', otp: '', masked: '' }))
      void $.ui.focus({ requestId: PANE, key: 'auth' }).catch(() => {})
    }

    const toggleHelp = () => update($, help, was => !was)
    // As `mokkan ui`'s b: the CLI opens the checkout itself, and only a Stripe address.
    const buy = () => work($, 'opening checkout…', async () => {
      const r = await run($, ['buy'])
      if (!r.ok) return say($, firstLine(r.out) || 'failed', 'error')
      await say($, json<{ opened?: boolean }>(r.out)?.opened === true
        ? 'Opened Stripe Checkout in your browser; the balance updates after payment.'
        : 'Could not open a browser here. Run: mokkan buy --no-open (prints the link).')
    })
    const keys: Record<string, Action> = helping
      ? {
          help: { label: 'back', hotkey: 'h', run: toggleHelp },
          close: { label: 'close', hotkey: 'q', run: () => $.ui.close({ id: PANE }) },
        }
      : loggedOut
      ? {
          login: { label: 'log in', hotkey: 'l', needsField: true, run: () => startAuth('login') },
          register: { label: 'register', hotkey: 'r', needsField: true, run: () => startAuth('register') },
          refresh: { label: 'sync', hotkey: 's', run: () => refresh($) },
          help: { label: 'help', hotkey: 'h', run: toggleHelp },
          close: { label: 'close', hotkey: 'q', run: () => $.ui.close({ id: PANE }) },
        }
      // Each key is its label's first letter; a line per kind: add, the selected row, the stack, the rest.
      : {
          push: { label: 'todo', hotkey: 't', needsField: true, run: () => field('push') },
          in: { label: 'reminder', hotkey: 'r', needsField: true, run: () => field('in') },
          edit: { label: 'edit', hotkey: 'e', needsField: true, group: true, run: () => field('edit') },
          time: { label: 'when', hotkey: 'w', needsField: true, run: () => field('time') },
          done: { label: tb === 'archived' ? 'reopen' : 'archive', hotkey: 'd', run: () => (current ? toggleDone(current.id, current.text, current.state === 'done') : needOne()) },
          ack: { label: 'ack', hotkey: 'a', run: () => (current && current.state !== 'done' ? act($, 'acking…', ['ack', current.id], `acked · ${current.text}`) : needOne()) },
          // Pop and dequeue are off for now.
          // pop: { label: 'pop top', hotkey: 'p', group: true, run: () => confirm('pop') },
          // dequeue: { label: 'pop oldest', hotkey: 'o', run: () => confirm('dequeue') },
          view: { label: `view ${label(after(tb)).toLowerCase()}`, hotkey: 'v', group: true, run: () => switchView() },
          refresh: { label: 'sync', hotkey: 's', run: () => refresh($) },
          // The checkout opens on the machine running Claude Code: of no use to someone on a phone.
          ...(e.surface !== 'mobile' ? { buy: { label: 'buy', hotkey: 'b', run: () => buy() } } : {}),
          logout: { label: 'log out', hotkey: 'l', run: () => confirm('logout') },
          ...(list.length >= 10 ? { zero: { label: '10, 20…', hotkey: '0', run: () => typed(0) } } : {}),
          help: { label: 'help', hotkey: 'h', run: toggleHelp },
          close: { label: 'close', hotkey: 'q', run: () => $.ui.close({ id: PANE }) },
        }
    /** The key hints as `mokkan ui` draws its footer: `t: todo · r: reminder · …`, a line per group, wrapped to the width. */
    const hints = () => {
      const offered = Object.entries(keys).filter(([, a]) => !a.needsField || Input)
      const lines: [string, Action][][] = [[]]
      let used = 0
      for (const entry of offered) {
        const w = entry[1].hotkey.length + 2 + entry[1].label.length
        if (used > 0 && (entry[1].group || used + 3 + w > width - 1)) { lines.push([]); used = 0 }
        used += (used > 0 ? 3 : 0) + w
        lines[lines.length - 1]!.push(entry)
      }
      return (
        <Box key="legend" flexDirection="column">
          {lines.map((line, i) => (
            <Box key={`legend-${i}`}>
              <Text> </Text>
              {line.map(([key, a], j) => (
                <Box key={`cell-${key}`}>
                  {j > 0 && <Text dimColor> · </Text>}
                  <Button key={key} hotkey={a.hotkey} plain role={key === 'close' ? 'dismiss' : undefined} onPress={go(() => a.run())}>{a.label}</Button>
                </Box>
              ))}
            </Box>
          ))}
        </Box>
      )
    }

    const typedSecret = (shown: string) => {
      // The field shows bullets for what is kept; an edit is taken only at the tail (typing, pasting, backspace).
      const had = [...secret]
      const got = [...shown]
      const n = Math.min(had.length, got.length)
      const tail = got.slice(n)
      if (!got.slice(0, n).every((c, i) => c === '•' || c === had[i]) || tail.includes('•')) {
        secret = ''
        void say($, 'editing inside the password erased it; type it again', 'error')
      } else secret = had.slice(0, n).join('') + tail.join('')
      const masked = '•'.repeat([...secret].length)
      return update($, mode, was => (was.kind === 'auth' ? { ...was, masked } : was))
    }
    const authStep = async (raw: string) => {
      if (m.kind !== 'auth') return
      const text = raw.trim()
      if (m.step === 'email') {
        if (!text) return cancel()
        if (m.flow === 'login') return update($, mode, (): MokkanMode => ({ ...m, step: 'password', email: text }))
        const r = await work($, 'sending code…', () => run($, ['register', text, '--start']))
        if (!r) return
        if (!r.ok) {
          await update($, mode, (): MokkanMode => ({ ...m, email: raw }))
          return say($, firstLine(r.out) || 'could not send the code', 'error')
        }
        await say($, `code sent to ${text}`)
        return update($, mode, (): MokkanMode => ({ ...m, step: 'otp', email: text }))
      }
      if (m.step === 'otp') {
        if (!text) return cancel()
        return update($, mode, (): MokkanMode => ({ ...m, step: 'password', otp: text }))
      }
      const password = secret
      secret = ''
      if (!password) return cancel()
      const retry = () => update($, mode, was => (was.kind === 'auth' ? { ...was, masked: '' } : was))
      if (m.flow === 'register' && password.length < 10) {
        await retry()
        return say($, 'the password needs 10+ characters', 'error')
      }
      const r = await work($, m.flow === 'login' ? 'logging in…' : 'registering…', () => m.flow === 'login'
        ? run($, ['login', m.email], { MOKKAN_PASSWORD: password })
        : run($, ['register', '--complete', m.email, '--otp', m.otp], { MOKKAN_PASSWORD: password }))
      if (!r) return
      if (!r.ok) {
        await retry()
        return say($, firstLine(r.out) || `${m.flow} failed`, 'error')
      }
      await say($, `${m.flow === 'login' ? 'logged in' : 'registered and logged in'} as ${m.email}`)
      await update($, mode, () => NORMAL)
      await refresh($)
    }
    const submit = async (raw: string) => {
      if (m.kind !== 'input') return
      const text = raw.trim()
      if (!text) return cancel()
      const id = m.targetId ?? ''
      const was = v.reminders.find(r => r.id === id)
      const target = was?.text ?? ''
      const [dur = '', ...rest] = text.split(/\s+/)
      const keep = () => update($, mode, was => (was.kind === 'input' ? { ...was, value: raw } : was))
      if (m.purpose === 'in' && (!DURATION.test(dur) || rest.length === 0)) {
        await keep()
        return say($, 'start with a duration: 2h call the bank', 'error')
      }
      if (m.purpose === 'time' && text !== 'clear' && !DURATION.test(text)) {
        await keep()
        return say($, 'type a duration like 2h, or clear', 'error')
      }
      // The pane stays on its tab; a row that lands on another one says where it went.
      const [verbing, args, done]: [string, string[], string] =
        m.purpose === 'push' ? ['adding…', ['push', text], tb === 'todos' ? `added · ${text}` : `added to TODOs · ${text}`]
        : m.purpose === 'in' ? ['scheduling…', ['in', dur, rest.join(' ')], `${tb === 'reminders' ? 'scheduled' : 'added to Reminders, due'} in ${dur} · ${rest.join(' ')}`]
        : m.purpose === 'edit' ? ['saving…', ['edit', id, text], `edited · ${text}`]
        : text === 'clear' ? ['setting due…', ['edit', id, '--clear-due'], `${was?.due_at === null ? 'now a todo' : 'moved to TODOs'} · ${target}`]
        : ['setting due…', ['edit', id, '--in', text], `${was?.due_at === null ? 'moved to Reminders, due' : 'due'} in ${text} · ${target}`]
      if (await act($, verbing, args, done)) await update($, mode, () => NORMAL)
      else await keep()
    }

    const rule = <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
    // The clock time of the last good fetch, not its age: the pane redraws on changes, not by the second, so an age would go stale.
    const syncedAt = v.fetchedAt === null ? '' : `synced ${hm(new Date(v.fetchedAt))}`
    const synced = sync ? 'syncing…' : offline ? `offline${syncedAt && ` · ${syncedAt}`}` : syncedAt || 'loading…'
    const credits = v.balance === null ? '' : ` · ${v.balance} ${Math.abs(v.balance) === 1 ? 'credit' : 'credits'}`
    // At 0 the red count says it; a paid command's error then names the fix (`Run: mokkan buy`, or b here).
    const balance = v.balance === null ? '' : v.balance > 0 && v.balance < 10 ? `${credits} · low` : credits
    const wide = (text: string) => graphemes(text).reduce((n, g) => n + cells(g), 0)

    return (
      <Box flexDirection="column" minHeight={docked ? bodyRows : undefined}
        {...(framed ? { borderStyle: 'round', borderColor: focused ? FOCUS_BORDER : 'gray', borderDimColor: !focused } : {})}>
        {/* ` mokkan · 42 credits`, the views, a rule; the sync state sits at the bottom, clear of the engine's close mark. */}
        <Box>
          <Text bold> mokkan</Text>
          {!loggedOut && <Text color={v.balance === null || v.balance >= 10 ? undefined : v.balance <= 0 ? 'red' : 'yellow'} dimColor={v.balance === null || v.balance >= 10}>{balance}</Text>}
        </Box>
        {helping && <Text bold> Help</Text>}
        {!loggedOut && !helping && (
          <Box>
            <Text> </Text>
            {TABS.map(([key, name], i) => (
              <Box key={`view-${key}`}>
                {i > 0 && <Text dimColor> │ </Text>}
                <Button key={`tab-${key}`} plain dimColor={key !== tb} onPress={go(() => switchView(key))}>{`${name} ${rowsOf(v, key).length}`}</Button>
              </Box>
            ))}
          </Box>
        )}
        {rule}
        {helping ? (
          <Box key="help" flexDirection="column" paddingLeft={1}>
            <Text wrap="wrap">{HELP_INTRO}</Text>
            <Text> </Text>
            {HELP_GLYPHS.map(([glyph, tone, label]) => (
              <Box key={`glyph-${label}`}>
                <Text color={tone === 'dim' ? undefined : tone} dimColor={tone === 'dim'}>{`${glyph} `}</Text>
                <Text>{label}</Text>
              </Box>
            ))}
            {HELP_TEXT.map((text, i) => (
              <Box key={`help-${i}`} flexDirection="column">
                <Text> </Text>
                <Text wrap="wrap">{text}</Text>
              </Box>
            ))}
          </Box>
        ) : loggedOut ? (
          <Box flexDirection="column">
            <Text> Not logged in.</Text>
            {m.kind !== 'auth' && <Text dimColor>{Input ? ' l logs in, r registers.' : ' Log in from a terminal: mokkan login'}</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            {list.length === 0 && (offline && v.fetchedAt === null
              ? <Text color="red" wrap="truncate">{` ${v.failure?.text ?? ''}`}</Text>
              : tb === 'archived' ? (
                <Box flexDirection="column">
                  <Text dimColor> Nothing archived yet.</Text>
                  <Text dimColor> d archives the selected row.</Text>
                </Box>
              )
              : (
                <Box flexDirection="column">
                  <Text dimColor>{tb === 'todos' ? ' No todos.' : ' No reminders.'}</Text>
                  {Input && <Text dimColor>{tb === 'todos' ? ' t adds one.' : ' r schedules one.'}</Text>}
                </Box>
              ))}
            {list.map((r, i) => {
              const n = i + 1
              // `▸ ▎ 1: ` is 7 cells; with rows 10+ every number takes their width, ` 9: ` above `10: `.
              const digits = String(list.length).length
              const lead = 4 + digits + 2
              const isSel = r.id === sel
              const time = when(r, now)
              const [glyph, settled] = mark(r)
              // `▸ ▎ 1: text`, the time flush right; the selected row has the pointer and bold marks, as in `mokkan ui`.
              const text = fit(r.text, Math.max(4, width - lead - (time ? wide(time) + 2 : 0)))
              // No gap when an untimed row's text fills the width: one more cell would wrap the row.
              const gap = Math.max(time ? 1 : 0, width - lead - wide(text) - wide(time))
              return (
                <Box key={r.id} flexDirection="column">
                  <Box>
                    <Text bold={isSel}>{isSel ? '▸ ' : '  '}</Text>
                    <Text bold={isSel} color={kind(r)} dimColor={settled && !isSel}>{`${glyph} `}</Text>
                    {/* 1–9 are the Button's own hotkeys; 10+ draw their number, typed as two digits. */}
                    {n <= 9 ? digits > 1 && <Text>{' '.repeat(digits - 1)}</Text> : <Text bold={isSel}>{`${String(n).padStart(digits)}: `}</Text>}
                    <Button key={`row-${r.id}`} plain hotkey={n <= 9 ? String(n) : undefined} dimColor={(r.state === 'acknowledged' || r.state === 'done') && !isSel} onPress={go(() => (n <= 9 ? typed(n) : press(r)))}>
                      {text}
                    </Button>
                    {gap > 0 && <Text>{' '.repeat(gap)}</Text>}
                    {time && <Text bold={isSel} color={time.startsWith('overdue') ? 'red' : undefined} dimColor={!time.startsWith('overdue') && !isSel}>{time}</Text>}
                  </Box>
                  {isSel && detail(r, now, width - lead).map((line, j) => <Text key={`detail-${j}`} dimColor>{`${' '.repeat(lead)}${fit(line, width - lead)}`}</Text>)}
                </Box>
              )
            })}
          </Box>
        )}

        {docked && <Box flexGrow={1} />}
        {/* An error wraps, so the fix at its end (`Run: mokkan buy`) is never cut; the rest stay one line. */}
        <Box key="status" paddingLeft={1}>
          <Text color={msg ? { ok: 'green', note: 'yellow', error: 'red' }[msg.tone] : undefined} wrap={msg?.tone === 'error' ? 'wrap' : 'truncate-end'}>{msg?.text ?? ' '}</Text>
        </Box>

        {m.kind === 'input' && Input && (
          <Box flexDirection="column" paddingLeft={1}>
            <Input key="field" autoFocus label={FIELD[m.purpose].label} placeholder={FIELD[m.purpose].hint} value={m.value} submitLabel={FIELD[m.purpose].submit} onSubmit={go(submit)} />
            <Box gap={1}>
              <Button key="cancel" plain onPress={go(cancel)}>cancel</Button>
              <Text dimColor>(Tab to it, then Enter)</Text>
            </Box>
          </Box>
        )}
        {m.kind === 'auth' && Input && (
          <Box flexDirection="column" paddingLeft={1}>
            {m.step === 'email' && <Input key="auth" autoFocus label={`${m.flow} email`} placeholder="you@example.com" value={m.email} submitLabel={m.flow === 'login' ? 'next' : 'send code'} onSubmit={go(authStep)} />}
            {m.step === 'otp' && <Input key="auth" autoFocus label="one-time code" placeholder={`the code emailed to ${m.email}`} value={m.otp} submitLabel="next" onSubmit={go(authStep)} />}
            {m.step === 'password' && <Input key="auth" autoFocus label={m.flow === 'login' ? `password for ${m.email}` : 'new password (10+ characters)'} placeholder="hidden as you type" value={m.masked} submitLabel={m.flow === 'login' ? 'log in' : 'register'} onInput={typedSecret} onSubmit={go(authStep)} />}
            <Box gap={1}>
              <Button key="cancel" plain onPress={go(cancel)}>cancel</Button>
              <Text dimColor>(Tab to it, then Enter)</Text>
            </Box>
          </Box>
        )}
        {m.kind === 'confirm' && (
          <Box flexDirection="column">
            {/* The question names its target across the width, the answers their outcome below: `y: pop · n: keep`. */}
            <Text color="yellow">{m.action === 'logout'
              ? (m.target ? ` log out ${fit(m.target, width - 11)}?` : ' log out of mokkan here?')
              : m.action === 'done' ? ` archive "${fit(m.target, width - 13)}"?`
              : m.action === 'undone' ? ` reopen "${fit(m.target, width - 12)}"?`
              : ` pop "${fit(m.target, width - 9)}"?`}</Text>
            <Box>
              <Text> </Text>
              <Button key="yes" hotkey="y" plain onPress={go(() => m.action === 'logout'
                ? act($, 'logging out…', ['logout'], 'logged out', () => update($, mode, () => NORMAL))
                : m.action === 'done' || m.action === 'undone'
                ? toggleDone(m.targetId ?? '', m.target, m.action === 'undone', () => update($, mode, () => NORMAL))
                : act($, 'popping…', [m.action], `popped · ${m.target}`, () => update($, mode, () => NORMAL)))}>{m.action === 'logout' ? 'log out' : m.action === 'done' ? 'archive' : m.action === 'undone' ? 'reopen' : 'pop'}</Button>
              <Text dimColor> · </Text>
              <Button key="no" hotkey="n" plain onPress={go(() => update($, mode, () => NORMAL))}>{m.action === 'logout' ? 'stay' : 'keep'}</Button>
            </Box>
          </Box>
        )}
        {m.kind === 'normal' && (focused
          ? hints()
          : <Text dimColor> ctrl+x tab to use keys</Text>)}
        {(verb || !loggedOut) && (
          <Text key="sync" color={!verb && offline && !sync ? 'yellow' : undefined} dimColor={Boolean(verb) || !offline || sync}>{` ${verb ?? synced}`}</Text>
        )}
      </Box>
    )
  })
}

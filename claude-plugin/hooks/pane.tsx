import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MokkanMessage, MokkanMode, MokkanReminder, MokkanTab, MokkanView } from '../types'

const PANE = 'mokkan'
const COLUMNS = 44
const REFRESH_MS = 60_000
const MESSAGE_MS = 15_000
const EMPTY: MokkanView = { reminders: [], done: [], balance: null, failure: null, fetchedAt: null }
const NORMAL: MokkanMode = { kind: 'normal' }
const view = atom({ plugin: 'mokkan', key: 'view' } as const, EMPTY)
const mode = atom({ plugin: 'mokkan', key: 'mode' } as const, NORMAL)
const selected = atom({ plugin: 'mokkan', key: 'selected' } as const, null as string | null)
const tab = atom({ plugin: 'mokkan', key: 'tab' } as const, 'stack' as MokkanTab)
const message = atom({ plugin: 'mokkan', key: 'message' } as const, null as MokkanMessage)
const busy = atom({ plugin: 'mokkan', key: 'busy' } as const, null as string | null)
const syncing = atom({ plugin: 'mokkan', key: 'syncing' } as const, false)
/** The states pop and dequeue take from (`mokkan list` without `--all`): never a scheduled one. */
const ACTIVE = new Set<MokkanReminder['state']>(['due', 'delivered', 'acknowledged'])
const DURATION = /^(?=\d)(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/

/** The newest refresh; an older one's result is dropped. */
let seq = 0
/** True while a CLI action runs: every key waits for it. */
let running = false
/** The id of the last message said. */
let said = 0

/** The CLI: this plugin's own bundle, then a dev checkout next to it, then `mokkan` on PATH. */
async function cli($: EngineInterface): Promise<string[]> {
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
    const [list, done, balance] = await Promise.all([run($, ['list', '--all']), run($, ['done']), run($, ['balance'])])
    if (mine !== seq) return
    const before = await read($, view)
    const next: MokkanView = list.ok
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
    // Only a timed reminder that fired since the last look; a todo is due the moment it is pushed.
    if (before.fetchedAt !== null) {
      const wasDue = new Set(before.reminders.filter(r => r.state === 'due').map(r => r.id))
      for (const r of next.reminders) {
        if (r.due_at !== null && r.state === 'due' && !wasDue.has(r.id)) $.ui.toast(`mokkan: due · ${r.text}`)
      }
    }
    await update($, view, () => next)
    const sel = await read($, selected)
    if (sel !== null && ![...next.reminders, ...next.done].some(r => r.id === sel)) await update($, selected, () => null)
  } finally {
    if (mine === seq) await update($, syncing, () => false)
  }
}

async function say($: EngineInterface, text: string, tone: 'ok' | 'error' = 'ok'): Promise<void> {
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

/** The glyph's shape is the kind (□ a todo, the rest a reminder) and its style the state; yellow only for a fired reminder. */
const MARK: Record<MokkanReminder['state'], [string, 'dim' | 'yellow' | '']> = {
  scheduled: ['◷', 'dim'], due: ['●', 'yellow'], delivered: ['○', ''], acknowledged: ['·', 'dim'], done: ['✓', 'dim'],
}
const mark = (r: MokkanReminder): [string, 'dim' | 'yellow' | ''] =>
  r.due_at === null && r.state !== 'done' ? ['□', r.state === 'acknowledged' ? 'dim' : ''] : MARK[r.state]

function detail(r: MokkanReminder, now: number): string {
  if (r.state === 'done') return `done${ago(r.done_at, now)} · pushed${ago(r.created_at, now)}`
  return [
    `${r.due_at === null ? 'todo' : 'reminder'} · pushed${ago(r.created_at, now)}`,
    r.delivered_at && `seen${ago(r.delivered_at, now)}`,
    r.acknowledged_at && 'acked',
  ].filter(Boolean).join(' · ')
}

const FIELD: Record<Extract<MokkanMode, { kind: 'input' }>['purpose'], { label: string; hint: string; submit: string }> = {
  push: { label: 'todo', hint: 'text (1 credit)', submit: 'add' },
  in: { label: 'remind', hint: '2h call the bank (1 credit + 1 reserved)', submit: 'schedule' },
  edit: { label: 'edit', hint: 'new text (every 3rd edit costs 1)', submit: 'save' },
  time: { label: 'time', hint: '2h, or clear', submit: 'set' },
}

type Action = { label: string; hotkey: string; needsField?: true; run: () => unknown }

export const register: Register = on => {
  let autoOpened = false
  // The password as typed, in this module alone: never in $.state, never drawn, cleared after each attempt.
  let secret = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mokkan-pane', description: 'Open the mokkan reminders pane; `focus` takes the keys, `close` closes it' })
    $.clock.every(REFRESH_MS, async () => {
      if ((await $.ui.panes()).some(p => p.id === PANE)) await refresh($)
    })
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

  on('command.run', { command: 'mokkan-pane' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'mokkan pane closed.' }
    }
    if (arg === 'focus') {
      const placed = await $.ui.open({ id: PANE, title: 'mokkan', columns: COLUMNS, focus: true })
      return { text: placed.isPlaced ? 'mokkan pane focused (Esc hands the keys back).' : `mokkan pane not placed: ${placed.reason}` }
    }
    await open($, true)
    const { isFullscreen, columns } = e.presentation
    const where = isFullscreen ? (columns >= 110 ? 'docked beside the transcript' : `inline: the fullscreen layout docks from 110 columns, this terminal is ${columns}`) : 'inline: the main-screen layout never docks a pane'
    return { text: `mokkan pane opened, ${where}. Esc hands the keys back; ctrl+x tab or /mokkan-pane focus takes them again.` }
  })

  // The ▸ pointer is the selection, not the engine's inverted focus ring: a row the ring would land on becomes the
  // current one and the ring stays put; keys and tabs never take it. Only the fields and their cancel do.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const el = e.element
    if (el === undefined || el === 'field' || el === 'auth' || el === 'cancel') return next(e)
    if (el.startsWith('row-')) {
      await update($, selected, () => el.slice(4))
      void reveal($, el.slice(4))
    }
    return { deny: 'the pane marks its selection with ▸' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = e.surface !== 'mobile' && 'Input' in t ? t.Input : null // mobile has no Input
    const [v, m, sel, tb, msg, verb, sync, now] = await Promise.all([
      read($, view), read($, mode), read($, selected), read($, tab), read($, message), read($, busy), read($, syncing), $.clock.now(),
    ])
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? COLUMNS
    const docked = e.props.placement === 'dock'
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const focused = e.surface !== 'terminal' || e.props.isFocused !== false
    const loggedOut = v.failure?.kind === 'loggedOut'
    const offline = v.failure?.kind === 'offline'
    const list = tb === 'done' ? v.done : v.reminders
    const current = list.find(r => r.id === sel)

    /** Every key goes through here: dropped while a CLI call runs; it clears the message said before it. */
    const go = <A extends unknown[]>(f: (...a: A) => unknown) => (...a: A) => {
      if (running) return
      const before = said
      void update($, message, was => (was && was.id <= before ? null : was))
      return f(...a)
    }
    const needOne = () => say($, 'pick a row first (1-9 or Tab)', 'error')
    const cancel = () => { secret = ''; return update($, mode, () => NORMAL) }
    const switchView = async (to?: MokkanTab) => {
      await update($, tab, was => to ?? (was === 'stack' ? 'done' : 'stack'))
      await update($, selected, () => null)
    }
    const select = async (r: MokkanReminder) => {
      await update($, selected, () => r.id)
      void reveal($, r.id)
    }
    const toggleDone = (r: MokkanReminder) => r.state === 'done'
      ? act($, 'reopening…', ['undone', r.id], `reopened · ${r.text}`)
      : act($, 'finishing…', ['done', r.id], `done · ${r.text}`)
    const field = async (purpose: 'push' | 'in' | 'edit' | 'time') => {
      const needsOne = purpose === 'edit' || purpose === 'time'
      if (needsOne && (!current || current.state === 'done')) return needOne()
      const next: MokkanMode = { kind: 'input', purpose, targetId: current?.id, value: purpose === 'edit' ? current?.text ?? '' : '' }
      await update($, mode, () => next)
      void $.ui.focus({ requestId: PANE, key: 'field' }).catch(() => {})
    }
    const confirm = async (action: 'pop' | 'dequeue' | 'logout') => {
      if (action === 'logout') {
        const r = await work($, 'checking…', () => run($, ['status']))
        if (r === undefined) return
        const email = r.ok ? json<{ me?: { email?: string } }>(r.out)?.me?.email : undefined
        return update($, mode, (): MokkanMode => ({ kind: 'confirm', action, target: email ?? 'this machine' }))
      }
      const takes = v.reminders.filter(r => ACTIVE.has(r.state))
      const target = action === 'pop' ? takes[0] : takes[takes.length - 1]
      if (!target) return say($, 'the stack is empty')
      return update($, mode, (): MokkanMode => ({ kind: 'confirm', action, target: target.text }))
    }
    const startAuth = async (flow: 'login' | 'register') => {
      secret = ''
      await update($, mode, (): MokkanMode => ({ kind: 'auth', flow, step: 'email', email: '', otp: '', masked: '' }))
      void $.ui.focus({ requestId: PANE, key: 'auth' }).catch(() => {})
    }

    const keys: Record<string, Action> = loggedOut
      ? {
          login: { label: 'login', hotkey: 'l', needsField: true, run: () => startAuth('login') },
          register: { label: 'register', hotkey: 'g', needsField: true, run: () => startAuth('register') },
          refresh: { label: 'refresh', hotkey: 'r', run: () => refresh($) },
          close: { label: 'close', hotkey: 'c', run: () => $.ui.close({ id: PANE }) },
        }
      : {
          push: { label: 'todo', hotkey: 'p', needsField: true, run: () => field('push') },
          in: { label: 'remind', hotkey: 'i', needsField: true, run: () => field('in') },
          edit: { label: 'edit', hotkey: 'e', needsField: true, run: () => field('edit') },
          time: { label: 'time', hotkey: 't', needsField: true, run: () => field('time') },
          done: { label: 'done', hotkey: 'a', run: () => (current ? toggleDone(current) : needOne()) },
          ack: { label: 'ack', hotkey: 'k', run: () => (current && current.state !== 'done' ? act($, 'acking…', ['ack', current.id], `acknowledged · ${current.text}`) : needOne()) },
          view: { label: 'view', hotkey: 's', run: () => switchView() },
          logout: { label: 'logout', hotkey: 'o', run: () => confirm('logout') },
          pop: { label: 'pop', hotkey: 'x', run: () => confirm('pop') },
          dequeue: { label: 'dequeue', hotkey: 'd', run: () => confirm('dequeue') },
          refresh: { label: 'refresh', hotkey: 'r', run: () => refresh($) },
          close: { label: 'close', hotkey: 'c', run: () => $.ui.close({ id: PANE }) },
        }
    /** The key hints as `mokkan ui` draws its footer: `p: todo · i: remind · …`, wrapped to the width. */
    const hints = () => {
      const offered = Object.entries(keys).filter(([, a]) => !a.needsField || Input)
      const lines: [string, Action][][] = [[]]
      let used = 0
      for (const entry of offered) {
        const w = entry[1].hotkey.length + 2 + entry[1].label.length
        if (used > 0 && used + 3 + w > width - 1) { lines.push([]); used = 0 }
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
        void say($, 'edits clear the password; retype it', 'error')
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
      const [dur = '', ...rest] = text.split(/\s+/)
      const keep = () => update($, mode, was => (was.kind === 'input' ? { ...was, value: raw } : was))
      if (m.purpose === 'in' && (!DURATION.test(dur) || rest.length === 0)) {
        await keep()
        return say($, 'duration first: 2h call the bank', 'error')
      }
      if (m.purpose === 'time' && text !== 'clear' && !DURATION.test(text)) {
        await keep()
        return say($, 'a duration like 2h, or clear', 'error')
      }
      const [verbing, args, done]: [string, string[], string] =
        m.purpose === 'push' ? ['pushing…', ['push', text], `pushed · ${text}`]
        : m.purpose === 'in' ? ['scheduling…', ['in', dur, rest.join(' ')], `scheduled in ${dur}`]
        : m.purpose === 'edit' ? ['editing…', ['edit', id, text], 'edited']
        : text === 'clear' ? ['timing…', ['edit', id, '--clear-due'], 'due time cleared']
        : ['timing…', ['edit', id, '--in', text], `due in ${text}`]
      if (await act($, verbing, args, done)) await update($, mode, () => NORMAL)
      else await keep()
    }

    const rule = <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
    const synced = sync ? 'syncing…' : offline ? `offline${v.fetchedAt === null ? '' : ` · ${span(now - v.fetchedAt)} old`}` : v.fetchedAt === null ? 'loading…' : `synced ${span(now - v.fetchedAt)}`
    const balance = v.balance === null ? '' : v.balance <= 0 ? ` · ${v.balance} credits · buy` : v.balance < 10 ? ` · ${v.balance} credits · low` : ` · ${v.balance} credits`
    const wide = (text: string) => graphemes(text).reduce((n, g) => n + cells(g), 0)

    return (
      <Box flexDirection="column" minHeight={docked ? bodyRows : undefined}>
        {/* As `mokkan ui` draws it: ` mokkan · 42 credits` and the sync state across from it, the views, a rule. */}
        <Box justifyContent="space-between">
          <Box>
            <Text bold> mokkan</Text>
            {!loggedOut && <Text color={v.balance === null || v.balance >= 10 ? undefined : v.balance <= 0 ? 'red' : 'yellow'} dimColor={v.balance === null || v.balance >= 10}>{balance}</Text>}
          </Box>
          {verb ? <Text dimColor>{verb}</Text>
            : loggedOut ? <Text dimColor>logged out</Text>
            : <Text color={offline && !sync ? 'yellow' : undefined} dimColor={!offline || sync}>{synced}</Text>}
        </Box>
        {!loggedOut && (
          <Box>
            <Text> </Text>
            {(['stack', 'done'] as const).map((key, i) => (
              <Box key={`view-${key}`}>
                {i > 0 && <Text dimColor> │ </Text>}
                <Button key={`tab-${key}`} plain dimColor={key !== tb} onPress={go(() => switchView(key))}>{`${key === 'stack' ? 'Stack' : 'Done'} ${(key === 'done' ? v.done : v.reminders).length}`}</Button>
              </Box>
            ))}
          </Box>
        )}
        {rule}
        {loggedOut ? (
          <Box flexDirection="column">
            <Text> Not logged in.</Text>
            {m.kind !== 'auth' && <Text dimColor>{Input ? ' l logs in, g registers.' : ' Log in from a terminal: mokkan login'}</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            {list.length === 0 && (offline && v.fetchedAt === null
              ? <Text color="red" wrap="truncate">{` ${v.failure?.text ?? ''}`}</Text>
              : <Text dimColor>{tb === 'done' ? ' Nothing finished yet.' : ` Nothing on the stack.${Input ? ' p adds a todo, i a reminder.' : ''}`}</Text>)}
            {list.map((r, i) => {
              const n = i + 1
              const isSel = r.id === sel
              const time = when(r, now)
              const [glyph, tone] = mark(r)
              // `▸ □ 1: text`, the time flush right; the selected row has the pointer and bold marks, as in `mokkan ui`.
              const text = fit(r.text, Math.max(4, width - 7 - (time ? wide(time) + 2 : 0)))
              const gap = Math.max(1, width - 7 - wide(text) - wide(time))
              return (
                <Box key={r.id} flexDirection="column">
                  <Box>
                    <Text bold={isSel}>{isSel ? '▸ ' : '  '}</Text>
                    <Text bold={isSel} color={tone === 'yellow' ? 'yellow' : undefined} dimColor={tone === 'dim' && !isSel}>{`${glyph} `}</Text>
                    {n > 9 && <Text>{'   '}</Text>}
                    <Button key={`row-${r.id}`} plain hotkey={n <= 9 ? String(n) : undefined} dimColor={(r.state === 'acknowledged' || r.state === 'done') && !isSel} onPress={go(() => select(r))}>
                      {text}
                    </Button>
                    <Text>{' '.repeat(gap)}</Text>
                    {time && <Text bold={isSel} color={time.startsWith('overdue') ? 'red' : undefined} dimColor={!time.startsWith('overdue') && !isSel}>{time}</Text>}
                  </Box>
                  {isSel && <Text dimColor>{`       ${fit(detail(r, now), width - 7)}`}</Text>}
                </Box>
              )
            })}
          </Box>
        )}

        {docked && <Box flexGrow={1} />}
        <Box key="status">
          <Text color={msg ? (msg.tone === 'error' ? 'red' : 'green') : undefined}>{msg ? ` ${fit(msg.text, width - 1)}` : ' '}</Text>
        </Box>

        {m.kind === 'input' && Input && (
          <Box flexDirection="column">
            <Input key="field" autoFocus label={FIELD[m.purpose].label} placeholder={FIELD[m.purpose].hint} value={m.value} submitLabel={FIELD[m.purpose].submit} onSubmit={go(submit)} />
            <Box gap={1}>
              <Button key="cancel" plain onPress={go(cancel)}>cancel</Button>
              <Text dimColor>(Tab to it, then Enter)</Text>
            </Box>
          </Box>
        )}
        {m.kind === 'auth' && Input && (
          <Box flexDirection="column">
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
          <Box gap={2}>
            <Text color="yellow">{` ${m.action === 'logout' ? `log out ${fit(m.target, width - 27)}?` : `${m.action} "${fit(m.target, width - m.action.length - 21)}"?`}`}</Text>
            <Button key="yes" hotkey="y" plain onPress={go(() => m.action === 'logout'
              ? act($, 'logging out…', ['logout'], 'logged out', () => update($, mode, () => NORMAL))
              : act($, m.action === 'pop' ? 'popping…' : 'dequeuing…', [m.action], `${m.action === 'pop' ? 'popped' : 'dequeued'} · ${m.target}`, () => update($, mode, () => NORMAL)))}>yes</Button>
            <Button key="no" hotkey="n" plain onPress={go(() => update($, mode, () => NORMAL))}>no</Button>
          </Box>
        )}
        {m.kind === 'normal' && (focused
          ? hints()
          : <Text dimColor> ctrl+x tab to act</Text>)}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MokkanMessage, MokkanMode, MokkanReminder, MokkanTab, MokkanView } from '../types'

const PANE = 'mokkan'
const COLUMNS = 44
const REFRESH_MS = 60_000
const INLINE_ROWS = 6
const EMPTY: MokkanView = { reminders: [], done: [], balance: null, error: null, fetchedAt: null }
const NORMAL: MokkanMode = { kind: 'normal' }
const view = atom({ plugin: 'mokkan', key: 'view' } as const, EMPTY)
const mode = atom({ plugin: 'mokkan', key: 'mode' } as const, NORMAL)
const selected = atom({ plugin: 'mokkan', key: 'selected' } as const, null as string | null)
const tab = atom({ plugin: 'mokkan', key: 'tab' } as const, 'todo' as MokkanTab)
const message = atom({ plugin: 'mokkan', key: 'message' } as const, null as MokkanMessage)
const TABS: { key: MokkanTab; title: string }[] = [{ key: 'todo', title: 'todo' }, { key: 'timed', title: 'reminders' }, { key: 'done', title: 'done' }]

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

async function run($: EngineInterface, args: string[], env?: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run([...(await cli($)), ...args, '--json'], { timeoutMs: 15_000, env })
    return { ok: exitCode === 0, out: exitCode === 0 ? stdout : (stderr || stdout).trim() }
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

const firstLine = (out: string) => out.split('\n')[0] ?? ''
const pick = (r: MokkanReminder): MokkanReminder => ({ id: r.id, text: r.text, state: r.state, due_at: r.due_at })

async function refresh($: EngineInterface): Promise<void> {
  const [list, done, balance] = await Promise.all([run($, ['list', '--all']), run($, ['done']), run($, ['balance'])])
  const before = await read($, view)
  const next: MokkanView = { ...before, fetchedAt: await $.clock.now() }
  if (list.ok) {
    next.reminders = (JSON.parse(list.out) as { reminders: MokkanReminder[] }).reminders.map(pick)
    next.done = done.ok ? (JSON.parse(done.out) as { reminders: MokkanReminder[] }).reminders.map(pick) : []
    next.error = null
  } else {
    // Logged out or offline: what was drawn is no longer known to be true.
    next.reminders = []
    next.done = []
    next.balance = null
    next.error = firstLine(list.out) || 'mokkan failed'
  }
  if (balance.ok) next.balance = (JSON.parse(balance.out) as { balance: number }).balance
  const wasDue = new Set(before.reminders.filter(r => r.state === 'due').map(r => r.id))
  for (const r of next.reminders) {
    if (r.state === 'due' && !wasDue.has(r.id) && before.fetchedAt !== null) $.ui.toast(`mokkan: due · ${r.text}`)
  }
  await update($, view, () => next)
  const sel = await read($, selected)
  if (sel !== null && ![...next.reminders, ...next.done].some(r => r.id === sel)) await update($, selected, () => null)
}

const say = ($: EngineInterface, text: string, tone: 'ok' | 'error' = 'ok') => update($, message, (): MokkanMessage => ({ text, tone }))

/** Runs a mutating command, reports on the status line, and refreshes the pane. */
async function act($: EngineInterface, args: string[], done: string): Promise<void> {
  const r = await run($, args)
  await say($, r.ok ? done : firstLine(r.out) || 'failed', r.ok ? 'ok' : 'error')
  await update($, mode, () => NORMAL)
  await refresh($)
}

async function open($: EngineInterface, asked: boolean): Promise<void> {
  await refresh($)
  await $.ui.open(asked ? { id: PANE, title: 'mokkan', columns: COLUMNS, focus: true } : { id: PANE, title: 'mokkan', columns: COLUMNS })
}

const glyph: Record<MokkanReminder['state'], string> = {
  scheduled: '◷', due: '●', delivered: '○', acknowledged: '·', done: '✓',
}

function dueLabel(iso: string | null, now: number): string {
  if (!iso) return ''
  const mins = Math.round((Date.parse(iso) - now) / 60_000)
  if (Math.abs(mins) < 60) return `${mins}m`
  if (Math.abs(mins) < 60 * 48) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

function fit(text: string, width: number): string {
  const chars = [...text]
  return chars.length <= width ? text : `${chars.slice(0, Math.max(1, width - 1)).join('')}…`
}

const FIELD: Record<Extract<MokkanMode, { kind: 'input' }>['purpose'], { label: string; hint: string }> = {
  push: { label: 'push', hint: 'text (1 credit)' },
  in: { label: 'in', hint: '2h text (1 credit + 1 reserved)' },
  edit: { label: 'edit', hint: 'new text (every 3rd edit costs 1)' },
  time: { label: 'due', hint: 'duration like 2h, or clear' },
}

const isLoggedOut = (v: MokkanView) => v.error !== null && /log ?in|logged/i.test(v.error)

type Action = { label: string; hotkey?: string; needsField?: true; run: () => unknown }

export const register: Register = on => {
  let autoOpened = false
  // The password as typed, in this module alone: never in $.state, never drawn, cleared after each attempt.
  let secret = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mokkan-pane', description: 'Open the mokkan reminders pane; `focus` takes the keys, `close` closes it' })
    $.clock.every(REFRESH_MS, () => refresh($))
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

  // The focus ring is the pointer: landing on a row makes it the current one.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.element?.startsWith('row-')) await update($, selected, () => e.element!.slice(4))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e)
    const { Box, Text, Button } = t
    const Input = 'Input' in t ? t.Input : null // mobile has no Input
    const [v, m, sel, tb, msg, now] = await Promise.all([read($, view), read($, mode), read($, selected), read($, tab), read($, message), $.clock.now()])
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? COLUMNS
    const docked = e.props.placement === 'dock'
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const room = docked ? Math.max(1, bodyRows - 9) : INLINE_ROWS
    const loggedOut = isLoggedOut(v)

    const inTab = (key: MokkanTab) => key === 'done' ? v.done : v.reminders.filter(r => (key === 'todo') === (r.due_at === null))
    const rows = inTab(tb).slice(0, room).map((r, i) => ({ r, n: i + 1 }))
    const current = [...v.reminders, ...v.done].find(r => r.id === sel)
    const switchTab = (to?: MokkanTab) => update($, tab, was => to ?? TABS[(TABS.findIndex(x => x.key === was) + 1) % TABS.length]!.key)
    const needOne = () => say($, 'point at a reminder first (arrows or 1-9)', 'error')
    const cancel = () => { secret = ''; return update($, mode, () => NORMAL) }
    const toggleDone = (r: MokkanReminder) => r.state === 'done'
      ? act($, ['undone', r.id], `reopened · ${fit(r.text, 30)}`)
      : act($, ['done', r.id], `done · ${fit(r.text, 30)}`)
    /** A row's press: the first points at it, the second (Enter or its digit again) toggles done. */
    const pressRow = async (r: MokkanReminder) => {
      if ((await read($, selected)) === r.id) return toggleDone(r)
      await update($, selected, () => r.id)
    }
    const field = async (purpose: 'push' | 'in' | 'edit' | 'time') => {
      const needsOne = purpose === 'edit' || purpose === 'time'
      if (needsOne && (!current || current.state === 'done')) return needOne()
      const next: MokkanMode = { kind: 'input', purpose, targetId: current?.id, value: purpose === 'edit' ? current?.text ?? '' : '' }
      await update($, mode, () => next)
      void $.ui.focus({ requestId: PANE, key: 'field' }).catch(() => {})
    }
    const startAuth = async (flow: 'login' | 'register') => {
      secret = ''
      await update($, mode, (): MokkanMode => ({ kind: 'auth', flow, step: 'email', email: '', otp: '', masked: '' }))
      void $.ui.focus({ requestId: PANE, key: 'auth' }).catch(() => {})
    }

    const actions: Record<string, Action> = loggedOut
      ? {
          login: { label: 'login', hotkey: 'l', needsField: true, run: () => startAuth('login') },
          register: { label: 'register', hotkey: 'g', needsField: true, run: () => startAuth('register') },
          refresh: { label: 'refresh', hotkey: 'r', run: () => refresh($) },
          close: { label: 'close', hotkey: 'c', run: () => $.ui.close({ id: PANE }) },
        }
      : {
          push: { label: 'push', hotkey: 'p', needsField: true, run: () => field('push') },
          in: { label: 'schedule', hotkey: 'i', needsField: true, run: () => field('in') },
          edit: { label: 'edit', hotkey: 'e', needsField: true, run: () => field('edit') },
          time: { label: 'due', hotkey: 't', needsField: true, run: () => field('time') },
          done: { label: 'done', hotkey: 'a', run: () => (current ? toggleDone(current) : needOne()) },
          ack: { label: 'ack', hotkey: 'k', run: () => (current && current.state !== 'done' ? act($, ['ack', current.id], `acknowledged · ${fit(current.text, 30)}`) : needOne()) },
          pop: { label: 'pop', hotkey: 'x', run: () => update($, mode, (): MokkanMode => ({ kind: 'confirm', action: 'pop' })) },
          dequeue: { label: 'dequeue', hotkey: 'd', run: () => update($, mode, (): MokkanMode => ({ kind: 'confirm', action: 'dequeue' })) },
          switch: { label: 'tab', hotkey: 's', run: () => switchTab() },
          refresh: { label: 'refresh', hotkey: 'r', run: () => refresh($) },
          logout: { label: 'logout', run: () => act($, ['logout'], 'logged out') },
          close: { label: 'close', hotkey: 'c', run: () => $.ui.close({ id: PANE }) },
        }
    const offered = Object.entries(actions).filter(([, a]) => !a.needsField || Input)
    const cell = Math.max(9, Math.floor(width / 4))

    const typedSecret = (shown: string) => {
      // The field shows bullets; what changed is the tail: longer appends the new characters, shorter truncates.
      if (shown.length < secret.length) secret = secret.slice(0, shown.length)
      else secret += shown.slice(secret.length)
      const masked = '•'.repeat(secret.length)
      return update($, mode, was => (was.kind === 'auth' ? { ...was, masked } : was))
    }
    const authStep = async (raw: string) => {
      if (m.kind !== 'auth') return
      const text = raw.trim()
      if (m.step === 'email') {
        if (!text) return cancel()
        if (m.flow === 'login') return update($, mode, (): MokkanMode => ({ ...m, step: 'password', email: text }))
        const r = await run($, ['register', text, '--start'])
        if (!r.ok) return say($, firstLine(r.out) || 'could not send the code', 'error')
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
      if (m.flow === 'register' && password.length < 10) {
        await say($, 'the password needs at least 10 characters', 'error')
        return update($, mode, was => (was.kind === 'auth' ? { ...was, masked: '' } : was))
      }
      const r = m.flow === 'login'
        ? await run($, ['login', m.email], { MOKKAN_PASSWORD: password })
        : await run($, ['register', '--complete', m.email, '--otp', m.otp], { MOKKAN_PASSWORD: password })
      await say($, r.ok ? `${m.flow === 'login' ? 'logged in' : 'registered and logged in'} as ${m.email}` : firstLine(r.out) || `${m.flow} failed`, r.ok ? 'ok' : 'error')
      await update($, mode, () => NORMAL)
      await refresh($)
    }
    const submit = async (raw: string) => {
      if (m.kind !== 'input') return
      const text = raw.trim()
      if (!text) return cancel()
      const id = m.targetId ?? ''
      switch (m.purpose) {
        case 'push': return act($, ['push', text], `pushed · ${fit(text, 30)}`)
        case 'in': {
          const [dur, ...rest] = text.split(/\s+/)
          if (!dur || rest.length === 0) return say($, 'write a duration then the text, like `2h call the bank`', 'error')
          return act($, ['in', dur, rest.join(' ')], `scheduled in ${dur}`)
        }
        case 'edit': return act($, ['edit', id, text], 'edited')
        case 'time': return act($, text === 'clear' ? ['edit', id, '--clear-due'] : ['edit', id, '--in', text], text === 'clear' ? 'due time cleared' : `due in ${text}`)
      }
    }

    const legend = (
      <Box flexDirection="column">
        {Array.from({ length: Math.ceil(offered.length / 4) }, (_, i) => offered.slice(i * 4, i * 4 + 4)).map((group, i) => (
          <Box key={`legend-${i}`}>
            {group.map(([key, a]) => (
              <Box key={`cell-${key}`} width={cell}>
                <Button key={key} hotkey={a.hotkey} plain role={key === 'close' ? 'dismiss' : undefined} onPress={() => a.run()}>{a.label}</Button>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" minHeight={docked ? bodyRows : undefined}>
        <Box justifyContent="space-between">
          <Text bold>mokkan</Text>
          {loggedOut
            ? <Text dimColor>logged out</Text>
            : <Text dimColor={v.balance === null || v.balance >= 10} color={v.balance !== null && v.balance < 10 ? 'yellow' : undefined}>{v.balance === null ? '' : `${v.balance} cr`}</Text>}
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
        {loggedOut ? (
          <Box flexDirection="column">
            <Text color="red" wrap="truncate">{v.error}</Text>
            {m.kind !== 'auth' && <Text dimColor>l logs in, g registers a new account.</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            {v.error && <Text color="red" wrap="truncate">{v.error}</Text>}
            <Box gap={2}>
              {TABS.map(({ key, title }) => (
                <Button key={`tab-${key}`} plain dimColor={key !== tb} onPress={() => switchTab(key)}>{key === tb ? `[${title} ${inTab(key).length}]` : `${title} ${inTab(key).length}`}</Button>
              ))}
            </Box>
            {!v.error && rows.length === 0 && <Text dimColor>{tb === 'done' ? 'Nothing finished yet.' : v.reminders.length === 0 ? 'Nothing on the stack.' : 'Nothing here; s switches tab.'}</Text>}
            {rows.map(({ r, n }) => {
              const due = r.due_at && r.state !== 'done' ? dueLabel(r.due_at, now) : ''
              const textWidth = Math.max(8, width - 5 - (due ? due.length + 1 : 0))
              return (
                <Box key={r.id} justifyContent="space-between">
                  <Box>
                    {/* The cursor: a pointer in the gutter and a bold row, no highlight bar. */}
                    <Text bold={r.id === sel}>{r.id === sel ? '▸' : ' '}</Text>
                    <Text dimColor>{n <= 9 ? String(n) : ' '}</Text>
                    <Text color={r.state === 'due' ? 'yellow' : undefined} dimColor={r.state === 'scheduled' || r.state === 'acknowledged'}>{` ${glyph[r.state]} `}</Text>
                    <Button key={`row-${r.id}`} plain hotkey={n <= 9 ? String(n) : undefined} dimColor={(r.state === 'acknowledged' || r.state === 'done') && r.id !== sel} onPress={() => pressRow(r)}>
                      {fit(r.text, textWidth)}
                    </Button>
                  </Box>
                  {due && <Text dimColor>{due}</Text>}
                </Box>
              )
            })}
            {inTab(tb).length > room && <Text dimColor>… {inTab(tb).length - room} more</Text>}
          </Box>
        )}

        {docked && <Box flexGrow={1} />}
        <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>

        {m.kind === 'input' && Input && (
          <Box flexDirection="column">
            <Input key="field" autoFocus label={FIELD[m.purpose]?.label} placeholder={FIELD[m.purpose]?.hint} value={m.value} submitLabel={FIELD[m.purpose]?.label} onSubmit={submit} />
            <Box gap={1}>
              <Button key="cancel" plain onPress={cancel}>cancel</Button>
              <Text dimColor>(Tab to it, then Enter)</Text>
            </Box>
          </Box>
        )}
        {m.kind === 'auth' && Input && (
          <Box flexDirection="column">
            {m.step === 'email' && <Input key="auth" autoFocus label={`${m.flow} email`} placeholder="you@example.com" value={m.email} submitLabel={m.flow === 'login' ? 'next' : 'send code'} onSubmit={authStep} />}
            {m.step === 'otp' && <Input key="auth" autoFocus label="one-time code" placeholder={`the code emailed to ${m.email}`} value={m.otp} submitLabel="next" onSubmit={authStep} />}
            {m.step === 'password' && <Input key="auth" autoFocus label={m.flow === 'login' ? `password for ${m.email}` : 'new password (10+ characters)'} placeholder="hidden as you type" value={m.masked} submitLabel={m.flow} onInput={typedSecret} onSubmit={authStep} />}
            <Box gap={1}>
              <Button key="cancel" plain onPress={cancel}>cancel</Button>
              <Text dimColor>(Tab to it, then Enter)</Text>
            </Box>
          </Box>
        )}
        {m.kind === 'confirm' && (
          <Box gap={1}>
            <Text>{m.action} {m.action === 'pop' ? 'the top' : 'the bottom'} reminder?</Text>
            <Button key="yes" hotkey="y" plain variant="primary" onPress={() => act($, [m.action], m.action === 'pop' ? 'popped' : 'dequeued')}>yes</Button>
            <Button key="no" hotkey="n" plain onPress={() => update($, mode, () => NORMAL)}>no</Button>
          </Box>
        )}
        {m.kind === 'normal' && (
          <Box flexDirection="column">
            <Box key="status">
              <Text color={msg?.tone === 'error' ? 'red' : undefined} dimColor={!msg || msg.tone === 'ok'} wrap="truncate">{msg ? msg.text : ' '}</Text>
            </Box>
            {legend}
          </Box>
        )}
      </Box>
    )
  })
}

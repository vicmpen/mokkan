import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString()
const A = 'a1a1a1a1-0000-4000-8000-000000000001'
const B = 'b2b2b2b2-0000-4000-8000-000000000002'
const C = 'c3c3c3c3-0000-4000-8000-000000000003'
const D = 'd4d4d4d4-0000-4000-8000-000000000004'
const E = 'e5e5e5e5-0000-4000-8000-000000000005'
const row = (id: string, text: string, state: string, due: number | null, more: Record<string, unknown> = {}) => ({
  id, text, state, position: 0, due_at: due === null ? null : at(due), created_at: at(-180), delivered_at: null, acknowledged_at: null, done_at: null, ...more,
})
const STACK = () => [
  row(A, 'renew the TLS cert', 'delivered', null, { delivered_at: at(-60) }),
  row(B, 'call the bank', 'due', -40),
  row(C, 'ask Maria re notes', 'scheduled', 40),
  row(D, 'water the plants', 'delivered', -120, { delivered_at: at(-110) }),
]
const DONE = () => [row(E, 'renew the domain', 'done', null, { created_at: at(-1440), done_at: at(-120) })]
const BALANCE = JSON.stringify({ balance: 42, ledger: [] })
const result = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
const OK = (stdout: string) => result(0, stdout)

const PANE = {
  component: 'Pane',
  requestId: 'mokkan',
  props: { title: 'mokkan', isFocused: true, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

function fakeCli(on: On) {
  const clock = mock.clock(on, { now: NOW })
  const panes: { id: string }[] = []
  const toasts: string[] = []
  const toastMs: (number | undefined)[] = []
  const commands: Record<string, unknown>[] = []
  let stats = 0
  on('ui.open', (_, e) => { if (!panes.some(p => p.id === e.id)) panes.push({ id: e.id }); return { value: { isPlaced: true } } })
  on('ui.panes', () => ({ value: panes.map(p => ({ ...p, title: 'mokkan', isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.toast', (_, e) => { toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e))); toastMs.push((e as { timeoutMs?: number }).timeoutMs); return { value: undefined } })
  on('ui.focus', () => ({}))
  on('command.register', (_, e) => { commands.push({ ...e }); return { value: { command: e.name } } })
  on('fs.stat', () => { stats++; return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } })
  const ran: string[][] = []
  const envs: Record<string, string>[] = []
  const session = { loggedIn: true, offline: false, opens: true, stack: STACK(), done: DONE(), fail: {} as Record<string, string>, slow: {} as Record<string, number> }
  on('process.run', async (_, e) => {
    ran.push([...e.argv])
    envs.push(e.init?.env ?? {})
    const cmd = e.argv[2] ?? ''
    const stack = session.stack
    if (session.slow[cmd]) await clock.sleep(session.slow[cmd]!)
    if (session.fail[cmd]) return result(1, '', `${session.fail[cmd]}\n`)
    if (session.offline) return result(2, '', 'Could not reach the server.\n')
    if (cmd === 'register' && e.argv.includes('--complete')) { session.loggedIn = true; return OK('Registered and logged in.\n') }
    if (cmd === 'register') return OK('One-time code sent.\n')
    if (cmd === 'login') { session.loggedIn = true; return OK('{}') }
    if (cmd === 'logout') { session.loggedIn = false; return OK('{}') }
    if (!session.loggedIn) return result(1, '', 'Not logged in. Run: mokkan login\n')
    if (cmd === 'status') return OK(JSON.stringify({ me: { email: 'vic@example.com' } }))
    if (cmd === 'list') return OK(JSON.stringify({ version: 1, reminders: stack }))
    if (cmd === 'done' && e.argv.length === 4) return OK(JSON.stringify({ version: 1, reminders: session.done })) // bare `done --json`: the history
    if (cmd === 'balance') return OK(BALANCE)
    if (cmd === 'buy') return OK(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_x', session_id: 'cs_x', opened: session.opens }))
    if (cmd === 'done') return OK(JSON.stringify({ done: [e.argv[3]] }))
    if (cmd === 'undone') return OK(JSON.stringify({ reopened: [e.argv[3]] }))
    if (cmd === 'push') stack.unshift(row('f6f6f6f6-0000-4000-8000-000000000006', e.argv[3] ?? '', 'due', null))
    return OK(JSON.stringify({ version: 2 }))
  })
  return { ran, session, envs, clock, toasts, toastMs, commands, panes, stats: () => stats }
}

type Found = { text: string; props: Record<string, unknown> }
type Ui = { find: (q: { key?: string; type?: string; text?: string | RegExp }) => Promise<Found | undefined>; findAll: (q: { type?: string }) => Promise<Found[]> }
const status = async (ui: Ui) => (await ui.find({ key: 'status' }))?.text.trim()
const shows = async (ui: Ui, text: string | RegExp) => (await ui.findAll({ type: 'Text' })).some(t => (typeof text === 'string' ? t.text.trim() === text : text.test(t.text)))

async function opened($: Engine, clock: { settle: () => Promise<void> }) {
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
  await clock.settle()
}

test('todos and reminders read apart: glyph, color and time column; the selected row has its detail line', async ($, on) => {
  const { ran, clock } = fakeCli(on)
  await opened($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mokkan', surface, ...PANE })
    expect(await shows(ui, '· 42 credits')).toBe(true)
    expect((await ui.find({ key: 'tab-stack' }))?.text).toBe('Stack 4')
    expect((await ui.find({ key: 'tab-done' }))?.text).toBe('Done 1')
    expect(await shows(ui, /^ synced \d\d:\d\d$/)).toBe(true) // the clock time of the last sync, on the bottom line

    // The Button draws `1: `; the text carries no digit of its own.
    const first = await ui.find({ key: `row-${A}` })
    expect(first?.text).toBe('renew the TLS cert')
    expect(first?.props.hotkey).toBe('1')

    expect(await shows(ui, '□')).toBe(true)
    expect((await ui.find({ type: 'Text', text: '● ' }))?.props.color).toBe('yellow')
    expect((await ui.find({ type: 'Text', text: '◷ ' }))?.props.dimColor).toBe(true)
    expect(await shows(ui, '○')).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'overdue 40m' }))?.props.color).toBe('red')
    expect((await ui.find({ type: 'Text', text: 'in 40m' }))?.props.dimColor).toBe(true)
    expect(await shows(ui, '2h ago')).toBe(true)
    expect(await shows(ui, /todo ·/)).toBe(false) // no detail line before a row is selected

    await ui.press({ key: `row-${A}` })
    expect(await shows(ui, '▸')).toBe(true)
    expect(await shows(ui, /^ +todo · added 3h ago · shown 1h ago$/)).toBe(true)
    await ui.press({ key: `row-${B}` })
    expect(await shows(ui, /^ +reminder · added 3h ago$/)).toBe(true)

    await ui.press({ key: 'view' })
    await ui.press({ key: `row-${E}` })
    expect(await shows(ui, '✓')).toBe(true)
    expect(await shows(ui, /^ +done 2h ago · added 1d ago$/)).toBe(true)
    await ui.press({ key: 'tab-stack' })
    await ui.unmount()
  }
  expect(ran.some(a => a[2] === 'done' && a.length > 4)).toBe(false) // selecting never finishes
})

test('d toggles done on the selected one, and in the done view reopens it; a acknowledges', async ($, on) => {
  const { ran, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: `row-${A}` })
  expect(ran.some(a => a[2] === 'done' && a[3] === A)).toBe(false)
  await ui.press({ key: 'done' })
  expect(ran.some(a => a[2] === 'done' && a[3] === A)).toBe(true)
  expect(await status(ui)).toBe('done · renew the TLS cert')

  await ui.press({ key: 'view' })
  await ui.press({ key: `row-${E}` })
  await ui.press({ key: 'done' })
  expect(ran.some(a => a[2] === 'undone' && a[3] === E)).toBe(true)
  expect(await status(ui)).toBe('reopened · renew the domain')

  await ui.press({ key: 'view' })
  await ui.press({ key: `row-${B}` })
  await ui.press({ key: 'ack' })
  expect(ran.some(a => a[2] === 'ack' && a[3] === B)).toBe(true)
  expect(await status(ui)).toBe('acked · call the bank')
  await ui.unmount()
})

test('Enter on the selected row asks to mark it done, and in the done view to reopen it', async ($, on) => {
  const { ran, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: `row-${A}` }) // selects
  expect(await ui.find({ key: 'yes' })).toBeUndefined()
  await ui.press({ key: `row-${A}` }) // Enter on it: asks
  expect(await shows(ui, 'mark "renew the TLS cert" done?')).toBe(true)
  expect((await ui.find({ key: 'yes' }))?.text).toBe('done')
  expect((await ui.find({ key: 'no' }))?.text).toBe('keep')
  await ui.press({ key: 'no' })
  expect(ran.some(a => a[2] === 'done' && a[3] === A)).toBe(false)
  await ui.press({ key: `row-${A}` })
  await ui.press({ key: 'yes' })
  expect(ran.some(a => a[2] === 'done' && a[3] === A)).toBe(true)
  expect(await status(ui)).toBe('done · renew the TLS cert')
  expect(await ui.find({ key: 'yes' })).toBeUndefined()

  await ui.press({ key: 'view' })
  await ui.press({ key: `row-${E}` })
  await ui.press({ key: `row-${E}` })
  expect(await shows(ui, 'reopen "renew the domain"?')).toBe(true)
  expect((await ui.find({ key: 'yes' }))?.text).toBe('reopen')
  await ui.press({ key: 'yes' })
  expect(ran.some(a => a[2] === 'undone' && a[3] === E)).toBe(true)
  expect(await status(ui)).toBe('reopened · renew the domain')
  await ui.unmount()
})

test('push and edit run the CLI; the field label is not its submit label', async ($, on) => {
  const { ran, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'push' })
  const field = await ui.find({ key: 'field' })
  expect(field?.props.label).toBe('new todo')
  expect(field?.props.submitLabel).toBe('add')
  await ui.input({ key: 'field', text: 'milk' })
  expect(ran.some(a => a[2] === 'push' && a[3] === 'milk')).toBe(true)
  expect(await status(ui)).toBe('added · milk')
  expect(await ui.find({ key: 'field' })).toBeUndefined()

  await ui.press({ key: 'edit' }) // nothing selected yet
  expect(await status(ui)).toBe('select a row first (its number or ↑↓)')
  await ui.press({ key: `row-${A}` })
  expect(await status(ui)).toBeFalsy() // the next key cleared it
  await ui.press({ key: 'edit' })
  expect((await ui.find({ key: 'field' }))?.props.value).toBe('renew the TLS cert')
  await ui.input({ key: 'field', text: 'renew the TLS cert today' })
  expect(ran.some(a => a[2] === 'edit' && a[3] === A && a[4] === 'renew the TLS cert today')).toBe(true)
  await ui.unmount()
})

test('errors show on the status line in field mode, and the field keeps what was typed', async ($, on) => {
  const { ran, session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'in' })
  await ui.input({ key: 'field', text: 'soon call the bank' })
  const bad = await status(ui)
  expect(bad).toBe('error: start with a duration: 2h call the bank')
  expect((await ui.find({ type: 'Text', text: bad! }))?.props.wrap).toBe('wrap') // an error wraps to the width instead of being cut
  expect((await ui.find({ key: 'status' }))?.props).toBeDefined()
  expect(await ui.find({ type: 'Text', text: bad! })).toMatchObject({ props: { color: 'red' } })
  expect((await ui.find({ key: 'field' }))?.props.value).toBe('soon call the bank')
  expect(ran.some(a => a[2] === 'in')).toBe(false)

  session.fail.in = 'Not enough credits.'
  await ui.input({ key: 'field', text: '2h call the bank' })
  expect(ran.some(a => a[2] === 'in' && a[3] === '2h')).toBe(true)
  expect(await status(ui)).toBe('error: Not enough credits.')
  expect((await ui.find({ key: 'field' }))?.props.value).toBe('2h call the bank')

  delete session.fail.in
  await ui.input({ key: 'field', text: '2h call the bank' })
  expect(await ui.find({ key: 'field' })).toBeUndefined()
  expect(await status(ui)).toBe('scheduled in 2h · call the bank')

  // A message clears itself after 15 s.
  await clock.advance(15_000)
  expect(await status(ui)).toBeFalsy()

  await ui.press({ key: `row-${B}` })
  await ui.press({ key: 'time' })
  await ui.input({ key: 'field', text: 'later' })
  expect(await status(ui)).toBe('error: type a duration like 2h, or clear')
  expect((await ui.find({ key: 'field' }))?.props.value).toBe('later')
  await ui.unmount()
})

test('busy: the header shows the verb, y leaves the confirm at once, and keys wait for the call', async ($, on) => {
  const { ran, session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'pop' })
  expect(await shows(ui, 'pop "renew the TLS cert"?')).toBe(true)
  session.slow.pop = 1000
  const popping = ui.press({ key: 'yes' }) // the pop sleeps on the clock until it advances
  await clock.settle()
  expect(await shows(ui, 'popping…')).toBe(true)
  expect(await shows(ui, /^synced/)).toBe(false)
  expect(await ui.find({ key: 'yes' })).toBeUndefined()

  await ui.press({ key: 'pop' }) // ignored while busy
  expect(await ui.find({ key: 'yes' })).toBeUndefined()
  await ui.press({ key: 'push' })
  expect(await ui.find({ key: 'field' })).toBeUndefined()

  await clock.advance(1000)
  await popping
  expect(ran.filter(a => a[2] === 'pop')).toHaveLength(1)
  expect(await shows(ui, 'popping…')).toBe(false)
  expect(await status(ui)).toBe('popped · renew the TLS cert')
  await ui.unmount()
})

test('dequeue and logout confirms name their target; an empty stack answers without a confirm', async ($, on) => {
  const { ran, session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'dequeue' })
  expect(await shows(ui, 'pop "water the plants"?')).toBe(true) // the bottom one; scheduled ones are not taken
  expect((await ui.find({ key: 'yes' }))?.text).toBe('pop') // the answers name their outcome
  expect((await ui.find({ key: 'no' }))?.text).toBe('keep')
  await ui.press({ key: 'no' })
  expect(ran.some(a => a[2] === 'dequeue')).toBe(false)

  await ui.press({ key: 'logout' })
  expect(await shows(ui, 'log out vic@example.com?')).toBe(true)
  expect((await ui.find({ key: 'yes' }))?.text).toBe('log out')
  await ui.press({ key: 'no' })

  session.stack = [row(C, 'ask Maria re notes', 'scheduled', 40)]
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'pop' })
  expect(await status(ui)).toBe('the stack is empty')
  expect(await ui.find({ key: 'yes' })).toBeUndefined()
  await ui.unmount()
})

test('every row is reachable: no cut-off, digits on the first nine, the focus ring selects any row it lands on', async ($, on) => {
  const { session, clock } = fakeCli(on)
  session.stack = Array.from({ length: 14 }, (_, i) => row(`0000000${i.toString(16)}-0000-4000-8000-000000000000`, `todo number ${i + 1}`, 'due', null))
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 10 } } })

  const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('row-'))
  expect(rows).toHaveLength(14)
  expect(rows.map(b => b.props.hotkey)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', undefined, undefined, undefined, undefined, undefined])

  const last = rows[13]!.key!
  const ring = await $.ui.focus({ component: 'Pane', requestId: 'mokkan', plugin: 'mokkan', element: last, origin: { kind: 'person' } })
  expect(ring.deny).toBeUndefined() // the ring lands on the row, and the row is selected
  expect(await ui.find({ type: 'Text', text: '▸ ' })).toBeDefined()
  expect(await shows(ui, /^ +todo · added/)).toBe(true)
  await ui.press({ key: rows[12]!.key! }) // a click on a row past the ninth
  expect(await shows(ui, /^ +todo · added/)).toBe(true)

  // Rows 10+ show their number and are typed as two digits; 0 joins the keys for 10, 20.
  expect(await shows(ui, '14:')).toBe(true)
  const selected = async () => {
    const all = await ui.findAll({})
    const at = all.findIndex(x => x.text === '▸ ')
    return all.slice(at).find(x => x.key?.startsWith('row-'))?.text
  }
  await ui.press({ key: rows[0]!.key! }) // 1
  expect(await selected()).toBe('todo number 1')
  await ui.press({ key: 'zero' }) // then 0: row 10
  expect(await selected()).toBe('todo number 10')
  await ui.press({ key: rows[0]!.key! }); await ui.press({ key: rows[3]!.key! }) // 1, 4: row 14
  expect(await selected()).toBe('todo number 14')
  await ui.press({ key: rows[0]!.key! }); await clock.advance(1500); await ui.press({ key: rows[2]!.key! }) // 1, a pause, 3: row 3
  expect(await selected()).toBe('todo number 3')
  await ui.press({ key: 'zero' }) // a lone 0 explains itself
  expect(await status(ui)).toBe('type 1 then 0 for row 10')

  // The selected row's digit asks once no second digit follows; a second one moves on without asking.
  await ui.press({ key: rows[12]!.key! }) // row 13, selected
  await ui.press({ key: rows[12]!.key! }) // pressed again: asks at once, having no digit
  expect(await shows(ui, 'mark "todo number 13" done?')).toBe(true)
  await ui.press({ key: 'no' })
  await ui.press({ key: rows[0]!.key! }) // 1: selects row 1
  await clock.advance(1500)
  expect(await ui.find({ key: 'yes' })).toBeUndefined()
  await ui.press({ key: rows[0]!.key! }); await ui.press({ key: rows[1]!.key! }) // 1, 2: row 12, no question
  await clock.advance(1500)
  expect(await selected()).toBe('todo number 12')
  expect(await ui.find({ key: 'yes' })).toBeUndefined()
  await ui.press({ key: rows[0]!.key! }); await ui.press({ key: rows[0]!.key! }) // 1, then 1 again on its own
  expect(await ui.find({ key: 'yes' })).toBeUndefined() // row 11 selected, nothing asked yet
  expect(await selected()).toBe('todo number 11')
  await ui.press({ key: rows[0]!.key! }) // 1: row 1
  await clock.advance(1500)
  await ui.press({ key: rows[0]!.key! }) // 1 alone on the selected row 1
  await clock.advance(1000)
  expect(await shows(ui, 'mark "todo number 1" done?')).toBe(true)
  await ui.unmount()
})

test('rows fit the body by display width: wide glyphs count 2, an emoji sequence is never cut', async ($, on) => {
  const { session, clock } = fakeCli(on)
  session.stack = [
    row(A, `${'x'.repeat(35)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}tail`, 'due', null),
    row(B, '日'.repeat(20), 'due', null),
    row(C, 'short ☕', 'due', null),
  ]
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })
  // 44 columns less the border, `▸ □ ` and `1: ` leaves 35 cells.
  expect((await ui.find({ key: `row-${A}` }))?.text).toBe(`${'x'.repeat(34)}…`)
  expect((await ui.find({ key: `row-${B}` }))?.text).toBe(`${'日'.repeat(17)}…`)
  expect((await ui.find({ key: `row-${C}` }))?.text).toBe('short ☕')
  await ui.unmount()
})

test('unfocused, the legend folds to one hint line; the list and the status line stay', async ($, on) => {
  const { clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE, props: { ...PANE.props, isFocused: false } })
  expect(await ui.find({ key: 'push' })).toBeUndefined()
  expect(await shows(ui, 'ctrl+x tab to use keys')).toBe(true)
  expect(await ui.find({ key: `row-${A}` })).toBeDefined()
  expect(await ui.find({ key: 'status' })).toBeDefined()
  await ui.unmount()
})

test('the legend: every key in `mokkan ui` footer style, wrapped to the width; logged out it shrinks', async ($, on) => {
  const { session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })
  const keys = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k && !k.startsWith('row-') && !k.startsWith('tab-'))
  expect(await keys()).toEqual(['push', 'in', 'edit', 'time', 'done', 'ack', 'pop', 'dequeue', 'view', 'refresh', 'buy', 'logout', 'help', 'close'])
  const labels = async () => (await ui.findAll({ type: 'Button' })).filter(b => b.props.hotkey && !b.key?.startsWith('row-')).map(b => b.text)
  expect(await labels()).toEqual(['todo', 'reminder', 'edit', 'when', 'done', 'ack', 'pop top', 'pop oldest', 'view done', 'sync', 'buy', 'log out', 'help', 'close'])
  const hotkeys = async () => (await ui.findAll({ type: 'Button' })).filter(b => b.props.hotkey && !b.key?.startsWith('row-')).map(b => b.props.hotkey)
  expect(await hotkeys()).toEqual(['t', 'r', 'e', 'w', 'd', 'a', 'p', 'o', 'v', 's', 'b', 'l', 'h', 'q']) // each its label's first letter
  await ui.press({ key: 'view' })
  expect(await labels()).toContain('reopen') // the done view names what d and v do there
  expect(await labels()).toContain('view stack')
  expect(await shows(ui, 'd marks a stack row done.')).toBe(false) // the done list has a row
  await ui.press({ key: 'view' })
  // A line per group (add, the selected row, the stack, the rest), the last wrapped: five lines at 44 columns, 42 inside the border.
  const line = async (i: number) => (await ui.find({ key: `legend-${i}` }))?.text.replace(/\s+/g, ' ').trim()
  expect(await line(0)).toBe('todo · reminder')
  expect(await line(2)).toBe('pop top · pop oldest')
  expect(await ui.find({ key: 'legend-4' })).toBeDefined()
  expect(await ui.find({ key: 'legend-5' })).toBeUndefined()

  session.loggedIn = false
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: `row-${A}` })).toBeUndefined()
  expect(await shows(ui, 'Not logged in.')).toBe(true)
  expect(await shows(ui, 'l logs in, r registers.')).toBe(true)
  expect(await shows(ui, 'logged out')).toBe(false) // the body says it once
  expect(await shows(ui, /synced/)).toBe(false) // no sync state while logged out
  expect(await shows(ui, /credits/)).toBe(false)
  expect(await keys()).toEqual(['login', 'register', 'refresh', 'help', 'close'])
  await ui.unmount()
})

test('h opens the help in place of the list and the keys shrink to back and close; the sync state is the last line', async ($, on) => {
  const { clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect((await texts()).at(-1)).toMatch(/^ synced \d\d:\d\d$/) // at the bottom, clear of the engine's close mark

  await ui.press({ key: 'help' })
  expect(await shows(ui, /every Claude Code, Codex and terminal session shares/)).toBe(true)
  expect(await shows(ui, /plus 1 held for its email and given back if you ack it first/)).toBe(true)
  expect(await ui.find({ key: `row-${A}` })).toBeUndefined()
  expect(await ui.find({ key: 'tab-stack' })).toBeUndefined()
  const keys = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.text])
  expect(keys).toEqual([['help', 'back'], ['close', 'close']])

  await ui.press({ key: 'help' })
  expect(await ui.find({ key: `row-${A}` })).toBeDefined()
  await ui.unmount()
})

test('without an Input (mobile) the pane offers no key it cannot take', async ($, on) => {
  const { session, clock } = fakeCli(on)
  session.stack = []
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'mobile', ...PANE })
  const keys = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k && !k.startsWith('row-') && !k.startsWith('tab-'))
  expect(await keys()).toEqual(['done', 'ack', 'pop', 'dequeue', 'view', 'refresh', 'logout', 'help', 'close'])
  expect(await shows(ui, 'Nothing on the stack.')).toBe(true)

  session.loggedIn = false
  await ui.press({ key: 'refresh' })
  expect(await shows(ui, 'Log in from a terminal: mokkan login')).toBe(true)
  expect(await keys()).toEqual(['refresh', 'help', 'close'])
  await ui.unmount()
})

test('offline keeps the last list, marked stale; overlapping refreshes keep the newest', async ($, on) => {
  const { session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await clock.advance(3 * 60_000)
  session.offline = true
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: `row-${A}` })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^ offline · synced \d\d:\d\d$/ }))?.props.color).toBe('yellow')
  expect(await shows(ui, '· 42 credits')).toBe(true)

  session.offline = false
  session.slow.list = 2000
  const older = ui.press({ key: 'refresh' }) // slow, and older
  await clock.settle()
  expect(await shows(ui, 'syncing…')).toBe(true)
  session.slow.list = 0
  session.stack = [row(B, 'call the bank', 'due', -40)]
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: `row-${A}` })).toBeUndefined()
  session.stack = STACK()
  await clock.advance(2000) // the older one lands, and is dropped
  await older
  expect(await ui.find({ key: `row-${A}` })).toBeUndefined()
  expect((await ui.find({ key: 'tab-stack' }))?.text).toBe('Stack 1')
  await ui.unmount()
})

test('toasts: a timed reminder that fires, never a todo just pushed', async ($, on) => {
  const { session, clock, toasts, toastMs } = fakeCli(on)
  await opened($, clock)
  expect(toasts).toEqual([])
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'push' })
  await ui.input({ key: 'field', text: 'milk' })
  await clock.settle()
  expect(toasts).toEqual([])

  session.stack = session.stack.map(r => (r.id === C ? { ...r, state: 'due' } : r))
  await ui.press({ key: 'refresh' })
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('ask Maria re notes')
  expect(toastMs[0]).toBe(15_000)
  await ui.unmount()
})

test('the minute timer refreshes only while the pane is open', async ($, on) => {
  const { ran, clock } = fakeCli(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const lists = () => ran.filter(a => a[2] === 'list').length
  await clock.advance(60_000)
  expect(lists()).toBe(0)
  await opened($, clock)
  expect(lists()).toBe(1)
  await clock.advance(60_000)
  expect(lists()).toBe(2)
})

test('/mokkan-pane runs mid-turn, and the CLI path is looked up once', async ($, on) => {
  const { clock, commands, stats } = fakeCli(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(commands).toEqual([expect.objectContaining({ name: 'mokkan-pane', immediate: true })])
  await opened($, clock)
  await clock.advance(60_000)
  expect(stats()).toBe(1)
})

test('a /clear, /resume or /branch refreshes the open pane, and only an open one', async ($, on) => {
  const { ran, clock } = fakeCli(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const lists = () => ran.filter(a => a[2] === 'list').length
  await $.classic.SessionStart({ source: 'clear' })
  await clock.settle()
  expect(lists()).toBe(0)
  await opened($, clock)
  expect(lists()).toBe(1)
  for (const source of ['clear', 'resume', 'fork'] as const) await $.classic.SessionStart({ source })
  await clock.settle()
  expect(lists()).toBe(4)
  await $.classic.SessionStart({ source: 'compact' })
  await clock.settle()
  expect(lists()).toBe(4)
})

test('b opens Stripe Checkout through the CLI, and says when it could not', async ($, on) => {
  const { ran, session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })
  expect((await ui.find({ key: 'buy' }))?.props.hotkey).toBe('b')
  await ui.press({ key: 'buy' })
  await clock.settle()
  expect(ran.some(a => a[2] === 'buy' && a.includes('--json'))).toBe(true)
  expect(await status(ui)).toBe('Opened Stripe Checkout in your browser; the balance updates after payment.')

  session.opens = false
  await clock.advance(15_000)
  await ui.press({ key: 'buy' })
  await clock.settle()
  expect(await status(ui)).toBe('Could not open a browser here. Run: mokkan buy --no-open (prints the link).')
  await ui.unmount()
})

test('`/mokkan-pane close` closes the pane', async ($, on) => {
  fakeCli(on)
  let closed = false
  on('ui.close', () => { closed = true; return { value: undefined } })
  const { text } = await $.command.run({ command: 'mokkan-pane', args: 'close', ...RUN })
  expect(text).toMatch(/closed/)
  expect(closed).toBe(true)
})

test('logout and login run from the pane, the password masked and passed through the environment', async ($, on) => {
  const { ran, session, envs, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'logout' })
  await ui.press({ key: 'yes' })
  expect(ran.some(a => a[2] === 'logout')).toBe(true)
  expect(session.loggedIn).toBe(false)
  expect((await ui.find({ key: 'login' }))?.type).toBe('Button')

  await ui.press({ key: 'login' })
  await ui.input({ key: 'auth', text: 'vic@example.com' })
  expect((await ui.find({ key: 'auth' }))?.props.label).toMatch(/password for vic@example.com/)
  expect((await ui.find({ key: 'auth' }))?.props.submitLabel).toBe('log in')

  // A wrong password: the error shows in the auth step, which stays open.
  session.fail.login = 'Invalid email or password.'
  await ui.input({ key: 'auth', text: 'nope', kind: 'change' })
  await ui.input({ key: 'auth', text: '••••' })
  expect(await status(ui)).toBe('error: Invalid email or password.')
  expect((await ui.find({ key: 'auth' }))?.props.value).toBe('')
  delete session.fail.login

  await ui.input({ key: 'auth', text: 'h', kind: 'change' })
  await ui.input({ key: 'auth', text: '•u', kind: 'change' })
  await ui.input({ key: 'auth', text: '••n', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••t', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••', kind: 'change' }) // backspace at the end
  await ui.input({ key: 'auth', text: '•••t2', kind: 'change' }) // two before the redraw
  expect((await ui.find({ key: 'auth' }))?.props.value).toBe('•••••')
  await ui.input({ key: 'auth', text: '•••••' })

  const at = ran.findIndex(a => a[2] === 'login' && envs[ran.indexOf(a)]?.MOKKAN_PASSWORD === 'hunt2')
  expect(at).toBeGreaterThan(-1)
  expect(ran[at]?.[3]).toBe('vic@example.com')
  expect(session.loggedIn).toBe(true)
  expect(await ui.find({ key: `row-${A}` })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('hunt2')
  await ui.unmount()
})

test('an edit inside the hidden password resets it with an error instead of corrupting it', async ($, on) => {
  const { session, clock } = fakeCli(on)
  session.loggedIn = false
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })
  await ui.press({ key: 'login' })
  await ui.input({ key: 'auth', text: 'vic@example.com' })

  await ui.input({ key: 'auth', text: 'pasted-secret', kind: 'change' }) // a paste at the end is kept
  expect((await ui.find({ key: 'auth' }))?.props.value).toBe('•'.repeat(13))
  await ui.input({ key: 'auth', text: '••••x•••••••••', kind: 'change' }) // typed in the middle
  expect((await ui.find({ key: 'auth' }))?.props.value).toBe('')
  expect(await status(ui)).toBe('error: editing inside the password erased it; type it again')
  await ui.unmount()
})

test('registration sends the code, then completes with the code and the masked password', async ($, on) => {
  const { ran, session, envs, clock } = fakeCli(on)
  session.loggedIn = false
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'register' })
  await ui.input({ key: 'auth', text: 'new@example.com' })
  expect(ran.some(a => a[2] === 'register' && a[3] === 'new@example.com' && a[4] === '--start')).toBe(true)
  expect((await ui.find({ key: 'auth' }))?.props.label).toBe('one-time code')

  await ui.input({ key: 'auth', text: '123456' })
  expect((await ui.find({ key: 'auth' }))?.props.label).toMatch(/new password/)

  await ui.input({ key: 'auth', text: 'short', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••••' })
  expect(ran.some(a => a.includes('--complete'))).toBe(false)
  expect((await ui.find({ key: 'auth' }))?.props.value).toBe('')
  expect(await status(ui)).toBe('error: the password needs 10+ characters')

  await ui.input({ key: 'auth', text: 'longenough1', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••••••••••' })
  const at = ran.findIndex(a => a.includes('--complete'))
  expect(ran[at]?.slice(2, 7)).toEqual(['register', '--complete', 'new@example.com', '--otp', '123456'])
  expect(envs[at]?.MOKKAN_PASSWORD).toBe('longenough1')
  expect(session.loggedIn).toBe(true)
  expect(await ui.find({ key: `row-${A}` })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('longenough1')
  await ui.unmount()
})

test('the cancel button leaves the field and the auth flow', async ($, on) => {
  const { ran, session, clock } = fakeCli(on)
  await opened($, clock)
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'push' })
  expect(await ui.find({ key: 'field' })).toBeDefined()
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'field' })).toBeUndefined()
  expect(await ui.find({ key: 'push' })).toBeDefined()

  session.loggedIn = false
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'login' })
  await ui.input({ key: 'auth', text: 'vic@example.com' })
  await ui.input({ key: 'auth', text: 'abc', kind: 'change' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ key: 'auth' })).toBeUndefined()
  expect(ran.some(a => a[2] === 'login')).toBe(false)
  await ui.unmount()
})

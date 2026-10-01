import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const A = 'a1a1a1a1-0000-4000-8000-000000000001'
const B = 'b2b2b2b2-0000-4000-8000-000000000002'
const C = 'c3c3c3c3-0000-4000-8000-000000000003'
const LIST = JSON.stringify({ version: 1, reminders: [
  { id: A, text: 'check the flaky login test', state: 'due', position: 0, due_at: null },
  { id: B, text: 'ask Maria about the release notes', state: 'scheduled', position: 1, due_at: '2030-01-01T00:00:00Z' },
] })
const DONE = JSON.stringify({ version: 1, reminders: [
  { id: C, text: 'renew the domain', state: 'done', position: -1, due_at: null },
] })
const BALANCE = JSON.stringify({ balance: 42, ledger: [] })
const OK = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const PANE = {
  component: 'Pane',
  requestId: 'mokkan',
  props: { title: 'mokkan', isFocused: true, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const

function fakeCli(on: On) {
    mock.clock(on)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }))
  const ran: string[][] = []
  const envs: Record<string, string>[] = []
  const session = { loggedIn: true }
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    envs.push(e.init?.env ?? {})
    const cmd = e.argv[2]
    if (cmd === 'register' && e.argv.includes('--complete')) { session.loggedIn = true; return OK('Registered and logged in.\n') }
    if (cmd === 'register') return OK('One-time code sent.\n')
    if (cmd === 'login') { session.loggedIn = true; return OK('{}') }
    if (cmd === 'logout') { session.loggedIn = false; return OK('{}') }
    if (!session.loggedIn) return { value: { exitCode: 1, stdout: 'Not logged in. Run: mokkan login\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (cmd === 'list') return OK(LIST)
    if (cmd === 'done' && e.argv.length === 4) return OK(DONE) // bare `done --json`: the history
    if (cmd === 'balance') return OK(BALANCE)
    if (cmd === 'done') return OK(JSON.stringify({ done: [e.argv[3]] }))
    if (cmd === 'undone') return OK(JSON.stringify({ reopened: [e.argv[3]] }))
    return OK(JSON.stringify({ version: 2 }))
  })
  return { ran, session, envs }
}

const status = async (ui: { find: (q: { key: string }) => Promise<{ text: string } | undefined> }) => (await ui.find({ key: 'status' }))?.text.trim()

test('the pane draws the tabs, the rows and the balance; the focus ring points at a row', async ($, on) => {
  fakeCli(on)
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'mokkan', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /42 cr/ })).toBeDefined()
    expect((await ui.find({ key: 'tab-todo' }))?.text).toBe('[todo 1]')
    expect((await ui.find({ key: 'tab-timed' }))?.text).toBe('reminders 1')
    expect((await ui.find({ key: 'tab-done' }))?.text).toBe('done 1')
    expect(await ui.find({ key: `row-${A}` })).toBeDefined()
    expect(await ui.find({ key: `row-${B}` })).toBeUndefined()

    // Pressing a row (or the ring landing on it) points at it.
    await ui.press({ key: `row-${A}` })
    expect(await ui.find({ type: 'Text', text: '▸' })).toBeDefined()

    await ui.press({ key: 'switch' })
    expect(await ui.find({ key: `row-${B}` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\d+[mhd]$/ })).toBeDefined()
    await ui.press({ key: 'tab-done' })
    expect(await ui.find({ key: `row-${C}` })).toBeDefined()
    await ui.press({ key: 'tab-todo' })
    await ui.unmount()
  }
})

test('the second press on the pointed row marks it done; on the done tab it reopens; a marks the pointed one done', async ($, on) => {
  const { ran } = fakeCli(on)
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: `row-${A}` }) // points
  expect(ran.some(a => a[2] === 'done' && a[3] === A)).toBe(false)
  await ui.press({ key: `row-${A}` }) // finishes
  expect(ran.some(a => a[2] === 'done' && a[3] === A)).toBe(true)
  expect(await status(ui)).toMatch(/^done · check the flaky/)

  await ui.press({ key: 'tab-done' })
  await ui.press({ key: `row-${C}` })
  await ui.press({ key: `row-${C}` })
  expect(ran.some(a => a[2] === 'undone' && a[3] === C)).toBe(true)
  expect(await status(ui)).toMatch(/^reopened · renew/)

  await ui.press({ key: 'tab-todo' })
  await ui.press({ key: `row-${A}` })
  await ui.press({ key: 'done' })
  expect(ran.filter(a => a[2] === 'done' && a[3] === A)).toHaveLength(2)
  await ui.press({ key: 'ack' })
  expect(ran.some(a => a[2] === 'ack' && a[3] === A)).toBe(true)
  expect(await status(ui)).toMatch(/^acknowledged/)
  await ui.unmount()
})

test('push, edit and pop run the matching CLI commands and report on the status line', async ($, on) => {
  const { ran } = fakeCli(on)
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'push' })
  await ui.input({ key: 'field', text: 'milk' })
  expect(ran.some(a => a[2] === 'push' && a[3] === 'milk')).toBe(true)
  expect(await status(ui)).toBe('pushed · milk')

  await ui.press({ key: 'edit' }) // nothing pointed at yet
  expect(await status(ui)).toMatch(/point at a reminder/)
  await ui.press({ key: `row-${A}` })
  await ui.press({ key: 'edit' })
  expect((await ui.find({ key: 'field' }))?.props.value).toBe('check the flaky login test')
  await ui.input({ key: 'field', text: 'check the login test again' })
  expect(ran.some(a => a[2] === 'edit' && a[3] === A && a[4] === 'check the login test again')).toBe(true)

  await ui.press({ key: 'pop' })
  await ui.press({ key: 'yes' })
  expect(ran.some(a => a[2] === 'pop')).toBe(true)
  expect(await status(ui)).toBe('popped')
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

test('the legend holds every command in a fixed grid; logged out it shrinks to login, register, refresh, close', async ($, on) => {
  const { session } = fakeCli(on)
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })
  const keys = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k && !k.startsWith('row-') && !k.startsWith('tab-'))
  expect(await keys()).toEqual(['push', 'in', 'edit', 'time', 'done', 'ack', 'pop', 'dequeue', 'switch', 'refresh', 'logout', 'close'])

  session.loggedIn = false
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ key: `row-${A}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Not logged in/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'logged out' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /42 cr/ })).toBeUndefined()
  expect(await keys()).toEqual(['login', 'register', 'refresh', 'close'])
  await ui.unmount()
})

test('logout and login run from the pane, the password masked and passed through the environment', async ($, on) => {
  const { ran, session, envs } = fakeCli(on)
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
  const ui = await $.ui.mount({ plugin: 'mokkan', surface: 'terminal', ...PANE })

  await ui.press({ key: 'logout' })
  expect(ran.some(a => a[2] === 'logout')).toBe(true)
  expect(session.loggedIn).toBe(false)
  expect((await ui.find({ key: 'login' }))?.type).toBe('Button')

  await ui.press({ key: 'login' })
  await ui.input({ key: 'auth', text: 'vic@example.com' })
  expect((await ui.find({ key: 'auth' }))?.props.label).toMatch(/password for vic@example.com/)

  await ui.input({ key: 'auth', text: 'h', kind: 'change' })
  await ui.input({ key: 'auth', text: '•u', kind: 'change' })
  await ui.input({ key: 'auth', text: '••n', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••t', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••', kind: 'change' })
  await ui.input({ key: 'auth', text: '•••t', kind: 'change' })
  await ui.input({ key: 'auth', text: '••••2', kind: 'change' })
  expect((await ui.find({ key: 'auth' }))?.props.value).toBe('•••••')
  await ui.input({ key: 'auth', text: '•••••' })

  const at = ran.findIndex(a => a[2] === 'login')
  expect(ran[at]?.[3]).toBe('vic@example.com')
  expect(envs[at]?.MOKKAN_PASSWORD).toBe('hunt2')
  expect(session.loggedIn).toBe(true)
  expect(await ui.find({ key: `row-${A}` })).toBeDefined()
  expect(JSON.stringify(await ui.drawn())).not.toContain('hunt2')
  await ui.unmount()
})

test('registration sends the code, then completes with the code and the masked password', async ($, on) => {
  const { ran, session, envs } = fakeCli(on)
  session.loggedIn = false
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
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
  const { ran, session } = fakeCli(on)
  await $.command.run({ command: 'mokkan-pane', args: '', ...RUN })
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

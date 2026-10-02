export type MokkanReminder = {
  id: string
  text: string
  state: 'scheduled' | 'due' | 'delivered' | 'acknowledged' | 'done'
  /** Null for a todo (`push`), set for a reminder (`in`, or `t` on a todo). */
  due_at: string | null
  created_at: string
  delivered_at: string | null
  acknowledged_at: string | null
  done_at: string | null
}

export type MokkanView = {
  /** Every open reminder (`mokkan list --all`), top of the stack first. */
  reminders: MokkanReminder[]
  /** Finished reminders (`mokkan done`), newest first. */
  done: MokkanReminder[]
  balance: number | null
  /** Why the last refresh failed: `offline` keeps the last good lists, `loggedOut` clears them. */
  failure: { kind: 'offline' | 'loggedOut'; text: string } | null
  /** When the lists were last fetched whole; null until then and after a logout. */
  fetchedAt: number | null
}

/** The list shown: every open reminder, or the finished ones. */
export type MokkanTab = 'stack' | 'done'

/** The last result, drawn on the status line until 15 s pass or the next key: green, yellow for a nudge, red for an error; `id` counts the messages said. */
export type MokkanMessage = { text: string; tone: 'ok' | 'note' | 'error'; id: number } | null

/** What the pane's field is for: a new todo or reminder, or a change to the pointed one. */
export type MokkanMode =
  | { kind: 'normal' }
  | { kind: 'input'; purpose: 'push' | 'in' | 'edit' | 'time'; targetId?: string; value: string }
  /** `target` names what the action takes: a reminder's text, or the account; `targetId` the reminder done and undone change. */
  | { kind: 'confirm'; action: 'pop' | 'dequeue' | 'logout' | 'done' | 'undone'; target: string; targetId?: string }
  /**
   * Login or registration: the email, the emailed code (register only), then the password.
   * `masked` is the bullets drawn for the password; the text itself never enters state.
   */
  | { kind: 'auth'; flow: 'login' | 'register'; step: 'email' | 'otp' | 'password'; email: string; otp: string; masked: string }

declare module 'claude-code' {
  interface PluginState {
    mokkan: {
      view: MokkanView
      mode: MokkanMode
      selected: string | null
      tab: MokkanTab
      message: MokkanMessage
      /** The verb of the CLI call in flight (`pushing…`), drawn in the header; action keys wait for it. */
      busy: string | null
      /** True while a refresh is in flight. */
      syncing: boolean
      /** True while the help view (`h`) replaces the list. */
      help: boolean
    }
  }
}

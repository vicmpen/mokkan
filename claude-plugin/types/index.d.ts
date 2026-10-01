export type MokkanReminder = {
  id: string
  text: string
  state: 'scheduled' | 'due' | 'delivered' | 'acknowledged' | 'done'
  due_at: string | null
}

export type MokkanView = {
  /** Every open reminder (`mokkan list --all`), top of the stack first. */
  reminders: MokkanReminder[]
  /** Finished reminders (`mokkan done`), newest first. */
  done: MokkanReminder[]
  balance: number | null
  error: string | null
  fetchedAt: number | null
}

/** The list shown: plain notes on the stack, the ones with a due time, or the finished ones. */
export type MokkanTab = 'todo' | 'timed' | 'done'

/** The last result, drawn on the status line above the commands. */
export type MokkanMessage = { text: string; tone: 'ok' | 'error' } | null

/** What the pane's field is for: a new reminder, a scheduled one, or an edit of the pointed one. */
export type MokkanMode =
  | { kind: 'normal' }
  | { kind: 'input'; purpose: 'push' | 'in' | 'edit' | 'time'; targetId?: string; value: string }
  | { kind: 'confirm'; action: 'pop' | 'dequeue' }
  /**
   * Login or registration: the email, the emailed code (register only), then the password.
   * `masked` is the bullets drawn for the password; the text itself never enters state.
   */
  | { kind: 'auth'; flow: 'login' | 'register'; step: 'email' | 'otp' | 'password'; email: string; otp: string; masked: string }

declare module 'claude-code' {
  interface PluginState {
    mokkan: { view: MokkanView; mode: MokkanMode; selected: string | null; tab: MokkanTab; message: MokkanMessage }
  }
}

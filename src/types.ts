export type ReminderState = 'scheduled' | 'due' | 'delivered' | 'acknowledged' | 'done';

export interface Reminder {
  id: string;
  text: string;
  state: ReminderState;
  position: number;
  due_at: string | null;
  created_at: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
  done_at: string | null;
}

export interface TokenPair {
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
}

export interface ListResponse { version: number; reminders: Reminder[] }
export interface ReminderResponse { version: number; reminder: Reminder }
export interface PendingResponse { due: Reminder[]; awaiting_ack: Reminder[] }
/** `reminder_count`: the open (not done) reminders; `privacy_version`: the policy version the account accepted. */
export interface MeResponse {
  email: string; last_heartbeat_at: string | null; session_active: boolean; credit_balance: number;
  reminder_count: number; privacy_version: string;
}
/** GET /privacy: the current policy version, the full text's address and the short summary the clients show. */
export interface PrivacyResponse { version: string; url: string; summary: string[] }
export interface HeartbeatResponse { active_until: string }
export interface DeliverResponse { version: number; delivered: string[] }
export interface AckResponse { version: number; acknowledged: string[] }
export type ListScope = 'active' | 'all' | 'done';
export interface CheckoutResponse { url: string; session_id: string }
export interface LedgerEntry { delta: number; reason: string; ref: string | null; created_at: string }
export interface BalanceResponse { balance: number; ledger: LedgerEntry[] }
export interface EditPatch { text?: string; due_at?: Date | null }

import type { Credentials } from './credentials.js';
import { SessionExpiredError } from './errors.js';
import type {
  AckResponse, BalanceResponse, CheckoutResponse, DeliverResponse, EditPatch, HeartbeatResponse, ListResponse, ListScope, MeResponse,
  PendingResponse, PrivacyResponse, ReminderResponse, TokenPair,
} from './types.js';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly body?: unknown, public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Where the full privacy policy lives when the server does not say. */
export const PRIVACY_URL = 'https://mokkan.dev/privacy';

/**
 * The extra line the CLI prints after some API errors: the credit reserve note (402), the retry delay (429), or for
 * the privacy gate (403) and a stale acceptance (409) the policy's address, with the npx form of `mokkan accept`.
 */
export function apiErrorHint(err: ApiError): string | null {
  const body = (err.body ?? {}) as { required?: unknown; cost?: unknown; url?: unknown };
  const policy = `Privacy policy: ${typeof body.url === 'string' ? body.url : PRIVACY_URL}`;
  if (err.status === 403 && err.code === 'privacy_not_accepted') return `(or npx @vicmpen/mokkan-cli accept if mokkan isn't installed)\n${policy}`;
  if (err.status === 409 && err.code === 'privacy_version_stale') return policy;
  if (err.status === 402 && typeof body.required === 'number' && typeof body.cost === 'number' && body.required > body.cost) {
    return `(${body.required - body.cost} credits are kept for pending reminder emails; acknowledge shown reminders with \`mokkan ack\` or run \`mokkan buy\`)`;
  }
  if (err.status === 429 && err.retryAfterSeconds !== undefined) {
    const s = Math.ceil(err.retryAfterSeconds);
    return `(try again in about ${s >= 60 ? `${Math.ceil(s / 60)} minutes` : `${s} seconds`})`;
  }
  return null;
}

/** Longest reminder or todo text, in code points after trimming; the server enforces the same limit. */
export const MAX_TEXT = 200;

/** Refuses an over-long text before the request, with the server's own error. */
function checkLength(text: string): void {
  if ([...text.trim()].length > MAX_TEXT) throw new ApiError(400, 'validation', `text is longer than ${MAX_TEXT} characters`);
}

export class NetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface MokkanClientOptions {
  baseUrl: string;
  credentials?: Credentials | null;
  /** Persists new tokens (login, register, refresh). */
  onCredentials?: (creds: Credentials) => void;
  /**
   * Re-reads the stored credentials. Called before every refresh: another process (a hook, `mokkan watch`) may
   * already have rotated the refresh token we hold, and presenting it again would revoke the whole family.
   */
  reloadCredentials?: () => Credentials | null;
  /** Runs `fn` under the cross-process credentials lock (see withCredentialsLock). */
  lock?: <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  /** The refresh token was rejected: drop the stored credentials (they cannot be used again). */
  onSessionExpired?: () => void;
  /** The list or the account changed (push, pop, ack, deliver, login, logout): the status line cache is out of date. */
  onListChanged?: () => void;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** An overall deadline for every request this client makes (hooks), combined with the per-request timeout. */
  signal?: AbortSignal;
  now?: () => Date;
}

const REFRESH_AHEAD_MS = 3600 * 1000;

interface RawResponse { status: number; json: unknown; retryAfterSeconds?: number }

/** Checkout makes up to 3 Stripe calls server-side, so it gets longer than the default request timeout. */
export const CHECKOUT_TIMEOUT_MS = 30_000;

export class MokkanClient {
  readonly baseUrl: string;
  private credentials: Credentials | null;
  private readonly onCredentials: ((creds: Credentials) => void) | undefined;
  private readonly reloadCredentials: (() => Credentials | null) | undefined;
  private readonly lock: <T>(fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  private readonly onSessionExpired: (() => void) | undefined;
  private readonly onListChanged: () => void;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly now: () => Date;
  /** The in-flight refresh, shared by every caller: the server rotates refresh tokens and treats reuse as theft. */
  private refreshing: Promise<Credentials> | null = null;

  constructor(opts: MokkanClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.credentials = opts.credentials ?? null;
    this.onCredentials = opts.onCredentials;
    this.reloadCredentials = opts.reloadCredentials;
    this.lock = opts.lock ?? ((fn) => fn());
    this.onSessionExpired = opts.onSessionExpired;
    this.onListChanged = opts.onListChanged ?? (() => undefined);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.signal = opts.signal;
    this.now = opts.now ?? (() => new Date());
  }

  hasCredentials(): boolean { return this.credentials !== null; }
  get email(): string | null { return this.credentials?.email ?? null; }

  // ---- unauthenticated ----
  health(): Promise<{ ok: boolean; db: string }> { return this.call('GET', '/health'); }

  async registerStart(email: string): Promise<void> {
    await this.call('POST', '/auth/register/start', { email });
  }

  /** The policy shown when the server answers 403 privacy_not_accepted, and before registering. */
  privacy(): Promise<PrivacyResponse> { return this.call('GET', '/privacy'); }

  /** `privacyVersion`: the policy version the user was shown and accepted (409 privacy_version_stale if not current). */
  async registerComplete(email: string, otp: string, password: string, privacyVersion: string): Promise<Credentials> {
    const pair = await this.call<TokenPair>('POST', '/auth/register/complete', { email, otp, password, privacy_version: privacyVersion });
    this.onListChanged();
    return this.adopt(pair, email);
  }

  async login(email: string, password: string): Promise<Credentials> {
    const pair = await this.call<TokenPair>('POST', '/auth/login', { email, password });
    this.onListChanged();
    return this.adopt(pair, email);
  }

  /** Single-flight: concurrent callers share one /auth/refresh request instead of each rotating the same token. */
  refresh(): Promise<Credentials> {
    if (this.refreshing) return this.refreshing;
    const inFlight = this.refreshOnce().finally(() => {
      if (this.refreshing === inFlight) this.refreshing = null;
    });
    this.refreshing = inFlight;
    return inFlight;
  }

  /**
   * Cross-process safe rotation. The server revokes the whole token family when a refresh token is presented twice,
   * so before refreshing we re-read the credentials file: if another process already rotated, adopt its tokens.
   * The re-read, the refresh and the save run under an exclusive lock file so two processes can never both
   * present the same refresh token.
   */
  private async refreshOnce(): Promise<Credentials> {
    const current = this.credentials;
    if (!current) throw new ApiError(401, 'no_credentials', 'Not logged in. Run: mokkan login');
    const rotatedElsewhere = (): Credentials | null => {
      const stored = this.reloadCredentials?.() ?? null;
      return stored && stored.refresh_token !== current.refresh_token ? stored : null;
    };
    const early = rotatedElsewhere();
    if (early) return this.adoptStored(early);
    try {
      return await this.lock(async () => {
        const stored = rotatedElsewhere();
        if (stored) return this.adoptStored(stored);
        let pair: TokenPair;
        try {
          pair = await this.call<TokenPair>('POST', '/auth/refresh', { refresh_token: current.refresh_token });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401 && err.code === 'invalid_token') {
            // Still under the lock and the file still holds this dead token: nobody else can be using it.
            this.credentials = null;
            this.onSessionExpired?.();
            throw new SessionExpiredError();
          }
          throw err;
        }
        return this.adopt(pair, current.email);
      }, this.signal);
    } catch (err) {
      // E.g. the lock wait timed out while another process was refreshing: if it succeeded, use its tokens.
      if (err instanceof SessionExpiredError) throw err;
      let stored: Credentials | null = null;
      try { stored = rotatedElsewhere(); } catch { /* report the original failure */ }
      if (stored) return this.adoptStored(stored);
      throw err;
    }
  }

  /** Tokens another process already saved: use them without saving again. */
  private adoptStored(stored: Credentials): Credentials {
    this.credentials = stored;
    return stored;
  }

  // ---- authenticated ----
  async logout(): Promise<void> {
    await this.authed('POST', '/auth/logout');
    this.credentials = null;
    this.onListChanged();
  }

  me(): Promise<MeResponse> { return this.authed('GET', '/me'); }

  /** Accepts exactly `version`; 409 privacy_version_stale when the policy changed since it was shown. */
  async acceptPrivacy(version: string): Promise<void> {
    await this.authed('POST', '/privacy/accept', { version });
  }

  /** Deletes the account and everything on it. A wrong password is 403 wrong_password (a 401 would refresh). */
  async deleteAccount(password: string): Promise<void> {
    await this.authed('DELETE', '/me', { password });
    this.credentials = null;
    this.onListChanged();
  }

  heartbeat(source: string, sessionId?: string): Promise<HeartbeatResponse> {
    return this.authed('POST', '/heartbeat', sessionId === undefined ? { source } : { source, session_id: sessionId });
  }

  list(scope: ListScope = 'active'): Promise<ListResponse> {
    return this.authed('GET', `/reminders?scope=${scope}`);
  }

  async push(text: string, dueAt?: Date | null, clientId?: string): Promise<ReminderResponse> {
    checkLength(text);
    const body: Record<string, unknown> = { text };
    if (dueAt) body.due_at = dueAt.toISOString();
    if (clientId !== undefined) body.client_id = clientId;
    return this.changing(this.authed('POST', '/reminders', body));
  }

  /** Changes text and/or due_at (null clears it). Every 3rd successful edit costs a credit. */
  async editReminder(id: string, patch: EditPatch, expectedVersion?: number): Promise<ReminderResponse> {
    if (patch.text !== undefined) checkLength(patch.text);
    const body: Record<string, unknown> = {};
    if (patch.text !== undefined) body.text = patch.text;
    if (patch.due_at !== undefined) body.due_at = patch.due_at === null ? null : patch.due_at.toISOString();
    if (expectedVersion !== undefined) body.expected_version = expectedVersion;
    return this.changing(this.authed('PATCH', `/reminders/${encodeURIComponent(id)}`, body));
  }

  /** Starts a Stripe Checkout session for a credit pack (default pack when omitted). */
  checkout(pack?: string): Promise<CheckoutResponse> {
    return this.authed('POST', '/billing/checkout', pack === undefined ? {} : { pack }, CHECKOUT_TIMEOUT_MS);
  }

  balance(): Promise<BalanceResponse> { return this.authed('GET', '/billing/balance'); }

  /** Free; the server keeps line breaks, caps it at 2000 characters and takes 10 an hour. */
  feedback(text: string): Promise<{ ok: true }> { return this.authed('POST', '/feedback', { text }); }

  pop(expectedVersion?: number): Promise<ReminderResponse> {
    return this.changing(this.authed('POST', '/reminders/pop', expectedVersion === undefined ? {} : { expected_version: expectedVersion }));
  }

  dequeue(expectedVersion?: number): Promise<ReminderResponse> {
    return this.changing(this.authed('POST', '/reminders/dequeue', expectedVersion === undefined ? {} : { expected_version: expectedVersion }));
  }

  pending(): Promise<PendingResponse> { return this.authed('GET', '/reminders/pending'); }

  deliver(ids: string[]): Promise<DeliverResponse> { return this.changing(this.authed('POST', '/reminders/deliver', { ids })); }

  /** `done: true` finishes one reminder as pop does; `false` reopens a done one at its old position. Free. */
  setDone(id: string, done: boolean, expectedVersion?: number): Promise<ReminderResponse> {
    const body: Record<string, unknown> = { done };
    if (expectedVersion !== undefined) body.expected_version = expectedVersion;
    return this.changing(this.authed('POST', `/reminders/${encodeURIComponent(id)}/done`, body));
  }

  ack(idsOrAll: string[] | 'all', expectedVersion?: number): Promise<AckResponse> {
    const body: Record<string, unknown> = idsOrAll === 'all' ? { all: true } : { ids: idsOrAll };
    if (expectedVersion !== undefined) body.expected_version = expectedVersion;
    return this.changing(this.authed('POST', '/reminders/ack', body));
  }

  // ---- internals ----
  private async changing<T>(request: Promise<T>): Promise<T> {
    const result = await request;
    this.onListChanged();
    return result;
  }

  private adopt(pair: TokenPair, email: string): Credentials {
    this.credentials = {
      server_url: this.baseUrl,
      email,
      access_token: pair.access_token,
      access_expires_at: pair.access_expires_at,
      refresh_token: pair.refresh_token,
      refresh_expires_at: pair.refresh_expires_at,
    };
    this.onCredentials?.(this.credentials);
    return this.credentials;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status >= 400) throw toApiError(res);
    return res.json as T;
  }

  private async authed<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.credentials) throw new ApiError(401, 'no_credentials', 'Not logged in. Run: mokkan login');
    const expiresAt = Date.parse(this.credentials.access_expires_at);
    if (Number.isFinite(expiresAt) && expiresAt - this.now().getTime() < REFRESH_AHEAD_MS) {
      await this.refresh();
    }
    const sentToken = this.credentials.access_token;
    let res = await this.raw(method, path, body, sentToken, timeoutMs);
    if (res.status === 401) {
      // Refresh (or join the refresh in flight) only if nobody has replaced the token we sent; otherwise just retry.
      if (this.refreshing || this.credentials?.access_token === sentToken) await this.refresh();
      if (!this.credentials) throw toApiError(res);
      res = await this.raw(method, path, body, this.credentials.access_token, timeoutMs);
    }
    if (res.status >= 400) throw toApiError(res);
    return res.json as T;
  }

  private async raw(method: string, path: string, body?: unknown, token?: string, timeoutMs = this.timeoutMs): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: this.signal ? AbortSignal.any([controller.signal, this.signal]) : controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text !== '') {
        try { json = JSON.parse(text); } catch { json = { error: 'bad_response', message: text.slice(0, 200) }; }
      }
      const ra = Number(res.headers?.get('retry-after'));
      return { status: res.status, json, retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined };
    } catch (err) {
      const reason = controller.signal.aborted
        ? `timed out after ${timeoutMs} ms`
        : this.signal?.aborted ? 'overall deadline exceeded' : (err as Error).message;
      throw new NetworkError(`Cannot reach ${this.baseUrl}: ${reason}`, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toApiError(res: RawResponse): ApiError {
  const body = (res.json ?? {}) as { error?: unknown; message?: unknown };
  const code = typeof body.error === 'string' ? body.error : 'error';
  const message = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
  return new ApiError(res.status, code, message, res.json, res.retryAfterSeconds);
}

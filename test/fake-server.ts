import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  /** Values of `:name` segments in the matched route path. */
  params: Record<string, string>;
}

export interface FakeAccount {
  balance: number;
  editCount: number;
  ledger: { delta: number; reason: string; ref: string | null; created_at: string }[];
  reminders: Map<string, { id: string; text: string; state: string; due_at: string | null; [k: string]: unknown }>;
  nextId: number;
  /** Account-wide list version, bumped by every push and edit (like the real list_version). */
  version: number;
  checkoutUrl: string;
  /** Test hook, called after each GET /reminders has been answered (simulate a concurrent change). */
  afterList?: (scope: string) => void;
}

export interface FakeResponse { status: number; body?: unknown; headers?: Record<string, string> }
export type Handler = (req: Recorded) => FakeResponse | Promise<FakeResponse>;

/** Minimal in-process HTTP server: register handlers per (method, path), inspect recorded requests. */
export class FakeServer {
  readonly requests: Recorded[] = [];
  url = '';
  private routes: { method: string; path: string; handler: Handler }[] = [];
  private server: Server | undefined;

  on(method: string, path: string, handler: Handler): this {
    this.routes = this.routes.filter((r) => !(r.method === method && r.path === path));
    this.routes.push({ method, path, handler });
    return this;
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url ?? '/', 'http://fake');
      const rec: Recorded = {
        method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers,
        body: raw ? JSON.parse(raw) : null, params: {},
      };
      this.requests.push(rec);
      const route = this.routes.find((r) => r.method === rec.method && pathMatches(r.path, rec.path));
      if (route) rec.params = pathParams(route.path, rec.path)!;
      const out = route
        ? await route.handler(rec)
        : { status: 404, body: { error: 'not_found', message: `no fake route for ${rec.method} ${rec.path}` } };
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  /**
   * Opt-in fake account with prepaid credits: GET /me, GET /reminders (scope-aware, top of stack first),
   * POST /reminders (402 when the balance is too low), PATCH /reminders/:id (the contract's rules: 409 stale,
   * 409 not_editable, 404 for done/unknown, 400 for bad text; every 3rd edit costs 1), POST /billing/checkout and
   * GET /billing/balance.
   * The default balance is large so tests that push are never charged into a 402.
   * Also POST /heartbeat, GET /reminders/pending, POST /reminders/deliver|pop|dequeue|ack (409 stale on a wrong
   * expected_version, 404 empty).
   */
  withAccount(init: { balance?: number; email?: string; checkoutUrl?: string } = {}): FakeAccount {
    const acct: FakeAccount = {
      balance: init.balance ?? 1000, editCount: 0, ledger: [], reminders: new Map(), nextId: 1, version: 1,
      checkoutUrl: init.checkoutUrl ?? 'https://checkout.stripe.com/c/pay/cs_test_fake',
    };
    const insufficient = (cost: number, required: number): FakeResponse => ({
      status: 402,
      body: {
        error: 'insufficient_credits',
        message: `Not enough credits: this needs ${required}, you have ${acct.balance}. Run \`mokkan buy\` to add credits.`,
        balance: acct.balance, cost, required,
      },
    });
    const debit = (delta: number, reason: string, ref: string) => {
      acct.balance -= delta;
      acct.ledger.unshift({ delta: -delta, reason, ref, created_at: '2026-09-28T12:00:00.000Z' });
    };
    // (The fake does not track delivered_via, so every delivered reminder counts; the real server counts only in-session ones.)
    // Reminders that can still cause a charged email (scheduled/due, or delivered in-session, with a due time and no email yet).
    const EMAIL_COST = 1;
    const outstanding = (excludeId?: string) => [...acct.reminders.values()].filter((r) =>
      r.id !== excludeId && ['scheduled', 'due', 'delivered'].includes(r.state) && r.due_at != null && (r.email_sent_at ?? null) === null).length;
    this.on('GET', '/me', () => ({ status: 200, body: {
      email: init.email ?? 'a@example.com', last_heartbeat_at: null, session_active: false, credit_balance: acct.balance,
    } }));
    this.on('GET', '/reminders', (req) => {
      // Same filters as the real listReminders: active = due/delivered/acknowledged, all = not done, done = done.
      const scope = req.query.get('scope') ?? 'active';
      const keep = (state: string) => scope === 'done' ? state === 'done'
        : scope === 'all' ? state !== 'done' : ['due', 'delivered', 'acknowledged'].includes(state);
      const reminders = [...acct.reminders.values()].filter((r) => keep(r.state))
        .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0));
      const out = { status: 200, body: { version: acct.version, reminders: structuredClone(reminders) } };
      acct.afterList?.(scope);
      return out;
    });
    this.on('POST', '/reminders', (req) => {
      const { text, due_at } = req.body as { text: string; due_at?: string };
      const required = due_at ? 1 + EMAIL_COST * (outstanding() + 1) : 1;
      if (acct.balance < required) return insufficient(1, required);
      const id = `fake${String(acct.nextId++).padStart(4, '0')}-0000-0000-0000-000000000000`;
      const rem = {
        id, text, state: due_at ? 'scheduled' : 'due', position: acct.reminders.size + 1, due_at: due_at ?? null,
        created_at: '2026-09-28T12:00:00.000Z', delivered_at: null, acknowledged_at: null, done_at: null,
      };
      acct.reminders.set(id, rem);
      debit(1, 'push', id);
      acct.version += 1;
      return { status: 201, body: { version: acct.version, reminder: rem } };
    });
    this.on('PATCH', '/reminders/:id', (req) => {
      const rem = acct.reminders.get(req.params.id);
      if (!rem || rem.state === 'done') return { status: 404, body: { error: 'not_found', message: 'Reminder not found' } };
      const patch = req.body as { text?: string; due_at?: string | null; expected_version?: number };
      if (patch.text === undefined && patch.due_at === undefined) {
        return { status: 400, body: { error: 'validation', message: 'Provide text and/or due_at' } };
      }
      const text = patch.text?.trim();
      if (text !== undefined && (text.length < 1 || [...text].length > 200)) {
        return { status: 400, body: { error: 'validation', message: 'text must be 1..200 characters' } };
      }
      if (patch.expected_version !== undefined && patch.expected_version !== acct.version) {
        const reminders = [...acct.reminders.values()].filter((r) => ['due', 'delivered', 'acknowledged'].includes(r.state))
          .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0));
        return { status: 409, body: { error: 'stale', message: 'Your view of the list is out of date', version: acct.version, reminders } };
      }
      if (patch.due_at !== undefined && (!['scheduled', 'due'].includes(rem.state) || (rem.email_sent_at ?? null) !== null)) {
        return { status: 409, body: { error: 'not_editable', message: 'The time of this reminder can no longer be changed' } };
      }
      const editDebit = (acct.editCount + 1) % 3 === 0 ? 1 : 0;
      // Setting a due time on a reminder that had none reserves an email credit like a scheduled push does.
      const required = patch.due_at != null && rem.due_at == null
        ? editDebit + EMAIL_COST * (outstanding(rem.id) + 1) : editDebit;
      if (acct.balance < required) return insufficient(editDebit, required);
      if (editDebit) debit(1, 'edit', rem.id);
      acct.editCount += 1;
      if (text !== undefined) rem.text = text;
      if (patch.due_at !== undefined) {
        rem.due_at = patch.due_at;
        rem.state = patch.due_at !== null && Date.parse(patch.due_at) > Date.parse('2026-09-28T12:00:00.000Z') ? 'scheduled' : 'due';
      }
      acct.version += 1;
      return { status: 200, body: { version: acct.version, reminder: rem } };
    });
    this.on('POST', '/billing/checkout', (req) => {
      const pack = (req.body as { pack?: string } | null)?.pack;
      if (pack !== undefined && pack !== 'credits_500' && pack !== 'credits_1500') {
        return { status: 400, body: { error: 'validation', message: `Unknown pack "${pack}"` } };
      }
      return { status: 200, body: { url: acct.checkoutUrl, session_id: 'cs_test_fake' } };
    });
    this.on('GET', '/billing/balance', () => ({ status: 200, body: { balance: acct.balance, ledger: acct.ledger.slice(0, 20) } }));
    const active = () => [...acct.reminders.values()].filter((r) => ['due', 'delivered', 'acknowledged'].includes(r.state))
      .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0));
    const stale = (expected: unknown): FakeResponse | null => expected !== undefined && expected !== acct.version
      ? { status: 409, body: { error: 'stale', message: 'Your view of the list is out of date', version: acct.version, reminders: active() } }
      : null;
    this.on('POST', '/heartbeat', () => ({ status: 200, body: { active_until: '2026-09-28T12:05:00.000Z' } }));
    this.on('GET', '/reminders/pending', () => ({ status: 200, body: {
      due: active().filter((r) => r.state === 'due'), awaiting_ack: active().filter((r) => r.state === 'delivered'),
    } }));
    this.on('POST', '/reminders/deliver', (req) => {
      const delivered: string[] = [];
      for (const id of (req.body as { ids: string[] }).ids) {
        const r = acct.reminders.get(id);
        if (r && r.state === 'due') { r.state = 'delivered'; r.delivered_at = '2026-09-28T12:00:00.000Z'; delivered.push(id); }
      }
      if (delivered.length > 0) acct.version += 1;
      return { status: 200, body: { version: acct.version, delivered } };
    });
    const take = (end: 'top' | 'bottom') => (req: Recorded): FakeResponse => {
      const conflict = stale((req.body as { expected_version?: number } | null)?.expected_version);
      if (conflict) return conflict;
      const list = active();
      const r = end === 'top' ? list[0] : list[list.length - 1];
      if (!r) return { status: 404, body: { error: 'empty', message: 'List is empty' } };
      r.state = 'done';
      r.done_at = '2026-09-28T12:00:00.000Z';
      acct.version += 1;
      return { status: 200, body: { version: acct.version, reminder: structuredClone(r) } };
    };
    this.on('POST', '/reminders/pop', take('top'));
    this.on('POST', '/reminders/dequeue', take('bottom'));
    this.on('POST', '/reminders/ack', (req) => {
      const body = req.body as { ids?: string[]; all?: boolean; expected_version?: number };
      const conflict = stale(body.expected_version);
      if (conflict) return conflict;
      const targets = body.all === true
        ? active()
        : (body.ids ?? []).map((id) => acct.reminders.get(id)).filter((r) => r !== undefined);
      const acknowledged: string[] = [];
      for (const r of targets) {
        if (r.state === 'due' || r.state === 'delivered') {
          r.state = 'acknowledged';
          r.acknowledged_at = '2026-09-28T12:00:00.000Z';
          acknowledged.push(r.id);
        }
      }
      if (acknowledged.length > 0) acct.version += 1;
      return { status: 200, body: { version: acct.version, acknowledged } };
    });
    return acct;
  }

  count(method: string, path: string): number {
    return this.requests.filter((r) => r.method === method && r.path === path).length;
  }

  last(method: string, path: string): Recorded | undefined {
    return [...this.requests].reverse().find((r) => r.method === method && r.path === path);
  }
}

export function tokenPair(suffix = '1', accessExpiresAt = '2026-09-29T12:00:00.000Z') {
  return {
    access_token: `access-${suffix}`,
    access_expires_at: accessExpiresAt,
    refresh_token: `refresh-${suffix}`,
    refresh_expires_at: '2026-12-27T12:00:00.000Z',
  };
}

function pathParams(pattern: string, actual: string): Record<string, string> | null {
  const p = pattern.split('/');
  const a = actual.split('/');
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

function pathMatches(pattern: string, actual: string): boolean {
  return pathParams(pattern, actual) !== null;
}

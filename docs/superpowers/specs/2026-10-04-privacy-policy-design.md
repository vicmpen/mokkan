# Privacy policy, acceptance gate and account deletion

Date: 2026-10-04 (revised after review). Repos: `mokkan-server`, `mokkan` (CLI, TUI, pane, skills),
`mokkan-site`, plus the production host.

## Goal

Every mokkan account accepts the current privacy policy before the service does anything for it, and anyone can
delete their account from a terminal. The service launches from scratch: there are no existing accounts and no
older clients to support. Success:

- A user accepts the policy as part of registering (CLI and the pane); an account cannot be created
  without it. The server records the version and time.
- When a new policy version is published, every client stops the user on their next request until they accept;
  a client with a terminal shows the summary and asks, the others say how to.
- `mokkan delete-account` in a terminal removes the account and everything tied to it, except anonymised payment
  records kept for accounting. It works whether or not the current version is accepted.
- The policy at `mokkan.dev/privacy` describes what the code and the host actually do.

## Decisions

| Decision | Choice |
|---|---|
| Where acceptance is recorded | Server, per account, with the policy version |
| Policy text | Full text on `mokkan.dev/privacy`; the server serves the version, the URL and a short summary the clients show |
| Declining | Terminal clients offer `d` (delete my account); the pane says how to delete from a terminal |
| Deletion | `mokkan delete-account`, terminal only (refused in the pane and through `/mokkan`, which Claude runs without a TTY) |
| Payment records on deletion | Kept, anonymised (no account link); unspent credits are forfeited and the confirmation says so |
| Waiting to accept a new version | Reminders keep working passively: heartbeats and acks pass the gate, so an open pane still counts as a session and an emailed reminder can be acked. Everything else is blocked |
| Who may accept | Only the user. Claude (`/mokkan`) and Codex must never run `accept` |
| Legal framing | The policy is information the user acknowledges, not consent: the bases are contract, legitimate interest and legal obligation |
| Data controller | Victor Benetatos, personal project; Greece; contact info@mokkan.dev |

## 1. Server (`mokkan-server`)

### Migration `sql/005_privacy.sql`

The production database is empty at launch (wiped with `scripts/wipe.sh` if it holds test accounts); the migration
fails on a non-empty `accounts` table, which is the intended guard.

- `accounts`: add `privacy_version text NOT NULL` and `privacy_accepted_at timestamptz NOT NULL`.
- `purchases.account_id`: drop `NOT NULL`; replace the FK with `REFERENCES accounts(id) ON DELETE SET NULL`.
  `purchases` holds no personal data besides that link (Stripe ids, credits, amount, currency, time).
- `resolve_token()` (`sql/001_init.sql:95`) also returns the account's `privacy_version`, so the gate needs no
  extra query.

### Config

- `PRIVACY_VERSION`: the current policy version, a date (`2026-10-04`). Required; the server refuses to start
  without it.
- `PRIVACY_URL`: default `https://mokkan.dev/privacy`.
- The summary lines are a constant in `src/privacy/summary.ts`, changed together with the version.
- The gate is an exact match: never set `PRIVACY_VERSION` back to an older value, it would ask everyone again.

### Routes

- `GET /privacy` (no auth) → `{ version, url, summary: string[] }`.
- The gate: `makeRequireAuth` takes an option `privacy: 'required' | 'exempt'` (default `required`). If the
  account's `privacy_version` is not the current one it throws
  `HttpError(403, 'privacy_not_accepted', 'Accept the updated privacy policy: run mokkan accept in a terminal', { version, url })`.
  The gate runs in the preHandler, before any route does anything, so a 403 never leaves a half-done change.
- Exempt routes (authenticated, not gated):
  - `POST /privacy/accept`, `DELETE /me`, `POST /auth/logout`.
  - `GET /me`, which also returns `reminder_count` (active reminders) and `privacy_version`: the delete flow and
    the acceptance prompt need them.
  - `POST /heartbeat` and `POST /reminders/ack`: a user who has not yet accepted a new version is not emailed
    reminders an open pane already shows, and can ack the ones that are emailed (the email says `mokkan ack`).
  - Unauthenticated routes (register, login, refresh, password reset, the Stripe webhook) are unaffected.
- `POST /privacy/accept { version }` → 204 and sets `privacy_version`, `privacy_accepted_at = now`. A version
  other than the current one → 409 `privacy_version_stale` with `{ version, url }`.
- `POST /auth/register/complete` requires `privacy_version` equal to the current version; missing → 400
  `privacy_required`, stale → 409 `privacy_version_stale` with `{ version, url }`. Checked before the OTP is
  consumed, so a stale client can re-show and retry with the same code.
- `DELETE /me { password }`:
  - Wrong password → **403 `wrong_password`** (not 401: the client treats a 401 as an expired token, refreshes and
    retries). Rate-limited with the login limiter (`login:<email>` keys).
  - In one transaction on the admin pool:
    - `DELETE FROM otps WHERE email = $email`;
    - `DELETE FROM outbox WHERE to_email = $email`;
    - `DELETE FROM rate_limits WHERE key = 'login:' || $email OR starts_with(key, 'login:' || $email || ' ') OR key = 'otp:' || $email`
      (`starts_with`, as in `src/auth/routes.ts:152`, because `LIKE` would treat `_` in an email as a wildcard);
    - `DELETE FROM accounts WHERE id = $id`, which cascades to tokens, reminders, feedback and credit_ledger and
      sets `purchases.account_id` to null.
  - → 204. The Stripe customer is not deleted; the policy says Stripe keeps its own records.

### Webhooks after deletion

In `purchaseFor` (`src/billing/webhook.ts:104`): when the purchase row exists but its `account_id` is null, log at
info (`webhook: <what> for a deleted account; ignored`) and return null. Its three callers (refund, dispute,
dispute reversal) already treat null as "ignore and acknowledge", so Stripe gets 200 and stops retrying.

### Scheduler and deletion

A reminder email the scheduler has already claimed when the account is deleted may still be sent. If its next step
finds the account gone, it logs at info and moves on, not as "scheduler failed". The policy says an email already
being sent may still arrive.

### Tests

- The gate: a gated route returns 403 with `version`/`url` after `PRIVACY_VERSION` changes, and passes after
  accept; each exempt route works while not accepted; `GET /me` returns `reminder_count` and `privacy_version`.
- `POST /privacy/accept`: current → 204; stale → 409.
- `GET /privacy` shape; the server refuses to start without `PRIVACY_VERSION`.
- Register: current version → account created and accepted; missing → 400; stale → 409 and the OTP still works.
- `DELETE /me`: wrong password → 403 `wrong_password`, nothing deleted, counted by the login limiter; right
  password → account, tokens, reminders, feedback and ledger gone, purchases kept with a null `account_id`, OTP,
  outbox and rate-limit rows for that email gone, and a rate-limit row for an email that differs only where the
  deleted one has `_` is kept.
- Webhooks: refund, dispute and dispute reversal for an orphaned purchase → 200, no ledger row.
- Scheduler: an account deleted after a claim is logged at info, not as a failure.
- Migration: 005 applies to an empty database; deleting an account leaves its purchase with a null `account_id`.

## 2. Clients (`mokkan`)

### The command to show

Messages that send the user to a terminal say `mokkan <args>`, and add
`(or npx @vicmpen/mokkan-cli <args> if mokkan isn't installed)`, as the `/mokkan` skill already does. The pane
always shows both, because its bundled CLI is never the one on PATH.

### Client and exit codes

- `client.ts`: `privacy()` (GET /privacy), `acceptPrivacy(version)`, `deleteAccount(password)`;
  `registerComplete` sends `privacy_version`; `me()` gains `reminder_count` and `privacy_version`.
- `EXIT_PRIVACY_REQUIRED = 4` for a 403 `privacy_not_accepted` (unused today: 1 user error, 2 server/network,
  3 insufficient credits).

### The acceptance prompt (CLI)

When a command hits the gate:

- With a TTY: fetch `/privacy`, print the summary lines and the URL, then
  `Accept? y accept · n quit · d delete my account`. `y` accepts and runs the command once more (safe: the gate
  answers before the server changes anything); `n` exits 4; `d` runs the `delete-account` flow.
- Without a TTY (`/mokkan` through Claude, Codex, `sync`): print the 403 message and the URL and exit 4.
- A 409 on accept (the version changed while the prompt was open): fetch `/privacy` again and show the prompt once
  more; a second 409 exits 2.

### Commands

- `mokkan accept`: the prompt on demand. Without a TTY it requires `--yes`; `--yes` prints the summary and accepts.
  `--version <v>` accepts only that version (409 if stale): the pane passes the version it showed.
- `mokkan privacy [--json]`: version, URL and summary; no login needed.
- `mokkan register`:
  - With a TTY: fetch `/privacy` and show the summary and URL before sending the one-time code; continue only on
    `y`. `--complete` sends the version; on 409 it shows the new summary, asks again and retries with the same code.
  - Without a TTY: `--start` and `--complete` both require `--accept-privacy <version>` (the pane passes the version
    it showed); without it they exit 1 with `Register in a terminal, or pass --accept-privacy <version> after showing the policy`.
- `mokkan delete-account`:
  - Without a TTY: `Run it in a terminal: mokkan delete-account (or npx @vicmpen/mokkan-cli delete-account …)`, exit 1.
  - `GET /me` (exempt) gives the email, `reminder_count` and the balance: `This deletes <email>, its 12 reminders and
    42 unspent credits. Payment records are kept without your name.`
  - Asks for the password, then for the word `delete` typed out; anything else aborts with exit 1.
  - Calls `DELETE /me`; on `wrong_password` says so and exits 1. On success removes `credentials.json` and
    `hook.log*` from `~/.config/mokkan/` and prints `Account deleted.` (The pane's cached list lives in Claude
    Code's plugin store; the pane clears it when its next sync finds no login.)
- `mokkan help` gains a privacy line: the policy URL and `delete-account`.

### Skills

- `/mokkan` skill (`claude-plugin/skills/mokkan/SKILL.md`): never run `accept` or `delete-account`; on output
  that asks to accept the privacy policy, tell the user to run `mokkan accept` in a terminal.
- Codex skill (`codex/SKILL.md`): the same two rules, and exit 4 means "the user must accept the updated privacy
  policy in a terminal; stop using mokkan for this task".

### Hooks and `mokkan watch`

- `src/hooks.ts`: a 403 `privacy_not_accepted` goes into the hourly branch next to 402/429 (`:88-95`), with
  marker `hook.log.403.notified`: logged once, then at most hourly.
- `mokkan watch` (`src/watcher.ts:36-40`): a 403 `privacy_not_accepted` stops it with the 403 message, exit 4.

### `mokkan ui`

On a 403 `privacy_not_accepted` from any call, the full screen shows an acceptance view: the summary, the URL,
`y accept · n quit · d delete`. `d` leaves the full screen and runs the `delete-account` flow in the plain
terminal. (`mokkan ui` has a login screen but no registration, so it needs no summary step.)

### Pane (`claude-plugin/hooks/pane.tsx`)

- **Any** exit 4, from `sync` or from a command (`act()`, `pane.tsx:202-211`), runs `privacy --json` and shows an
  acceptance view in place of the list: the summary wrapped to the pane width, the URL, `y accept · n close`, and
  `delete instead: in a terminal run mokkan delete-account (or npx @vicmpen/mokkan-cli delete-account)`.
- `y` runs `accept --yes --version <v>`, then refreshes; on exit 4 again (stale) it fetches and shows the new
  summary. `n` closes the pane.
- The cached list in `$.store` is kept (the account still exists), unlike the logged-out case.
- Registration (`pane.tsx:601` and `:624`): before asking for the email, run `privacy --json` and show the summary
  and URL with `y continue · n cancel`; on `y` pass `--accept-privacy <version>` to `register --start` and
  `register --complete`.
- Help view (`h`): add to `HELP_TEXT`
  `Privacy policy: mokkan.dev/privacy. To delete your account and everything on it, run mokkan delete-account in a terminal (or npx @vicmpen/mokkan-cli delete-account).`

### Tests

- CLI with the fake server: exit 4 without a TTY; TTY prompt `y` (accept and retry), `n` (exit 4), `d` (delete
  flow), 409 on accept (re-show once); `accept` with and without `--yes`/`--version`; `privacy --json`;
  `register` with a TTY (summary shown, `n` sends no code, version sent, 409 re-asks) and without
  (`--accept-privacy` required on both steps); `delete-account` refused without a TTY, wrong word aborts,
  `wrong_password` reported without a token refresh, success removes the local files.
- Hooks: a 403 logged once, then hourly. Watcher: stops with exit 4.
- TUI: the acceptance view and its keys.
- Pane: exit 4 from `sync` and from a command both show the acceptance view; `y` accepts and refreshes; `n`
  closes; the cache survives; registration shows the summary first and passes the version; the help view has the
  delete line.

### Docs

README: the Privacy section links to `mokkan.dev/privacy` and documents `accept`, `privacy` and `delete-account`;
the command list and the exit-code notes gain them. CHANGELOG entry.

## 3. Policy page (`mokkan-site`)

`privacy/index.html` (served as `/privacy` by a plain static host, no rewrite needed), in the landing page's
styles, linked from the footer of `index.html`. Version date at the top. A note at the top of the draft (removed
before publishing): have it reviewed by someone qualified before it goes live.

Contents:

- **Who**: Victor Benetatos, Greece, running mokkan as a personal project. Contact: info@mokkan.dev.
- **What is stored on the server and why**:
  - Account: email, a password hash, when it was created, which policy version you accepted and when.
  - Reminders and todos: text, due times and their history (added, shown, acked, done, emailed).
  - Sessions: login tokens with a device label (the client's User-Agent); refresh tokens last 90 days and are
    deleted a day after they expire.
  - Heartbeats: when a session last checked in, and from which client; used to decide whether to email a due
    reminder.
  - Billing: credit balance, the credit ledger, edit count, your Stripe customer id, and purchases (Stripe ids,
    amount, currency; never card details).
  - Feedback you send with `mokkan feedback`: stored, and emailed to the developer with your address.
  - IP addresses: in rate-limit records (deleted about a day later) and in logs (below); abuse prevention and
    operating the service.
- **Legal basis**: performing the service you signed up for (account, reminders, billing); legitimate interest
  (security, abuse prevention, logs); legal obligation (keeping payment records). The policy is not a request for
  consent.
- **Who else receives data**:
  - Hosting: the server and its database run in Germany (EU).
  - Stripe receives your email and account id when you first buy credits, and your account id with each
    purchase. Stripe keeps its own records under its own privacy policy, independently of mokkan, and may process
    data outside the EU under standard contractual clauses.
  - Zoho Mail sends the one-time codes, due reminders (with their text), low-credit notices and feedback. Sent
    mail may be kept in the mokkan mailbox [FILL IN: whether "save sent copies" is off for the sending account].
  - Nothing is sold, and there are no ads, analytics or trackers.
- **On your machine**: `~/.config/mokkan/` holds `credentials.json` (login tokens) and `hook.log`. The Claude Code
  pane keeps a copy of your last list in Claude Code's plugin storage. `mokkan logout` or deleting the directory
  removes the login.
- **How long**:
  - Account data: until you delete the account.
  - Login tokens and one-time codes: deleted a day after they expire.
  - Server and proxy logs (with IP addresses): up to 14 days.
  - Database backups: the last 10 daily backups, so deleted data leaves them within about 10 days.
  - Payment records: kept after deletion without any link to you, for accounting and tax.
  - Feedback emails in the developer's mailbox, and Stripe's own records, are not removed by deleting your account;
    ask by email to have the feedback emails deleted.
- **Your rights**: access, correction, deletion (`mokkan delete-account` in a terminal, or email info@mokkan.dev),
  portability (`mokkan list --json`, or ask), objection, and complaint to a data protection authority (the Hellenic Data
  Protection Authority, https://www.dpa.gr/en).
- **Deleting your account**: what is removed, that payment records stay anonymised, that unspent credits are lost,
  that an email already being sent may still arrive.
- **Changes**: a new version is announced in the clients, which ask you to accept it before continuing; reminders
  you already have are still delivered in the meantime.

### Summary served by `GET /privacy`

```
mokkan stores your email, your reminders and your credit history on a server in Germany, to sync them between
sessions and email you due reminders.
Payments go through Stripe; emails go through Zoho Mail. No ads, analytics or tracking; nothing is sold.
Logs with IP addresses are kept up to 14 days, backups about 10.
Delete your account any time with `mokkan delete-account` in a terminal.
```

## 4. Production host and accounts (manual)

So the policy's statements are true:

- pm2 does not rotate logs by default. Install `pm2-logrotate` with `retain 14` and `rotateInterval '0 0 * * *'`,
  and delete existing logs older than 14 days in `~/.pm2/logs`.
- nginx: check `/etc/logrotate.d/nginx` keeps 14 days (`rotate 14`, `daily`); set it if not.
- Backups: confirm the cron runs `backup.sh --keep 10` daily.
- Zoho: decide whether the sending account keeps sent copies, and fill in the policy accordingly.
- Data processing agreements: check that the hosting provider, Zoho and Stripe each have one in place (usually
  accepted with their terms).
- A personal data breach must be reported to the data protection authority within 72 hours; note the authority's
  contact for that.

## Rollout order

Everything ships together before launch; nothing older is in use.

1. Publish `mokkan.dev/privacy`.
2. Host: log rotation, backups, Zoho setting (section 4).
3. Wipe the production database if it holds test accounts; deploy the server with `PRIVACY_VERSION=2026-10-04`
   and run `npm run migrate`.
4. Release the CLI and plugin.

## Out of scope

- Refunding unspent credits on deletion.
- Deleting the Stripe customer object.
- Account deletion from the pane, Codex or `/mokkan`.
- Translations of the policy.

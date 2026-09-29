/** A mistake by the user (bad arguments, not logged in, empty list). Exit code 1. */
export class UserError extends Error {
  constructor(message: string) { super(message); this.name = 'UserError'; }
}

/**
 * The server rejected our refresh token (expired, revoked, or rotated by another machine). The local credentials
 * are dead and have been removed; the only way forward is a fresh login. Exit code 1.
 */
export class SessionExpiredError extends UserError {
  constructor() { super('Session expired on this machine; run: mokkan login'); this.name = 'SessionExpiredError'; }
}

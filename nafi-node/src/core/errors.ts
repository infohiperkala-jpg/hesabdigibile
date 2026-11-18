/** Authorisation / not-found / expired-session style failures (carry an HTTP status). */
export class HttpError extends Error { constructor(message: string, public status = 400) { super(message); this.name = 'HttpError'; } }
/** Validation failure with a user-safe Persian message. */
export class Invalid extends Error { constructor(message: string) { super(message); this.name = 'Invalid'; } }

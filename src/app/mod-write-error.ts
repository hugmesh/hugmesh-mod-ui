import { HttpErrorResponse } from '@angular/common/http';

/**
 * The failure half of every {@link ModBffService} write, and the sentence the
 * console shows for it.
 *
 * <h2>Why this exists</h2>
 * Every write in {@code ModBffService} used to end in a bare
 * {@code .catch(() => null)}. The HTTP status, the response body and the
 * response headers were all discarded there, so {@code null} was the service's
 * ENTIRE vocabulary for failure — and the console, having nothing else, guessed
 * a reason: a 401 expired session, a 502 from the gateway, an offline browser
 * and a step-up 403 all rendered as
 * {@code "you cannot ban yourself or a moderator/administrator"}. That sentence
 * was a false accusation for most of the failures it was printed for.
 *
 * <h2>What is carried out now</h2>
 * The three things a caller needs to tell those failures apart:
 *  - {@link ModWriteError#status} — the HTTP status, or {@code 0} when NO
 *    response reached the browser at all (network / DNS / CORS / offline).
 *    {@code 0} matters: it is the one case where we genuinely do not know
 *    whether the write was applied, and the console must not claim it was
 *    rejected.
 *  - {@link ModWriteError#body} — the response body exactly as Angular
 *    delivered it (a parsed object, or the raw text when it did not parse),
 *    plus {@code serverMessage}, the human sentence dug out of it when there is
 *    one.
 *  - {@link ModWriteError#stepUpSignal} — the {@code X-Step-Up-Required}
 *    response header, the platform's structured "this action needs a fresh MFA
 *    step-up" signal (see hugmesh-admin-ui {@code src/app/mfa/step-up-error.ts},
 *    which detects it the same way).
 *
 * <h2>Scope: this is the seam, not the dialog</h2>
 * Carrying the step-up signal out of the service is deliberately NOT the same
 * thing as wiring the step-up dialog. hugmesh-mod-ui#1 (port admin-ui's
 * {@code MfaStepUpDialogComponent} in front of ban/lift, domain-lock/unlock and
 * block) stays open, and mod-bff does not stamp this header yet — its
 * {@code ModStepUpGate} denial is still a bare Spring 403 with no body. What
 * changed here is only that a signal, whenever mod-bff starts sending one, now
 * REACHES UI code instead of being swallowed. See hugmesh-mod-ui#14.
 */
export const STEP_UP_SIGNAL_HEADER = 'X-Step-Up-Required';

/** Longest server sentence we will echo into the console verbatim. */
const MAX_MESSAGE = 300;
/** Longest raw-body snippet we will echo when there is no recognisable message. */
const MAX_BODY_SNIPPET = 200;
/** Longest header value we will echo (the value is server-controlled text). */
const MAX_SIGNAL = 60;

/** Collapse control characters / whitespace and cap the length of untrusted text. */
function tidy(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The human sentence inside an error body, when there is one.
 *
 * <p>Order matters. Spring's default error envelope is
 * {@code {timestamp, status, error: "Forbidden", message: "...", path}} — its
 * {@code error} is the STATUS REASON PHRASE, not a message, so {@code message}
 * is consulted first. hugmesh's own {@code ApiException} envelope is
 * {@code {error: "<sentence>"}}, which is why {@code error} is still consulted.
 */
export function serverMessageOf(body: unknown): string | null {
  if (typeof body === 'string') {
    const t = body.trim();
    // An HTML error page (a gateway/nginx interstitial) is not a message.
    if (!t || t.startsWith('<')) return null;
    return tidy(t, MAX_MESSAGE) || null;
  }
  if (!body || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'error_description'] as const) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return tidy(value, MAX_MESSAGE) || null;
  }
  // Angular's json responseType puts an UNPARSEABLE body under `text` (with the
  // SyntaxError under `error`, which the loop above skipped because it is not a
  // string). Fall back to the raw text the server actually sent.
  const text = rec['text'];
  if (typeof text === 'string' && text.trim()) return serverMessageOf(text);
  return null;
}

/** A short, safe rendering of a body that carried no recognisable message. */
export function bodySnippetOf(body: unknown): string | null {
  if (body === null || body === undefined || body === '') return null;
  if (typeof body === 'string') {
    const t = tidy(body, MAX_BODY_SNIPPET);
    return t && !t.startsWith('<') ? t : null;
  }
  if (typeof body !== 'object') return tidy(String(body), MAX_BODY_SNIPPET) || null;
  // A ProgressEvent (the network-failure "body") says nothing worth showing.
  if (typeof ProgressEvent !== 'undefined' && body instanceof ProgressEvent) return null;
  try {
    const json = JSON.stringify(body);
    return json && json !== '{}' ? tidy(json, MAX_BODY_SNIPPET) || null : null;
  } catch {
    return null;
  }
}

/**
 * A {@link ModBffService} write that did not succeed, carrying the wire facts
 * the caller needs. Extends {@code Error}, and its {@code message} is the
 * server's own sentence when there is one, so ordinary
 * {@code e instanceof Error ? e.message : ...} handling still reads sensibly.
 */
export class ModWriteError extends Error {
  constructor(
    message: string,
    /** HTTP status, or {@code 0} when no response reached the browser. */
    readonly status: number,
    /** HTTP reason phrase, when the response carried one. */
    readonly statusText: string,
    /** The response body as delivered — parsed object, raw text, or null. */
    readonly body: unknown,
    /** The sentence dug out of {@code body}, or null when it carried none. */
    readonly serverMessage: string | null,
    /** The {@code X-Step-Up-Required} header value, when the response had one. */
    readonly stepUpSignal: string | null,
  ) {
    super(message);
    this.name = 'ModWriteError';
  }

  /** True when no response reached the browser — the write's fate is UNKNOWN. */
  get noResponse(): boolean {
    return this.status === 0;
  }

  /**
   * Normalise anything thrown by the generated client. An
   * {@link HttpErrorResponse} yields its status / body / headers; anything else
   * (an rxjs {@code EmptyError}, a thrown string, a bug) yields status {@code 0}
   * so the console reports an unknown fate rather than inventing a rejection.
   */
  static from(e: unknown): ModWriteError {
    if (e instanceof HttpErrorResponse) {
      const message = serverMessageOf(e.error);
      const rawSignal = e.headers.get(STEP_UP_SIGNAL_HEADER);
      return new ModWriteError(
        message ?? e.message,
        e.status,
        e.statusText || '',
        e.error,
        message,
        rawSignal ? tidy(rawSignal, MAX_SIGNAL) || null : null,
      );
    }
    const fallback = e instanceof Error ? e.message : typeof e === 'string' ? e : 'the request failed';
    return new ModWriteError(fallback, 0, '', null, null, null);
  }

  /**
   * A 2xx whose envelope did not contain the entity it promised (e.g. a
   * {@code POST /bff/mod/moderation/{id}/refer} that answers 200 with no
   * {@code request} key). Not a transport failure — the status IS known and is
   * reported as such, because "the server accepted this and returned nothing" is
   * a different problem from "the server refused".
   */
  static malformed(status: number, statusText: string, body: unknown, expected: string): ModWriteError {
    const message = `the server answered ${status} but the response carried no ${expected}`;
    return new ModWriteError(message, status, statusText, body, serverMessageOf(body), null);
  }
}

/** A write outcome: the value on success, a {@link ModWriteError} on failure. */
export type ModWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ModWriteError };

/** Wrap a successful write value. */
export function writeOk<T>(value: T): ModWriteResult<T> {
  return { ok: true, value };
}

/** Wrap a failed write. */
export function writeFailed<T>(error: ModWriteError): ModWriteResult<T> {
  return { ok: false, error };
}

/**
 * The sentence the console shows for a failed write: what the server said, at
 * what status, and — where the status genuinely determines it — what that means
 * for the action.
 *
 * <p>The rule this function exists to enforce: NEVER assert a reason the client
 * cannot know. A 403 with no body is reported as a refusal WITHOUT a cause, with
 * the plausible causes named as possibilities; the old code asserted one of them
 * as fact. A status 0 is reported as an UNKNOWN fate, because a request that
 * never got a response may still have been applied.
 *
 * @param error the failure
 * @param action the action, lower-case, as it reads mid-sentence ("ban", "domain-lock")
 * @param hint what an AMBIGUOUS refusal (403 / 404 / 409) on THIS action usually
 *        means. Offered as a possibility, and ONLY when the server itself gave
 *        no reason — never on a 5xx, a 401 or a dropped connection, whose cause
 *        the status already settles and where the old code's guess was simply
 *        wrong.
 */
export function describeWriteFailure(error: ModWriteError, action: string, hint?: string): string {
  const hasSaid =
    !!error.serverMessage && error.serverMessage.toLowerCase() !== error.statusText.toLowerCase();
  const said = hasSaid ? ` The server said: "${error.serverMessage}".` : '';
  // If the body carried a message at all we either show it (hasSaid) or it was
  // nothing but the status reason phrase — in both cases dumping the raw body on
  // top of it adds noise and, worse, would suppress the caller's hint.
  const rawBody = error.serverMessage ? null : bodySnippetOf(error.body);
  const snippet = rawBody ? ` Response body: ${rawBody}.` : '';
  // What the server said, if anything — and only if it said nothing, the caller's
  // hint, explicitly marked as OUR guess rather than the server's word.
  const because = said || snippet;
  const offered = because || !hint ? '' : ` The server gave no reason; ${hint}`;
  const stepUp = error.stepUpSignal
    ? ` The server signalled that a fresh MFA step-up is required (${STEP_UP_SIGNAL_HEADER}: ${error.stepUpSignal});` +
      ' this console cannot complete a step-up yet, so the action cannot be retried here.'
    : '';
  const at = `HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''}`;

  if (error.noResponse) {
    return (
      `The ${action} got NO response from the server (${error.message}). ` +
      'It may or may not have been applied — check the audit trail before retrying.'
    );
  }
  if (error.status === 401) {
    return `The ${action} was not accepted — ${at}: your session is no longer valid. Sign in again and retry.${said}`;
  }
  if (error.status === 403) {
    return `The ${action} was refused — ${at}.${because}${offered}${stepUp}`;
  }
  if (error.status === 404) {
    return `The ${action} was not applied — ${at}: the target or record was not found.${because}${offered}`;
  }
  if (error.status === 409) {
    return `The ${action} conflicted with the current state — ${at}.${because}${offered}`;
  }
  if (error.status === 429) {
    return `The ${action} was rate-limited — ${at}. Wait and retry.${said}${snippet}`;
  }
  if (error.status >= 500) {
    return (
      `The ${action} failed server-side — ${at}.${said}${snippet}` +
      ' It may or may not have been applied — check the audit trail before retrying.'
    );
  }
  if (error.status >= 400) {
    return `The ${action} was rejected as invalid — ${at}.${said}${snippet}`;
  }
  return `The ${action} did not complete — ${at}.${said}${snippet}`;
}

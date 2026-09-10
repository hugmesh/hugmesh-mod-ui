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
/**
 * <p>CORS caveat for whoever lands #1: this is a NON-SIMPLE response header, so
 * JS can only read it when the response carries
 * {@code Access-Control-Expose-Headers: X-Step-Up-Required}. mod-ui is
 * same-origin today (the generated {@code rootUrl} is {@code ''} and every path
 * is {@code /bff/mod/**}), so nothing is broken — but confirm the gateway
 * exposes it before relying on the header leg over the body-phrase leg.
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

/**
 * Canonical HTTP reason phrases, by status.
 *
 * <h2>Why the client needs its own table</h2>
 * HTTP/2 and HTTP/3 removed the reason phrase from the wire entirely, so
 * {@code xhr.statusText} is the empty string for EVERY response over those
 * protocols. Angular does not leave it empty — its XHR backend substitutes a
 * literal: {@code const statusText = xhr.statusText || 'OK'}
 * ({@code @angular/common/fesm2022/_module-chunk.mjs:1649}), and
 * {@code 'Unknown Error'} on the transport-failure path (:1717). Its fetch
 * backend (:829) passes {@code response.statusText} straight through, which
 * over h2 is {@code ''}.
 *
 * <p>Both are traps for a client that trusts {@code statusText}: a 403 over h2
 * arrives with {@code statusText === 'OK'}, which renders as the
 * self-contradicting {@code "HTTP 403 OK"} and — worse — stops matching the
 * reason phrase Spring puts in its {@code {error}} field, so the envelope
 * {@code {timestamp,status,error:"Forbidden",path}} gets ECHOED as if it were a
 * real explanation, which in turn suppresses the caller's hint. This app is
 * exposed to exactly that: {@code src/bootstrap.ts:20} calls
 * {@code provideHttpClient(withInterceptors([authInterceptor]))} with no
 * {@code withFetch()}, so the XHR backend is in play, and in production the
 * host shell chooses the backend for us.
 *
 * <p>So the phrase we DISPLAY and the phrase we compare a server message
 * against both come from the status, not from the wire. See hugmesh-mod-ui#14.
 */
const REASON_PHRASES: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  423: 'Locked',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

/**
 * True when {@code statusText} is a phrase Angular INVENTED rather than one the
 * server sent — see {@link REASON_PHRASES}. {@code 'OK'} on a non-2xx is always
 * the substitution (no server sends it); so are the two transport literals.
 */
function isSubstitutedPhrase(status: number, statusText: string): boolean {
  const t = statusText.trim().toLowerCase();
  if (!t) return true;
  if (t === 'ok') return status < 200 || status >= 300;
  return t === 'unknown error' || t === 'request timeout';
}

/**
 * The reason phrase to SHOW for a response: the server's own when it really
 * sent one, the canonical phrase for the status when it did not (h2/h3), and
 * nothing at all for a status with no canonical phrase.
 */
export function displayReason(status: number, statusText: string): string {
  if (!isSubstitutedPhrase(status, statusText)) return statusText.trim();
  return REASON_PHRASES[status] ?? '';
}

/**
 * True when a body's "message" is nothing but the status reason phrase — the
 * shape of Spring's default envelope, whose {@code error} field is the phrase
 * and not an explanation. Compared against the CANONICAL phrase for the status
 * (so it still holds over h2, where {@code statusText} is a fabrication) as well
 * as against a genuine wire phrase.
 */
function isOnlyReasonPhrase(message: string, status: number, statusText: string): boolean {
  const m = message.trim().toLowerCase();
  if (!m) return true;
  const canonical = REASON_PHRASES[status];
  if (canonical && m === canonical.toLowerCase()) return true;
  const shown = displayReason(status, statusText).toLowerCase();
  return !!shown && m === shown;
}

/**
 * True when the body is an HTML page rather than an API response — a gateway or
 * nginx interstitial. {@link serverMessageOf} and {@link bodySnippetOf} both
 * (correctly) refuse to echo one, which would otherwise leave the sentence with
 * no reason at all and let the caller's hint be offered for a refusal that never
 * reached the moderation service.
 */
export function isHtmlBody(body: unknown): boolean {
  if (typeof body === 'string') return body.trim().startsWith('<');
  if (body && typeof body === 'object') {
    const text = (body as Record<string, unknown>)['text'];
    return typeof text === 'string' && text.trim().startsWith('<');
  }
  return false;
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
  // The phrase comes from the STATUS, never from the wire: over HTTP/2 there is
  // no reason phrase and Angular substitutes 'OK', which would otherwise render
  // "HTTP 403 OK" and make Spring's `{error:"Forbidden"}` envelope look like a
  // real explanation. See REASON_PHRASES.
  const reason = displayReason(error.status, error.statusText);
  const hasSaid =
    !!error.serverMessage && !isOnlyReasonPhrase(error.serverMessage, error.status, error.statusText);
  const said = hasSaid ? ` The server said: "${error.serverMessage}".` : '';
  // If the body carried a message at all we either show it (hasSaid) or it was
  // nothing but the status reason phrase — in both cases dumping the raw body on
  // top of it adds noise and, worse, would suppress the caller's hint.
  const rawBody = error.serverMessage ? null : bodySnippetOf(error.body);
  const snippet = rawBody ? ` Response body: ${rawBody}.` : '';
  // A gateway interstitial is not an API reason, but it IS a fact worth stating:
  // it says the refusal probably never reached the moderation service, and it
  // stops the hint being offered for a denial the hint cannot explain.
  const interstitial =
    !hasSaid && !rawBody && isHtmlBody(error.body)
      ? ' The response was an HTML error page rather than an API response, so it probably came from' +
        ' the gateway and not the moderation service.'
      : '';
  // What the server said, if anything — and only if it said nothing, the caller's
  // hint, explicitly marked as OUR guess rather than the server's word.
  const because = said || snippet || interstitial;
  const offered = because || !hint ? '' : ` The server gave no reason; ${hint}`;
  // Carried on ANY status, so it is RENDERED on any status: a gate may deny with
  // 401, or with 428 Precondition Required (the conventional step-up status), and
  // announcing "sign in again" while dropping the signal would be the same class
  // of wrong answer this whole change exists to remove.
  const stepUp = error.stepUpSignal
    ? ` The server signalled that a fresh MFA step-up is required (${STEP_UP_SIGNAL_HEADER}: ${error.stepUpSignal});` +
      ' this console cannot complete a step-up yet, so the action cannot be retried here.'
    : '';
  const at = `HTTP ${error.status}${reason ? ` ${reason}` : ''}`;

  return `${sentence(error, action, at, said, snippet, because, offered)}${stepUp}`;
}

/** The status-determined half of {@link describeWriteFailure}'s sentence. */
function sentence(
  error: ModWriteError,
  action: string,
  at: string,
  said: string,
  snippet: string,
  because: string,
  offered: string,
): string {
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
    return `The ${action} was refused — ${at}.${because}${offered}`;
  }
  if (error.status === 404) {
    return `The ${action} was not applied — ${at}: the target or record was not found.${because}${offered}`;
  }
  if (error.status === 409) {
    return `The ${action} conflicted with the current state — ${at}.${because}${offered}`;
  }
  if (error.status === 428) {
    // The conventional step-up status. The privileged/self-target hint is NOT
    // offered here — 428 already settles the cause, and the step-up clause
    // describeWriteFailure appends says the rest.
    return `The ${action} was not applied — ${at}: the server requires a further precondition before it will accept this.${because}`;
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

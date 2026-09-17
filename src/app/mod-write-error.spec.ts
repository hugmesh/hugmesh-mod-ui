import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  ModWriteError,
  STEP_UP_SIGNAL_HEADER,
  bodySnippetOf,
  describeWriteFailure,
  displayReason,
  isHtmlBody,
  serverMessageOf,
} from './mod-write-error';

/**
 * The unit that replaces `.catch(() => null)` (hugmesh-mod-ui#14). Two things are
 * under test and both are the POINT of the change:
 *  1. the wire facts survive — status, body, and the X-Step-Up-Required header;
 *  2. the console's sentence never ASSERTS a reason the client cannot know.
 */
describe('mod-write-error', () => {
  describe('serverMessageOf', () => {
    it('prefers Spring’s {message} over its {error} status-reason-phrase', () => {
      const spring = {
        timestamp: '2026-09-09T00:00:00Z',
        status: 403,
        error: 'Forbidden',
        message: 'target is a moderator',
        path: '/bff/mod/ban',
      };
      expect(serverMessageOf(spring)).toBe('target is a moderator');
    });

    it('reads hugmesh’s own {error: "<sentence>"} ApiException envelope', () => {
      expect(serverMessageOf({ error: 'ban requires step-up re-authentication' })).toBe(
        'ban requires step-up re-authentication',
      );
    });

    it('accepts a plain-text body', () => {
      expect(serverMessageOf('upstream timed out')).toBe('upstream timed out');
    });

    it('refuses an HTML interstitial (a gateway error page is not a message)', () => {
      expect(serverMessageOf('<html><body>502 Bad Gateway</body></html>')).toBeNull();
    });

    it('falls back to Angular’s {text} when the JSON body did not parse', () => {
      // Angular's json responseType delivers { error: SyntaxError, text: '<raw>' }.
      expect(serverMessageOf({ error: new SyntaxError('bad json'), text: 'plain refusal' })).toBe(
        'plain refusal',
      );
    });

    it('returns null for an empty or non-message body', () => {
      expect(serverMessageOf(null)).toBeNull();
      expect(serverMessageOf({})).toBeNull();
      expect(serverMessageOf({ state: 'pending-reconcile' })).toBeNull();
    });

    it('flattens control characters and caps the length', () => {
      const flattened = serverMessageOf('a\nb\tc');
      expect(flattened).toBe('a b c');
      const long = serverMessageOf('x'.repeat(500))!;
      expect(long.length).toBeLessThanOrEqual(300);
      expect(long.endsWith('…')).toBeTrue();
    });
  });

  describe('bodySnippetOf', () => {
    it('renders an object body as compact JSON', () => {
      expect(bodySnippetOf({ code: 'E_LOCKED' })).toBe('{"code":"E_LOCKED"}');
    });

    it('says nothing for an empty object, null, or an HTML page', () => {
      expect(bodySnippetOf({})).toBeNull();
      expect(bodySnippetOf(null)).toBeNull();
      expect(bodySnippetOf('<html>oops</html>')).toBeNull();
    });

    it('says nothing for the ProgressEvent a network failure carries', () => {
      expect(bodySnippetOf(new ProgressEvent('error'))).toBeNull();
    });
  });

  describe('ModWriteError.from', () => {
    it('carries status, statusText, body and the step-up header out of an HttpErrorResponse', () => {
      const e = ModWriteError.from(
        new HttpErrorResponse({
          status: 403,
          statusText: 'Forbidden',
          error: { error: 'ban requires step-up re-authentication' },
          headers: new HttpHeaders({ [STEP_UP_SIGNAL_HEADER]: 'X-ModBan-StepUp' }),
          url: '/bff/mod/ban',
        }),
      );
      expect(e.status).toBe(403);
      expect(e.statusText).toBe('Forbidden');
      expect(e.body).toEqual({ error: 'ban requires step-up re-authentication' });
      expect(e.serverMessage).toBe('ban requires step-up re-authentication');
      expect(e.stepUpSignal).toBe('X-ModBan-StepUp');
      expect(e.noResponse).toBeFalse();
      expect(e instanceof Error).toBeTrue();
    });

    it('reports a bodyless 403 with no invented reason', () => {
      const e = ModWriteError.from(new HttpErrorResponse({ status: 403, statusText: 'Forbidden', error: null }));
      expect(e.status).toBe(403);
      expect(e.serverMessage).toBeNull();
      expect(e.stepUpSignal).toBeNull();
    });

    it('reports status 0 for a request that never got a response', () => {
      const e = ModWriteError.from(
        new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', error: new ProgressEvent('error') }),
      );
      expect(e.status).toBe(0);
      expect(e.noResponse).toBeTrue();
    });

    it('reports status 0 for a non-HTTP throwable rather than inventing a rejection', () => {
      expect(ModWriteError.from(new Error('no elements in sequence')).status).toBe(0);
      expect(ModWriteError.from('boom').message).toBe('boom');
      expect(ModWriteError.from(undefined).status).toBe(0);
    });

    it('truncates a server-controlled step-up header value before it is ever echoed', () => {
      const e = ModWriteError.from(
        new HttpErrorResponse({
          status: 403,
          statusText: 'Forbidden',
          headers: new HttpHeaders({ [STEP_UP_SIGNAL_HEADER]: 'X-'.padEnd(500, 'a') }),
        }),
      );
      expect(e.stepUpSignal!.length).toBeLessThanOrEqual(60);
    });
  });

  describe('ModWriteError.malformed', () => {
    it('keeps the REAL status of a 2xx that carried no entity', () => {
      const e = ModWriteError.malformed(200, 'OK', {}, 'referred request');
      expect(e.status).toBe(200);
      expect(e.message).toContain('carried no referred request');
      expect(e.noResponse).toBeFalse();
    });
  });

  describe('describeWriteFailure', () => {
    const hint = 'usually a privileged or self target.';
    const bare = (status: number, statusText: string) =>
      new ModWriteError(`Http failure response: ${status}`, status, statusText, null, null, null);

    it('never claims a rejection when no response arrived', () => {
      const text = describeWriteFailure(bare(0, ''), 'ban', hint);
      expect(text).toContain('NO response');
      expect(text).toContain('may or may not have been applied');
      expect(text).not.toContain('privileged');
    });

    it('names an expired session on a 401', () => {
      const text = describeWriteFailure(bare(401, 'Unauthorized'), 'ban', hint);
      expect(text).toContain('HTTP 401 Unauthorized');
      expect(text).toContain('Sign in again');
      expect(text).not.toContain('privileged');
    });

    it('offers the hint on a bodyless 403, marked as the server having given no reason', () => {
      const text = describeWriteFailure(bare(403, 'Forbidden'), 'ban', hint);
      expect(text).toContain('HTTP 403 Forbidden');
      expect(text).toContain('gave no reason');
      expect(text).toContain('privileged or self target');
    });

    it('prefers the server’s own sentence over the hint', () => {
      const e = new ModWriteError('x', 403, 'Forbidden', { error: 'domain not yours' }, 'domain not yours', null);
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain('domain not yours');
      expect(text).not.toContain('gave no reason');
    });

    it('does not echo a message that is only the status reason phrase', () => {
      const e = new ModWriteError('Forbidden', 403, 'Forbidden', { error: 'Forbidden' }, 'Forbidden', null);
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain('gave no reason');
      expect(text).not.toContain('The server said');
    });

    /**
     * The clause names the signal and STOPS. It used to add "this console cannot
     * complete a step-up yet", which hugmesh-mod-ui#1 falsified for ban /
     * domain-lock / block by wiring an inline challenge dialog in front of them —
     * while this function is still shared with refer / recommend /
     * resolve-finding, which have no dialog. Whether a retry is possible is the
     * caller's fact, not this function's.
     */
    it('announces the step-up signal without claiming anything about a retry', () => {
      const e = new ModWriteError('x', 403, 'Forbidden', null, null, 'X-ModBan-StepUp');
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain(`${STEP_UP_SIGNAL_HEADER}: X-ModBan-StepUp`);
      expect(text).not.toContain('cannot complete a step-up yet');
      expect(text).not.toContain('cannot be retried');
    });

    it('warns that a 5xx may still have applied', () => {
      const text = describeWriteFailure(bare(502, 'Bad Gateway'), 'domain-lock', hint);
      expect(text).toContain('HTTP 502 Bad Gateway');
      expect(text).toContain('check the audit trail');
      expect(text).not.toContain('privileged');
    });

    it('reports a 404 as not-found, a 409 as a conflict and a 429 as rate-limiting', () => {
      expect(describeWriteFailure(bare(404, 'Not Found'), 'lift')).toContain('was not found');
      expect(describeWriteFailure(bare(409, 'Conflict'), 'lift')).toContain('conflicted');
      expect(describeWriteFailure(bare(429, 'Too Many Requests'), 'lift')).toContain('rate-limited');
    });

    it('shows the raw body when a 4xx carried one with no recognisable message', () => {
      const e = new ModWriteError('x', 400, 'Bad Request', { code: 'E_TTL' }, null, null);
      expect(describeWriteFailure(e, 'ban')).toContain('{"code":"E_TTL"}');
    });

    it('reports the malformed-2xx case at its real status', () => {
      const text = describeWriteFailure(
        ModWriteError.malformed(200, 'OK', {}, 'referred request'),
        'referral of request #7',
      );
      expect(text).toContain('HTTP 200 OK');
      expect(text).toContain('did not complete');
    });

    // ── HTTP/2 regression (the skeptic's major on hugmesh-mod-ui#14) ─────────
    // HTTP/2 and HTTP/3 carry no reason phrase, so `xhr.statusText` is '' and
    // Angular's XHR backend substitutes 'OK' (_module-chunk.mjs:1649) on EVERY
    // response including errors. bootstrap.ts:20 uses provideHttpClient without
    // withFetch(), so this deployment gets that backend. These four cases are
    // what a 403 actually looks like there, and each one failed before the
    // status-derived REASON_PHRASES table replaced the trust in statusText.
    it('does not render the self-contradicting "HTTP 403 OK" an h2 response produces', () => {
      const text = describeWriteFailure(bare(403, 'OK'), 'ban', hint);
      expect(text).toContain('HTTP 403 Forbidden');
      expect(text).not.toContain('HTTP 403 OK');
    });

    it('still offers the hint for Spring’s default 403 envelope over h2', () => {
      // {timestamp,status,error:"Forbidden",path} with statusText substituted to
      // 'OK'. Comparing the message against 'OK' let "Forbidden" through as if it
      // were an explanation, which suppressed the hint this change exists to give.
      const e = new ModWriteError('Forbidden', 403, 'OK', { error: 'Forbidden' }, 'Forbidden', null);
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain('gave no reason');
      expect(text).toContain('privileged or self target');
      expect(text).not.toContain('The server said');
    });

    it('still shows a REAL server sentence over h2', () => {
      const e = new ModWriteError('x', 403, 'OK', { error: 'domain not yours' }, 'domain not yours', null);
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain('domain not yours');
      expect(text).not.toContain('gave no reason');
    });

    it('falls back to the canonical phrase when statusText is empty (fetch backend over h2)', () => {
      expect(describeWriteFailure(bare(404, ''), 'lift')).toContain('HTTP 404 Not Found');
      expect(describeWriteFailure(bare(503, ''), 'lift')).toContain('HTTP 503 Service Unavailable');
      // A status with no canonical phrase renders the bare number, not a lie.
      expect(describeWriteFailure(bare(499, ''), 'lift')).toContain('HTTP 499.');
    });

    // ── Step-up rendering (the skeptic's nit 1) ─────────────────────────────
    it('renders the step-up signal on 401 and 428, not only on 403', () => {
      const gone = new ModWriteError('x', 401, 'Unauthorized', null, null, 'totp');
      expect(describeWriteFailure(gone, 'ban', hint)).toContain(`${STEP_UP_SIGNAL_HEADER}: totp`);
      const precondition = new ModWriteError('x', 428, 'Precondition Required', null, null, 'totp');
      const text = describeWriteFailure(precondition, 'ban', hint);
      expect(text).toContain('HTTP 428 Precondition Required');
      expect(text).toContain(`${STEP_UP_SIGNAL_HEADER}: totp`);
      // 428 settles its own cause — the privileged/self-target guess is NOT offered.
      expect(text).not.toContain('privileged or self target');
    });

    // ── Gateway interstitial (the skeptic's nit 3) ──────────────────────────
    it('says an HTML 403 came from the gateway instead of offering the target hint', () => {
      const e = new ModWriteError('x', 403, 'Forbidden', '<html><body>403 Forbidden</body></html>', null, null);
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain('HTML error page');
      expect(text).not.toContain('privileged or self target');
      expect(text).not.toContain('<html>');
    });
  });

  describe('displayReason', () => {
    it('keeps a genuine wire phrase', () => {
      expect(displayReason(403, 'Forbidden')).toBe('Forbidden');
      expect(displayReason(418, 'I am a teapot')).toBe('I am a teapot');
    });

    it('discards Angular’s substitutions on a non-2xx', () => {
      expect(displayReason(403, 'OK')).toBe('Forbidden');
      expect(displayReason(0, 'Unknown Error')).toBe('');
      expect(displayReason(500, 'Unknown Error')).toBe('Internal Server Error');
    });

    it('keeps OK on a real 2xx', () => {
      expect(displayReason(200, 'OK')).toBe('OK');
    });
  });

  describe('isHtmlBody', () => {
    it('detects a raw HTML page and one wrapped in Angular’s {text}', () => {
      expect(isHtmlBody('<!doctype html><html>')).toBe(true);
      expect(isHtmlBody({ text: '  <html>403</html>' })).toBe(true);
    });

    it('is false for JSON, text and nothing', () => {
      expect(isHtmlBody({ error: 'nope' })).toBe(false);
      expect(isHtmlBody('plain refusal')).toBe(false);
      expect(isHtmlBody(null)).toBe(false);
    });
  });
});

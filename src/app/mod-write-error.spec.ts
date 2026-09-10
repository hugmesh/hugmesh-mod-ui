import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import {
  ModWriteError,
  STEP_UP_SIGNAL_HEADER,
  bodySnippetOf,
  describeWriteFailure,
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

    it('announces the step-up signal and that this console cannot satisfy it yet', () => {
      const e = new ModWriteError('x', 403, 'Forbidden', null, null, 'X-ModBan-StepUp');
      const text = describeWriteFailure(e, 'ban', hint);
      expect(text).toContain(`${STEP_UP_SIGNAL_HEADER}: X-ModBan-StepUp`);
      expect(text).toContain('cannot complete a step-up yet');
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
  });
});

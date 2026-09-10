import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { BlockResult, ModAction, ModBffService, ModerationRequest, SystemFinding } from './mod-bff.service';
import { ModWriteError, ModWriteResult } from './mod-write-error';
import { authInterceptor } from './auth.interceptor';
import { SessionService, SnapSession } from './session.service';

function modSession(loggedIn: boolean): SnapSession | null {
  if (!loggedIn) return null;
  return {
    id: 'google:mod@gmail.com',
    label: 'mod@gmail.com',
    provider: 'google',
    roles: ['mod'],
    registrationComplete: true,
  };
}

const sampleRequest: ModerationRequest = {
  id: 7,
  requester: 'user:alice',
  kind: 'instance-block',
  target: 'evil.example',
  reason: 'spam',
  status: 'recommended',
  modReferrer: null,
  adminDecider: null,
  ts: '2026-06-06T00:00:00Z',
};

const sampleAction: ModAction = {
  id: 'a-1',
  actor: 'mod:bob',
  action: 'matrix.block-user',
  platform: 'matrix',
  target: '@spam:evil.example',
  reason: 'abuse',
  result: 'stubbed',
  ts: '2026-06-06T00:00:00',
};

const sampleFinding: SystemFinding = {
  id: 42,
  reporter: '@system',
  subject: 'user:alice',
  surface: 'profile-avatar',
  disposition: 'flagged',
  classification: 'nsfw',
  confidence: 0.93,
  policyHit: true,
  perceptualHash: 'ph:abc',
  status: 'held',
  reviewer: null,
  ts: '2026-06-06T00:00:00Z',
  domain: 'hugmesh.net',
};

/**
 * Migrated to delegate to the generated, typed {@link import('./api/services/moderator.service').ModeratorService}
 * over Angular HttpClient (the {@code authInterceptor} forwards the HttpOnly
 * {@code bff_} session cookie via {@code withCredentials}). These specs therefore
 * assert the wire calls via the {@link HttpTestingController} (URL / method / body
 * / withCredentials / params) rather than spying on {@code fetch} — the SAME
 * same-origin {@code /bff/mod/**} paths the old fetch transport hit (generated
 * {@code rootUrl} is '').
 */
describe('ModBffService', () => {
  let service: ModBffService;
  let httpMock: HttpTestingController;
  const sessionSig = signal<SnapSession | null>(null);

  beforeEach(() => {
    sessionSig.set(modSession(true));
    TestBed.configureTestingModule({
      providers: [
        ModBffService,
        { provide: SessionService, useValue: { session: sessionSig } },
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(ModBffService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  /** Unwrap a write that must have succeeded (fails loudly, with the status, if not). */
  function value<T>(result: ModWriteResult<T>): T {
    if (!result.ok) {
      throw new Error(`expected ok, got HTTP ${result.error.status}: ${result.error.message}`);
    }
    return result.value;
  }

  /** Unwrap a write that must have FAILED, for asserting on the carried wire facts. */
  function failure<T>(result: ModWriteResult<T>): ModWriteError {
    if (result.ok) throw new Error('expected a failure, got ok');
    return result.error;
  }

  function sendsCookie(req: { request: { withCredentials: boolean; headers: { has(n: string): boolean } } }): boolean {
    // The cookie path: credentials are forwarded and the browser holds NO bearer.
    return req.request.withCredentials && !req.request.headers.has('Authorization');
  }

  /**
   * Drain the microtask queue then expect+flush a single request to {@code url}.
   * The service awaits the first call's response BEFORE it issues the follow-up
   * cache-refresh request. With ng-openapi-gen v1 the generated service methods
   * return native Promises (via firstValueFrom internally), so the follow-up
   * request may arrive several microtask ticks after the first flush — we drain
   * multiple ticks to give all Promise .then() chains time to settle.
   */
  async function flushNext(url: string, body: unknown): Promise<void> {
    // Drain several microtask ticks: the Promise chain from the generated service
    // (firstValueFrom → .then → .catch → await loadAudit/loadModeration → .then)
    // needs more than one tick to issue the follow-up HTTP request.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    httpMock.expectOne(url).flush(body as object);
  }

  // ── Auth wiring (interceptor forwards the HttpOnly bff_ cookie, no bearer) ──
  it('forwards the bff_ cookie (withCredentials) and sends NO Authorization bearer', async () => {
    const p = service.loadModeration();
    const req = httpMock.expectOne((r) => r.url === '/bff/mod/moderation');
    expect(sendsCookie(req)).toBeTrue();
    req.flush({ requests: [] });
    await p;
  });

  it('still forwards credentials (no bearer) even when no session metadata exists', async () => {
    sessionSig.set(null);
    const p = service.loadModeration();
    const req = httpMock.expectOne((r) => r.url === '/bff/mod/moderation');
    expect(sendsCookie(req)).toBeTrue();
    req.flush({ requests: [] });
    await p;
  });

  // ── Moderation queue (GET /bff/mod/moderation) ─────────────────────
  it('unwraps the { requests } envelope and pushes it onto the moderation subject', async () => {
    const p = service.loadModeration();
    httpMock.expectOne('/bff/mod/moderation').flush({ requests: [sampleRequest] });
    expect(await p).toEqual([sampleRequest]);
    expect(await firstValueFrom(service.moderation)).toEqual([sampleRequest]);
  });

  it('appends the status query param when filtering the queue', async () => {
    const p = service.loadModeration('referred');
    const req = httpMock.expectOne((r) => r.url === '/bff/mod/moderation');
    expect(req.request.params.get('status')).toBe('referred');
    req.flush({ requests: [] });
    await p;
  });

  it('returns [] (not throw) when the moderation GET fails', async () => {
    const p = service.loadModeration();
    httpMock.expectOne('/bff/mod/moderation').flush(null, { status: 500, statusText: 'Server Error' });
    expect(await p).toEqual([]);
  });

  // ── Refer (POST /bff/mod/moderation/{id}/refer) ────────────────────
  it('POSTs a refer by id, unwraps { request }, and refreshes the queue', async () => {
    const p = service.refer(7);
    const post = httpMock.expectOne('/bff/mod/moderation/7/refer');
    expect(post.request.method).toBe('POST');
    post.flush({ request: { ...sampleRequest, status: 'referred' } });
    // second call refreshes the queue
    await flushNext('/bff/mod/moderation', { requests: [{ ...sampleRequest, status: 'referred' }] });
    const referred = value(await p);
    expect(referred.status).toBe('referred');
    expect((await firstValueFrom(service.moderation))[0].status).toBe('referred');
  });

  // ── Block (POST /bff/mod/block) ────────────────────────────────────
  it('POSTs a JSON block body and refreshes the audit cache on success', async () => {
    const blockResult: BlockResult = { blocked: sampleAction, external: 'stubbed', note: 'STUBBED' };
    const p = service.block({
      platform: 'matrix', scope: 'user', target: '@spam:evil.example', reason: 'abuse',
    });
    const post = httpMock.expectOne('/bff/mod/block');
    expect(post.request.method).toBe('POST');
    expect(post.request.headers.get('Content-Type')).toBe('application/json');
    expect(post.request.body).toEqual({
      platform: 'matrix', scope: 'user', target: '@spam:evil.example', reason: 'abuse',
    });
    post.flush(blockResult);
    await flushNext('/bff/mod/audit', { actions: [sampleAction] });
    const result = value(await p);
    expect(result.external).toBe('stubbed');
    expect(await firstValueFrom(service.audit)).toEqual([sampleAction]);
  });

  it('carries the status out (and does not refresh audit) when the block POST fails', async () => {
    const p = service.block({ platform: 'matrix', scope: 'user', target: 'x' });
    httpMock.expectOne('/bff/mod/block').flush(null, { status: 400, statusText: 'Bad Request' });
    const error = failure(await p);
    expect(error.status).toBe(400);
    expect(error.statusText).toBe('Bad Request');
    httpMock.verify(); // no follow-up audit refresh outstanding
  });

  // ── Recommend (POST /bff/mod/moderation) ───────────────────────────
  it('POSTs a recommendation, unwraps { request }, and refreshes the queue', async () => {
    const p = service.recommend({ kind: 'instance-block', target: 'evil.example', reason: 'spam' });
    const post = httpMock.expectOne('/bff/mod/moderation');
    expect(post.request.method).toBe('POST');
    expect(post.request.headers.get('Content-Type')).toBe('application/json');
    expect(post.request.body).toEqual({ kind: 'instance-block', target: 'evil.example', reason: 'spam' });
    post.flush({ request: sampleRequest });
    await flushNext('/bff/mod/moderation', { requests: [sampleRequest] }); // queue refresh
    expect(value(await p)).toEqual(sampleRequest);
  });

  it('carries the status + server message out when the recommend POST fails', async () => {
    const p = service.recommend({ kind: 'user-removal', target: 'x' });
    httpMock
      .expectOne('/bff/mod/moderation')
      .flush({ error: 'kind is not in the closed vocabulary' }, { status: 400, statusText: 'Bad Request' });
    await flushNext('/bff/mod/moderation', { requests: [] }); // queue refresh still runs
    const error = failure(await p);
    expect(error.status).toBe(400);
    expect(error.serverMessage).toBe('kind is not in the closed vocabulary');
    expect(error.body).toEqual({ error: 'kind is not in the closed vocabulary' });
  });

  // ── Ban / lift (POST/DELETE /bff/mod/ban) ──────────────────────────
  it('POSTs a ban body and refreshes audit, returning the pending-reconcile envelope', async () => {
    const p = service.ban({ platform: 'matrix', target: '@bad:evil.example', ttlSeconds: 3600, reason: 'abuse' });
    const post = httpMock.expectOne('/bff/mod/ban');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      platform: 'matrix', target: '@bad:evil.example', ttlSeconds: 3600, reason: 'abuse',
    });
    post.flush({ state: 'pending-reconcile', propagation: 'queued' });
    await flushNext('/bff/mod/audit', { actions: [sampleAction] }); // audit refresh
    const result = value(await p);
    expect(result.state).toBe('pending-reconcile');
  });

  it('carries the 403 out when the ban POST is rejected (privileged/self target)', async () => {
    const p = service.ban({ platform: 'profile', target: 'an-admin' });
    httpMock.expectOne('/bff/mod/ban').flush(null, { status: 403, statusText: 'Forbidden' });
    const error = failure(await p);
    expect(error.status).toBe(403);
    expect(error.stepUpSignal).toBeNull();
    httpMock.verify(); // no audit refresh on failure
  });

  it('carries the X-Step-Up-Required header out of a gated ban 403', async () => {
    // mod-bff's ModStepUpGate denies with a bare 403 TODAY. This asserts the seam
    // the MFA port (#1) needs: whenever it starts signalling, the signal survives
    // instead of being collapsed to null. See #14.
    const p = service.ban({ platform: 'matrix', target: '@bad:evil.example' });
    httpMock.expectOne('/bff/mod/ban').flush(
      { error: 'ban requires step-up re-authentication' },
      { status: 403, statusText: 'Forbidden', headers: { 'X-Step-Up-Required': 'X-ModBan-StepUp' } },
    );
    const error = failure(await p);
    expect(error.status).toBe(403);
    expect(error.stepUpSignal).toBe('X-ModBan-StepUp');
    expect(error.serverMessage).toBe('ban requires step-up re-authentication');
  });

  it('reports status 0 (fate UNKNOWN), not a rejection, when no response arrives', async () => {
    const p = service.ban({ platform: 'matrix', target: '@bad:evil.example' });
    httpMock.expectOne('/bff/mod/ban').error(new ProgressEvent('network error'));
    const error = failure(await p);
    expect(error.status).toBe(0);
    expect(error.noResponse).toBeTrue();
    httpMock.verify(); // no audit refresh
  });

  it('DELETEs a ban (lift) with the same body shape', async () => {
    const p = service.lift({ platform: 'mastodon', target: 'acct@evil.example' });
    const del = httpMock.expectOne('/bff/mod/ban');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.body).toEqual({ platform: 'mastodon', target: 'acct@evil.example' });
    del.flush({ state: 'restored' });
    await flushNext('/bff/mod/audit', { actions: [] });
    expect(value(await p).state).toBe('restored');
  });

  // ── Domain-lock / unlock (POST/DELETE /bff/mod/domain-lock/{role}/{user}) ──
  it('POSTs a domain-lock with role + url-encoded user in the path and refreshes audit', async () => {
    const p = service.domainLock('ROLE_MATRIX_DOMAINLOCKED', '@x:y.example', { reason: 'evasion' });
    const post = httpMock.expectOne(
      (r) => r.url === `/bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/${encodeURIComponent('@x:y.example')}`,
    );
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({ reason: 'evasion' });
    post.flush({ state: 'pending-reconcile' });
    await flushNext('/bff/mod/audit', { actions: [] });
    expect(value(await p).state).toBe('pending-reconcile');
  });

  it('omits the body on a body-less domain-unlock', async () => {
    const p = service.domainUnlock('ROLE_MASTODON_DOMAINLOCKED', 'bad-user');
    const del = httpMock.expectOne('/bff/mod/domain-lock/ROLE_MASTODON_DOMAINLOCKED/bad-user');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.body).toBeNull();
    del.flush({ state: 'cleared' });
    await flushNext('/bff/mod/audit', { actions: [] });
    expect(value(await p).state).toBe('cleared');
  });

  it('carries the 403 out when the domain-lock POST is rejected', async () => {
    const p = service.domainLock('ROLE_MATRIX_DOMAINLOCKED', 'a-mod');
    httpMock
      .expectOne('/bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/a-mod')
      .flush(null, { status: 403, statusText: 'Forbidden' });
    const error = failure(await p);
    expect(error.status).toBe(403);
    httpMock.verify(); // no audit refresh on failure
  });

  // ── Audit (GET /bff/mod/audit) ─────────────────────────────────────
  it('unwraps the { actions } envelope and pushes it onto the audit subject', async () => {
    const p = service.loadAudit();
    httpMock.expectOne('/bff/mod/audit').flush({ actions: [sampleAction] });
    expect(await p).toEqual([sampleAction]);
    expect(await firstValueFrom(service.audit)).toEqual([sampleAction]);
  });

  it('appends ?mine=true when loading only the caller\'s audit rows', async () => {
    const p = service.loadAudit(true);
    const req = httpMock.expectOne((r) => r.url === '/bff/mod/audit');
    expect(req.request.params.get('mine')).toBe('true');
    req.flush({ actions: [] });
    await p;
  });

  it('falls back to [] when the audit GET fails', async () => {
    const p = service.loadAudit();
    httpMock.expectOne('/bff/mod/audit').flush(null, { status: 503, statusText: 'Unavailable' });
    expect(await p).toEqual([]);
  });

  // ── System findings (GET /bff/mod/findings) ────────────────────────
  it('forwards the bff_ cookie and sends NO bearer when loading findings', async () => {
    const p = service.loadFindings();
    const req = httpMock.expectOne((r) => r.url === '/bff/mod/findings');
    expect(sendsCookie(req)).toBeTrue();
    req.flush({ findings: [] });
    await p;
  });

  it('unwraps the { findings } envelope and pushes it onto the findings subject', async () => {
    const p = service.loadFindings();
    httpMock.expectOne('/bff/mod/findings').flush({ findings: [sampleFinding] });
    expect(await p).toEqual([sampleFinding]);
    expect(await firstValueFrom(service.findings)).toEqual([sampleFinding]);
  });

  it('appends the status query param when filtering the findings queue', async () => {
    const p = service.loadFindings('held');
    const req = httpMock.expectOne((r) => r.url === '/bff/mod/findings');
    expect(req.request.params.get('status')).toBe('held');
    req.flush({ findings: [] });
    await p;
  });

  it('returns [] (not throw) when the findings GET fails', async () => {
    const p = service.loadFindings();
    httpMock.expectOne('/bff/mod/findings').flush(null, { status: 500, statusText: 'Server Error' });
    expect(await p).toEqual([]);
  });

  // ── Resolve a finding (POST /bff/mod/findings/{id}/resolve?actioned=) ──
  it('POSTs a confirm (actioned=true), unwraps { finding }, and refreshes the queue', async () => {
    const p = service.resolveFinding(42, true);
    const post = httpMock.expectOne((r) => r.url === '/bff/mod/findings/42/resolve');
    expect(post.request.method).toBe('POST');
    expect(post.request.params.get('actioned')).toBe('true');
    post.flush({ finding: { ...sampleFinding, status: 'actioned', reviewer: 'mod:bob' } });
    // second call refreshes the queue
    await flushNext('/bff/mod/findings', { findings: [{ ...sampleFinding, status: 'actioned' }] });
    const resolved = value(await p);
    expect(resolved.status).toBe('actioned');
    expect((await firstValueFrom(service.findings))[0].status).toBe('actioned');
  });

  it('POSTs a dismiss with actioned=false', async () => {
    const p = service.resolveFinding(42, false);
    const post = httpMock.expectOne((r) => r.url === '/bff/mod/findings/42/resolve');
    expect(post.request.method).toBe('POST');
    expect(post.request.params.get('actioned')).toBe('false');
    post.flush({ finding: { ...sampleFinding, status: 'dismissed' } });
    await flushNext('/bff/mod/findings', { findings: [] });
    expect(value(await p).status).toBe('dismissed');
  });

  it('carries the 404 out (still refreshing the queue) when the resolve POST is rejected', async () => {
    const p = service.resolveFinding(99, true);
    httpMock
      .expectOne((r) => r.url === '/bff/mod/findings/99/resolve')
      .flush(null, { status: 404, statusText: 'Not Found' });
    // The queue refresh still runs (the failure is returned, not thrown, then loadFindings fires).
    await flushNext('/bff/mod/findings', { findings: [] });
    const error = failure(await p);
    expect(error.status).toBe(404);
    expect(error.statusText).toBe('Not Found');
  });

  // ── The 2xx-with-no-entity case, which is NOT a refusal ────────────
  it('reports a 200 whose envelope carried no { request } as its real status, not as a refusal', async () => {
    const p = service.refer(7);
    httpMock.expectOne('/bff/mod/moderation/7/refer').flush({});
    await flushNext('/bff/mod/moderation', { requests: [] });
    const error = failure(await p);
    expect(error.status).toBe(200);
    expect(error.message).toContain('carried no referred request');
  });
});

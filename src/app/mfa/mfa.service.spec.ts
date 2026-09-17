import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MfaService } from './mfa.service';

describe('MfaService', () => {
  let service: MfaService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(MfaService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts a challenge to the shared same-origin /bff/mfa path, never a mod-bff one', async () => {
    const pending = service.challenge('totp', '123456');
    const req = http.expectOne('/bff/mfa/challenge');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ factor: 'totp', credential: '123456' });
    req.flush({ mfaSatisfied: true });
    await expectAsync(pending).toBeResolvedTo({
      ok: true,
      dark: false,
      status: 200,
      data: { mfaSatisfied: true },
    });
  });

  it('sends no subject of its own — the owner is always the authenticated session', async () => {
    const pending = service.challenge('recovery', 'AAAA-BBBB-CCCC-DDDD');
    const req = http.expectOne('/bff/mfa/challenge');
    expect(Object.keys(req.request.body as object).sort()).toEqual(['credential', 'factor']);
    req.flush({ mfaSatisfied: true });
    await pending;
  });

  it('requests webauthn assertion options from the ASSERT path (never the enroll path)', async () => {
    const pending = service.assertWebauthnOptions();
    const req = http.expectOne('/bff/mfa/assert/webauthn/options');
    expect(req.request.method).toBe('POST');
    req.flush({ challenge: 'Y2g', rpId: 'hugmesh.net', rpName: 'HugMesh' });
    const r = await pending;
    expect(r.ok).toBeTrue();
    expect(r.data?.rpId).toBe('hugmesh.net');
  });

  it('maps the ships-dark 503 to dark, NOT to an error', async () => {
    const pending = service.challenge('totp', '000000');
    http
      .expectOne('/bff/mfa/challenge')
      .flush({ error: 'MFA challenge ships dark (app.casdoor.mfa.enabled=false)' }, {
        status: 503,
        statusText: 'Service Unavailable',
      });
    const r = await pending;
    expect(r.dark).toBeTrue();
    expect(r.ok).toBeFalse();
    expect(r.error).toBeUndefined();
  });

  it('reports a real refusal with the server’s own sentence and is not dark', async () => {
    const pending = service.challenge('totp', '000000');
    http
      .expectOne('/bff/mfa/challenge')
      .flush({ error: 'that code did not verify' }, { status: 401, statusText: 'Unauthorized' });
    const r = await pending;
    expect(r).toEqual({ ok: false, dark: false, status: 401, error: 'that code did not verify' });
  });

  it('never echoes an HTML gateway interstitial as if it were a message', async () => {
    const pending = service.challenge('totp', '000000');
    http
      .expectOne('/bff/mfa/challenge')
      .flush('<html><body>502 Bad Gateway</body></html>', { status: 502, statusText: 'Bad Gateway' });
    const r = await pending;
    expect(r.status).toBe(502);
    expect(r.error).toBeUndefined();
  });

  it('reports status 0 when no response reached the browser, and never throws', async () => {
    const pending = service.challenge('totp', '123456');
    http.expectOne('/bff/mfa/challenge').error(new ProgressEvent('error'));
    const r = await pending;
    // An HttpErrorResponse with status 0 is still an HttpErrorResponse.
    expect(r.ok).toBeFalse();
    expect(r.dark).toBeFalse();
    expect(r.status).toBe(0);
  });
});

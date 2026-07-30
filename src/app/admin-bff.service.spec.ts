import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AdminBffService } from './admin-bff.service';
import { ModBffService, ModerationRequest } from './mod-bff.service';
import { authInterceptor } from './auth.interceptor';

const DECIDED: ModerationRequest = {
  id: 7,
  requester: 'user:alice',
  kind: 'user-removal',
  target: 'spammer',
  reason: 'spam',
  status: 'approved',
  modReferrer: 'mod-x',
  adminDecider: 'admin-x',
  ts: '2026-06-06T00:00:00Z',
};

describe('AdminBffService', () => {
  let service: AdminBffService;
  let httpMock: HttpTestingController;
  let modBff: jasmine.SpyObj<ModBffService>;

  beforeEach(() => {
    modBff = jasmine.createSpyObj<ModBffService>('ModBffService', ['loadModeration']);
    modBff.loadModeration.and.resolveTo([]);
    TestBed.configureTestingModule({
      providers: [
        AdminBffService,
        { provide: ModBffService, useValue: modBff },
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(AdminBffService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('POST /bff/admin/moderation/{id}/decide?approve=true forwards the HttpOnly cookie and returns the decided row', async () => {
    const promise = service.decide(7, true);
    const req = httpMock.expectOne('/bff/admin/moderation/7/decide?approve=true');
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    req.flush(DECIDED);
    expect(await promise).toEqual(DECIDED);
  });

  it('a deny call posts approve=false', async () => {
    const promise = service.decide(7, false);
    const req = httpMock.expectOne('/bff/admin/moderation/7/decide?approve=false');
    req.flush({ ...DECIDED, status: 'denied' });
    expect((await promise)?.status).toBe('denied');
  });

  it('on success it refreshes the shared moderation queue', async () => {
    const promise = service.decide(7, true);
    httpMock.expectOne('/bff/admin/moderation/7/decide?approve=true').flush(DECIDED);
    await promise;
    expect(modBff.loadModeration).toHaveBeenCalled();
  });

  it('on a downstream failure resolves to null (never throws, never fakes success) and does NOT refresh the queue', async () => {
    const promise = service.decide(7, true);
    httpMock.expectOne('/bff/admin/moderation/7/decide?approve=true')
      .flush({ error: 'bad gateway' }, { status: 502, statusText: 'Bad Gateway' });
    expect(await promise).toBeNull();
    expect(modBff.loadModeration).not.toHaveBeenCalled();
  });
});

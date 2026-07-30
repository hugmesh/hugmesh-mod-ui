import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { modGuard } from './mod.guard';
import { SessionService } from './session.service';

describe('modGuard', () => {
  let session: jasmine.SpyObj<Pick<SessionService, 'isMod'>>;
  let parseUrlSpy: jasmine.Spy;

  beforeEach(() => {
    session = jasmine.createSpyObj<SessionService>('SessionService', ['isMod']);
    parseUrlSpy = jasmine.createSpy('parseUrl').and.callFake((u: string) => ({ url: u } as unknown as UrlTree));
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionService, useValue: session },
        { provide: Router, useValue: { parseUrl: parseUrlSpy } },
      ],
    });
  });

  function run() {
    // CanActivateFn runs in an injection context; the route/state args are unused.
    return TestBed.runInInjectionContext(() => modGuard(null as never, null as never));
  }

  it('allows activation for a moderator session', () => {
    session.isMod.and.returnValue(true);
    expect(run()).toBeTrue();
    expect(parseUrlSpy).not.toHaveBeenCalled();
  });

  it('redirects a non-moderator session to /login', () => {
    session.isMod.and.returnValue(false);
    const result = run() as UrlTree;
    expect(parseUrlSpy).toHaveBeenCalledWith('/login');
    expect((result as unknown as { url: string }).url).toBe('/login');
  });
});

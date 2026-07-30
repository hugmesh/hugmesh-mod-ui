import { TestBed } from '@angular/core/testing';
import { SessionService, SnapSession } from './session.service';

function makeSession(over: Partial<SnapSession> = {}): SnapSession {
  return {
    id: 'google:alice@gmail.com',
    label: 'alice@gmail.com',
    provider: 'google',
    roles: [],
    registrationComplete: false,
    ...over,
  };
}

describe('SessionService', () => {
  let service: SessionService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [SessionService] });
    service = TestBed.inject(SessionService);
  });

  afterEach(() => localStorage.clear());

  it('starts logged-out when localStorage has no session', () => {
    expect(service.session()).toBeNull();
    expect(service.loggedIn()).toBeFalse();
    expect(service.isAdmin()).toBeFalse();
    expect(service.isMod()).toBeFalse();
    expect(service.fullyRegistered()).toBeFalse();
  });

  it('isMod is true for a "mod" role, an "admin" role, but not a plain "user"', () => {
    service.set(makeSession({ roles: ['user'] }));
    expect(service.isMod()).toBeFalse();
    service.set(makeSession({ roles: ['user', 'mod'] }));
    expect(service.isMod()).toBeTrue();
    service.set(makeSession({ roles: ['admin'] }));
    expect(service.isMod()).withContext('admin inherits the mod surface').toBeTrue();
  });

  it('hydrates an existing session from localStorage on construction', () => {
    localStorage.setItem('hug.session', JSON.stringify(makeSession({ roles: ['admin'] })));
    const fresh = TestBed.runInInjectionContext(() => new SessionService());
    expect(fresh.loggedIn()).toBeTrue();
    expect(fresh.isAdmin()).toBeTrue();
  });

  it('tolerates malformed JSON in localStorage and reports logged-out', () => {
    localStorage.setItem('hug.session', '{not valid json');
    const fresh = TestBed.runInInjectionContext(() => new SessionService());
    expect(fresh.session()).toBeNull();
    expect(fresh.loggedIn()).toBeFalse();
  });

  it('set() persists to localStorage and flips the derived signals', () => {
    service.set(makeSession({ roles: ['admin'], registrationComplete: true }));
    expect(service.loggedIn()).toBeTrue();
    expect(service.isAdmin()).toBeTrue();
    expect(service.fullyRegistered()).toBeTrue();
    expect(JSON.parse(localStorage.getItem('hug.session')!).roles).toEqual(['admin']);
  });

  it('isAdmin only when the roles array includes "admin"', () => {
    service.set(makeSession({ roles: ['user'] }));
    expect(service.isAdmin()).toBeFalse();
    service.set(makeSession({ roles: ['user', 'admin'] }));
    expect(service.isAdmin()).toBeTrue();
  });

  it('patch() merges into the current session without dropping other fields', () => {
    service.set(makeSession({ roles: ['admin'], label: 'alice@gmail.com' }));
    service.patch({ registrationComplete: true });
    expect(service.isAdmin()).toBeTrue();
    expect(service.fullyRegistered()).toBeTrue();
    expect(service.session()!.label).toBe('alice@gmail.com');
  });

  it('patch() is a no-op when there is no session', () => {
    service.patch({ registrationComplete: true });
    expect(service.session()).toBeNull();
  });

  it('clear() removes the session from localStorage and resets the signal', () => {
    service.set(makeSession());
    service.clear();
    expect(service.session()).toBeNull();
    expect(localStorage.getItem('hug.session')).toBeNull();
  });

  it('re-reads localStorage when another in-page instance broadcasts a change', () => {
    expect(service.loggedIn()).toBeFalse();
    // Simulate another SessionService instance (host or sibling remote) writing
    // the shared key and broadcasting the same-document change event.
    localStorage.setItem('hug.session', JSON.stringify(makeSession({ roles: ['admin'] })));
    window.dispatchEvent(new Event('hug-session-change'));
    expect(service.isAdmin()).toBeTrue();
  });
});

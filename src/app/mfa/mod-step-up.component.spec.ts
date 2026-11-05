import { Component, Type, output, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';

import { ModStepUpComponent } from './mod-step-up.component';
import { LOGIN_STEP_UP_LOADER, LoginMfaStepUpComponent, LoginStepUpModule } from './mfa-step-up';

/** A stand-in for login-ui's MfaChallengeComponent: the same three outputs, and
 *  the marker the specs look for (login-ui's own root testid). */
@Component({
  selector: 'fake-login-mfa',
  standalone: true,
  template: '<p data-testid="mfa-challenge-view">fake federated challenge</p>',
})
class FakeLoginMfaComponent {
  static readonly instances: FakeLoginMfaComponent[] = [];
  constructor() {
    FakeLoginMfaComponent.instances.push(this);
  }
  readonly satisfied = output<void>();
  readonly dismissed = output<void>();
  readonly unavailable = output<void>();
}

describe('ModStepUpComponent (hugmesh-mod-ui#1, decisions 21/35)', () => {
  let fixture: ComponentFixture<ModStepUpComponent>;
  let loads: number;
  let loaderBehaviour: 'fake' | 'reject-load' | 'reject-component';
  let satisfied: number;
  const dismissed: boolean[] = [];
  const url = signal('/mod/console');

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
  function testid(id: string): HTMLElement | null {
    return el().querySelector(`[data-testid="${id}"]`);
  }
  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }
  function dialog(): FakeLoginMfaComponent {
    return FakeLoginMfaComponent.instances[FakeLoginMfaComponent.instances.length - 1];
  }

  beforeEach(async () => {
    loads = 0;
    loaderBehaviour = 'fake';
    satisfied = 0;
    dismissed.length = 0;
    FakeLoginMfaComponent.instances.length = 0;
    await TestBed.configureTestingModule({
      imports: [ModStepUpComponent],
      providers: [
        { provide: Router, useValue: { get url() { return url(); } } },
        {
          provide: LOGIN_STEP_UP_LOADER,
          useValue: async (): Promise<LoginStepUpModule> => {
            loads++;
            if (loaderBehaviour === 'reject-load') throw new Error("Remote 'login' is not initialized");
            return {
              loadMfaStepUpComponent: () =>
                loaderBehaviour === 'reject-component'
                  ? Promise.reject(new Error('chunk failed'))
                  : Promise.resolve(FakeLoginMfaComponent as Type<LoginMfaStepUpComponent>),
            };
          },
        },
      ],
    }).compileComponents();
  });

  function create(): void {
    fixture = TestBed.createComponent(ModStepUpComponent);
    fixture.componentInstance.satisfied.subscribe(() => satisfied++);
    fixture.componentInstance.dismissed.subscribe((dark) => dismissed.push(dark));
  }

  it('loads the federated dialog only once it is mounted, and shows it in place', async () => {
    expect(loads).toBe(0);
    create();
    expect(loads).toBe(0); // constructing is not loading
    await settle();
    await settle();
    expect(loads).toBe(1);
    expect(testid('mfa-challenge-view')).not.toBeNull();
    expect(fixture.componentInstance.state()).toBe('dialog');
    expect(testid('mfa-stepup-link')).toBeNull();
    expect(testid('mfa-stepup-dark')).toBeNull();
  });

  it('shows a loading state while the module is on its way', async () => {
    create();
    fixture.detectChanges();
    expect(testid('mfa-stepup-loading')).not.toBeNull();
    await settle();
    await settle();
    expect(testid('mfa-stepup-loading')).toBeNull();
  });

  it('(satisfied) destroys the dialog and tells the console to retry the same write', async () => {
    create();
    await settle();
    await settle();
    dialog().satisfied.emit();
    await settle();
    expect(satisfied).toBe(1);
    expect(dismissed).toEqual([]);
    expect(testid('mfa-challenge-view')).toBeNull();
  });

  it('(dismissed) destroys the dialog and reports a plain "not now", never dark', async () => {
    create();
    await settle();
    await settle();
    dialog().dismissed.emit();
    await settle();
    expect(dismissed).toEqual([false]);
    expect(satisfied).toBe(0);
    expect(testid('mfa-challenge-view')).toBeNull();
  });

  it('(unavailable) keeps a dark notice on screen with a Close, and reports dark only when closed', async () => {
    create();
    await settle();
    await settle();
    dialog().unavailable.emit();
    await settle();
    // The notice persists: nothing is reported until the moderator closes it.
    expect(fixture.componentInstance.state()).toBe('dark');
    expect(testid('mfa-challenge-view')).toBeNull();
    expect(testid('mfa-stepup-dark')).not.toBeNull();
    expect(testid('mfa-stepup-link')).withContext('a retry link MFA cannot honour').toBeNull();
    expect(dismissed).toEqual([]);
    (testid('mfa-stepup-close') as HTMLButtonElement).click();
    await settle();
    expect(dismissed).toEqual([true]);
    expect(satisfied).toBe(0);
  });

  it('degrades to the /login/mfa/challenge?returnTo= link when the remote entry cannot be loaded', async () => {
    loaderBehaviour = 'reject-load';
    create();
    await settle();
    await settle();
    expect(fixture.componentInstance.state()).toBe('link');
    const link = testid('mfa-stepup-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/login/mfa/challenge?returnTo=%2Fmod%2Fconsole');
    expect(testid('mfa-stepup-degraded')?.textContent).toContain('Nothing has been changed');
    expect(testid('mfa-challenge-view')).toBeNull();
  });

  it('degrades the same way when the module loads but the component does not', async () => {
    loaderBehaviour = 'reject-component';
    create();
    await settle();
    await settle();
    expect(fixture.componentInstance.state()).toBe('link');
    expect(testid('mfa-stepup-link')).not.toBeNull();
  });

  it('the fallback carries the CURRENT router url, query and fragment included', async () => {
    loaderBehaviour = 'reject-load';
    url.set('/mod/console?status=referred#mc-request-7');
    create();
    await settle();
    await settle();
    expect(fixture.componentInstance.href()).toBe(
      '/login/mfa/challenge?returnTo=%2Fmod%2Fconsole%3Fstatus%3Dreferred%23mc-request-7',
    );
    url.set('/mod/console');
  });

  it('"Not now" on the fallback reports a plain dismissal, never dark', async () => {
    loaderBehaviour = 'reject-load';
    create();
    await settle();
    await settle();
    (testid('mfa-stepup-not-now') as HTMLButtonElement).click();
    await settle();
    expect(dismissed).toEqual([false]);
    expect(satisfied).toBe(0);
  });

  it('does not mount a dialog that resolved after the offer was torn down', async () => {
    let resolve!: (m: LoginStepUpModule) => void;
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ModStepUpComponent],
      providers: [
        { provide: Router, useValue: { get url() { return url(); } } },
        { provide: LOGIN_STEP_UP_LOADER, useValue: () => new Promise<LoginStepUpModule>((r) => (resolve = r)) },
      ],
    }).compileComponents();
    create();
    fixture.detectChanges();
    fixture.destroy();
    resolve({ loadMfaStepUpComponent: () => Promise.resolve(FakeLoginMfaComponent as Type<LoginMfaStepUpComponent>) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeLoginMfaComponent.instances.length).toBe(0);
  });
});

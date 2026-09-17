import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MfaStepUpDialogComponent } from './mfa-step-up-dialog.component';
import { MfaService } from './mfa.service';
import { MfaResult } from './mfa.types';

function okResult<T>(data: T): MfaResult<T> {
  return { ok: true, dark: false, status: 200, data };
}

describe('MfaStepUpDialogComponent', () => {
  let fixture: ComponentFixture<MfaStepUpDialogComponent>;
  let component: MfaStepUpDialogComponent;
  let mfa: jasmine.SpyObj<MfaService>;

  function el(testId: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);
  }

  beforeEach(async () => {
    mfa = jasmine.createSpyObj<MfaService>('MfaService', ['challenge', 'assertWebauthnOptions']);
    mfa.challenge.and.resolveTo(okResult({ mfaSatisfied: true }));
    mfa.assertWebauthnOptions.and.resolveTo(okResult({ challenge: 'Y2g', rpId: 'h', rpName: 'H' }));
    await TestBed.configureTestingModule({
      imports: [MfaStepUpDialogComponent],
      providers: [{ provide: MfaService, useValue: mfa }],
    }).compileComponents();
    fixture = TestBed.createComponent(MfaStepUpDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('names the stalled action in its intro so the moderator knows what is waiting', () => {
    fixture.componentRef.setInput('action', 'This domain-lock');
    fixture.detectChanges();
    expect(el('mfa-stepup-intro')!.textContent).toContain('This domain-lock');
  });

  it('refuses to submit a TOTP code that is not 6 digits, without calling the BFF', async () => {
    component.code = '12345';
    await component.submitCode();
    expect(mfa.challenge).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(el('mfa-stepup-error')!.textContent).toContain('6-digit code');
  });

  it('emits satisfied once the challenge verifies, and clears the typed code', async () => {
    const satisfied = jasmine.createSpy('satisfied');
    component.satisfied.subscribe(satisfied);
    component.code = ' 123456 ';
    await component.submitCode();
    expect(mfa.challenge).toHaveBeenCalledWith('totp', '123456');
    expect(satisfied).toHaveBeenCalledTimes(1);
    expect(component.code).toBe('');
  });

  it('accepts a non-numeric recovery code once that method is chosen', async () => {
    component.setMethod('recovery');
    component.code = 'AAAA-BBBB-CCCC-DDDD';
    await component.submitCode();
    expect(mfa.challenge).toHaveBeenCalledWith('recovery', 'AAAA-BBBB-CCCC-DDDD');
  });

  it('does NOT emit satisfied when the server verified nothing', async () => {
    const satisfied = jasmine.createSpy('satisfied');
    component.satisfied.subscribe(satisfied);
    mfa.challenge.and.resolveTo(okResult({ mfaSatisfied: false }));
    component.code = '123456';
    await component.submitCode();
    expect(satisfied).not.toHaveBeenCalled();
    fixture.detectChanges();
    expect(el('mfa-stepup-error')!.textContent).toContain('did not verify');
  });

  it('shows a terminal not-enabled state on the ships-dark 503, never an error', async () => {
    mfa.challenge.and.resolveTo({ ok: false, dark: true, status: 503 });
    component.code = '123456';
    await component.submitCode();
    fixture.detectChanges();
    expect(el('mfa-stepup-dark')).not.toBeNull();
    expect(el('mfa-stepup-error')).toBeNull();
    // Only a Close affordance — there is nothing a moderator can do here.
    expect(el('mfa-stepup-close')).not.toBeNull();
    expect(el('mfa-stepup-submit')).toBeNull();
  });

  it('emits dismissed on cancel and keeps no typed code behind', () => {
    const dismissed = jasmine.createSpy('dismissed');
    component.dismissed.subscribe(dismissed);
    component.code = '123456';
    component.cancel();
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(component.code).toBe('');
  });

  it('clears a stale code and error when the method changes', () => {
    component.code = '123456';
    component.error.set('boom');
    component.setMethod('recovery');
    expect(component.code).toBe('');
    expect(component.error()).toBe('');
  });

  it('announces the error in a role=alert live region (a11y)', async () => {
    mfa.challenge.and.resolveTo({ ok: false, dark: false, status: 401, error: 'nope' });
    component.code = '123456';
    await component.submitCode();
    fixture.detectChanges();
    const alert = el('mfa-stepup-error')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
  });

  it('labels the code input and wires it to visible help text (a11y)', () => {
    const input = el('mfa-stepup-code') as HTMLInputElement;
    const label = fixture.nativeElement.querySelector(`label[for="${input.id}"]`);
    expect(label).not.toBeNull();
    const describedBy = input.getAttribute('aria-describedby')!;
    expect(fixture.nativeElement.querySelector(`#${describedBy}`)).not.toBeNull();
  });

  it('falls back to a code when the browser has no WebAuthn, without calling the BFF', async () => {
    // webauthnAvailable is read once at construction from navigator.credentials.get.
    (component as unknown as { webauthnAvailable: boolean }).webauthnAvailable = false;
    await component.useWebauthn();
    expect(mfa.assertWebauthnOptions).not.toHaveBeenCalled();
    expect(component.error()).toContain('does not support passkeys');
  });

  it('treats a dark answer to the webauthn options call as not-enabled too', async () => {
    mfa.assertWebauthnOptions.and.resolveTo({ ok: false, dark: true, status: 503 });
    (component as unknown as { webauthnAvailable: boolean }).webauthnAvailable = true;
    await component.useWebauthn();
    fixture.detectChanges();
    expect(component.dark()).toBeTrue();
    expect(el('mfa-stepup-dark')).not.toBeNull();
  });
});

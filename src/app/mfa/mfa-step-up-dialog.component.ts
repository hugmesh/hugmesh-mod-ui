import { Component, EventEmitter, Output, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MfaService } from './mfa.service';
import { getAssertion, webauthnSupported } from './webauthn';
import { ChallengeFactor } from './mfa.types';

/** The verification methods this dialog offers. */
type Method = 'totp' | 'recovery' | 'webauthn';

/**
 * The inline MFA step-up challenge, ported from hugmesh-admin-ui's
 * {@code MfaStepUpDialogComponent}. A sensitive moderation write (ban/lift,
 * domain-lock/unlock, server-wide block) can be refused with the platform's
 * step-up contract (see {@code mfa/step-up-error.ts}); rather than navigate away,
 * the moderation console renders THIS inline, right under the form that was
 * refused. It collects a TOTP code, a recovery code, or a WebAuthn assertion,
 * submits it to {@code POST /bff/mfa/challenge}, and on success emits
 * {@link satisfied} — at which point the caller BLINDLY RETRIES the same write,
 * which now passes because mod-bff's {@code ModStepUpGate} reads the
 * {@code MFA_SATISFIED} marker off the caller's own session. No token is handed
 * back and none is needed.
 *
 * <p><b>INERT as landed.</b> mod-bff does not yet signal a step-up denial, so
 * nothing in this remote can currently open this dialog — see the measurement in
 * {@code mfa/step-up-error.ts}. It is landed now so the UI half is ready, tested
 * and reviewable, exactly as hugmesh-superadmin-service-catalog-ui#11 landed its
 * own step-up slice ahead of its server half.
 *
 * <p><b>Ships dark too.</b> Every {@code /bff/mfa/*} endpoint answers 503 while
 * {@code app.casdoor.mfa.enabled=false} (today's default). That is mapped to a
 * terminal "not enabled on this deployment" state with only a Close affordance —
 * never an error, because a moderator cannot act on it.
 *
 * <p>a11y: a fieldset/legend chooses the method, each input has a visible label
 * plus {@code aria-describedby} helptext, and the verdict is announced through
 * {@code role="alert"}. This is a plain in-flow {@code <section>}, not a native
 * {@code <dialog>} — the caller decides where to render it. It MUST be rendered
 * OUTSIDE the {@code <form>} it gates: this template contains its own
 * {@code <form>}, and nested forms are invalid HTML.
 */
@Component({
  selector: 'hug-mfa-step-up-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mfa-step-up-dialog.component.html',
  styleUrl: './mfa-step-up-dialog.component.scss',
})
export class MfaStepUpDialogComponent {
  private readonly mfa = inject(MfaService);

  /** Short description of the write being gated ("this ban", "this domain-lock"),
   *  spliced into the intro sentence so the moderator knows WHICH action stalled. */
  readonly action = input<string>('This action');

  /** Emitted once the challenge succeeds — the caller retries its write and
   *  dismisses this dialog. */
  @Output() readonly satisfied = new EventEmitter<void>();
  /**
   * Emitted when this dialog closes WITHOUT a satisfied challenge — the caller
   * dismisses it and does NOT retry.
   *
   * <p>The payload is {@link dark}: true when every {@code /bff/mfa/*} call
   * answered 503, i.e. the deployment has MFA switched off. The caller needs the
   * distinction because "you cancelled, retry when ready" is WRONG advice in a
   * dark deployment — there, no retry from this console can ever succeed.
   */
  @Output() readonly dismissed = new EventEmitter<boolean>();

  readonly method = signal<Method>('totp');
  readonly error = signal('');
  readonly busy = signal(false);
  /** Set when the BFF answered 503 — the MFA surface is not launched here. */
  readonly dark = signal(false);

  /** The TOTP or recovery code typed by the moderator. */
  code = '';

  readonly webauthnAvailable = webauthnSupported();

  /** A TOTP code must be 6 digits; a recovery code must be non-blank. A method,
   *  not a computed: {@code code} is a plain ngModel field, so this is
   *  re-evaluated on each template tick rather than depending on a non-reactive
   *  read. */
  codeValid(): boolean {
    const v = this.code.trim();
    if (this.method() === 'totp') return /^\d{6}$/.test(v);
    return v.length > 0;
  }

  setMethod(m: Method): void {
    this.method.set(m);
    this.code = '';
    this.error.set('');
  }

  /** Submit a TOTP or recovery-code challenge. */
  async submitCode(): Promise<void> {
    if (!this.codeValid()) {
      this.error.set(
        this.method() === 'totp'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Enter one of your recovery codes.',
      );
      return;
    }
    await this.send(this.method() as ChallengeFactor, this.code.trim());
  }

  /** Run a passkey assertion and submit it as a webauthn challenge. */
  async useWebauthn(): Promise<void> {
    if (!this.webauthnAvailable) {
      this.error.set('This browser does not support passkeys. Use a code instead.');
      return;
    }
    this.error.set('');
    this.busy.set(true);
    const opts = await this.mfa.assertWebauthnOptions();
    if (opts.dark) {
      this.busy.set(false);
      this.dark.set(true);
      return;
    }
    if (!opts.ok || !opts.data) {
      this.busy.set(false);
      this.error.set(opts.error || 'Could not start passkey verification.');
      return;
    }
    let assertion: string;
    try {
      assertion = await getAssertion(opts.data);
    } catch (e) {
      this.busy.set(false);
      this.error.set(MfaStepUpDialogComponent.passkeyError(e));
      return;
    }
    await this.send('webauthn', assertion, true);
  }

  cancel(): void {
    this.error.set('');
    this.code = '';
    this.dismissed.emit(this.dark());
  }

  private async send(factor: ChallengeFactor, credential: string, alreadyBusy = false): Promise<void> {
    this.error.set('');
    if (!alreadyBusy) this.busy.set(true);
    const r = await this.mfa.challenge(factor, credential);
    this.busy.set(false);
    if (r.dark) {
      this.dark.set(true);
      return;
    }
    if (!r.ok || !r.data?.mfaSatisfied) {
      this.error.set('That did not verify. Try again with a current code or your passkey.');
      return;
    }
    this.code = '';
    this.satisfied.emit();
  }

  private static passkeyError(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === 'NotAllowedError') return 'Passkey verification was cancelled or timed out.';
    return (e as { message?: string })?.message || 'Could not verify with a passkey.';
  }
}

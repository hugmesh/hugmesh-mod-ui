import {
  AfterViewInit,
  Component,
  OnDestroy,
  ViewContainerRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { LOGIN_STEP_UP_LOADER, mfaChallengeHref } from './mfa-step-up';

/**
 * The step-up offer (hugmesh-mod-ui#1, decisions 21/35): mounts hugmesh-login-ui's
 * federated MFA challenge (`./mfa-step-up`) in place under the refused form, and
 * degrades to the `?returnTo=` link when that load is rejected.
 *
 * It exists only while a step-up refusal is pending — the console renders it
 * under exactly one form at a time — so the federated module is loaded on
 * demand and never at bootstrap. The console decides what to do with the outcome:
 * <ul>
 *   <li>{@link satisfied}: the moderator's own session now carries a fresh
 *       {@code mfa_satisfied} stamp, server-side. The console re-issues the SAME
 *       write snapshot, exactly once. Nothing is handed back: mod-bff's gate reads
 *       the stamp off the session, not off a value this dialog could return.</li>
 *   <li>{@link dismissed} {@code false}: the moderator chose "Not now" (in the
 *       challenge, or on the fallback link). Nothing was applied; do not retry.</li>
 *   <li>{@link dismissed} {@code true}: the challenge reported {@code unavailable}
 *       — every {@code /bff/mfa/*} call answered 503 because MFA ships dark
 *       ({@code app.casdoor.mfa.enabled=false}) — and the moderator closed the
 *       notice. No retry from this console can succeed; the console says to
 *       escalate instead.</li>
 * </ul>
 *
 * <p>The dark state is the one place this component renders an affordance of
 * its own: login-ui's dialog deliberately offers no way out of its terminal
 * "not enabled yet" line (what "back" means belongs to the surface that embedded
 * it), and dark is the only state reachable while MFA ships dark org-wide. The
 * notice stays on screen until the moderator closes it, so the outcome is read
 * rather than flashed.
 *
 * <p>The fallback link is the decided, permanent degrade path, not a stopgap: it
 * is what a developer sees under {@code ng serve} (the dev manifest serves
 * {@code login} on another port) and what a moderator sees if the shell's
 * {@code login} row ever moves. The pending write stays held while the link is
 * shown; following it is a full navigation, so the moderator re-issues the
 * action after verifying.
 */
@Component({
  selector: 'hug-mod-step-up',
  standalone: true,
  templateUrl: './mod-step-up.component.html',
  styleUrl: './mod-step-up.component.scss',
})
export class ModStepUpComponent implements AfterViewInit, OnDestroy {
  private readonly load = inject(LOGIN_STEP_UP_LOADER);
  private readonly router = inject(Router);
  private readonly host = viewChild.required('dialogHost', { read: ViewContainerRef });

  /** The moderator's session now carries a fresh MFA stamp: retry the same write once. */
  readonly satisfied = output<void>();
  /** The offer ended without a stamp. {@code true} = closed because MFA is dark here. */
  readonly dismissed = output<boolean>();

  /** `loading` until the dialog is mounted or a terminal state is chosen. */
  readonly state = signal<'loading' | 'dialog' | 'dark' | 'link'>('loading');
  /** The fallback link, fixed when the fallback is chosen. */
  readonly href = signal('');

  private gone = false;

  ngAfterViewInit(): void {
    void this.mount();
  }

  ngOnDestroy(): void {
    this.gone = true;
  }

  private async mount(): Promise<void> {
    try {
      const mod = await this.load();
      const component = await mod.loadMfaStepUpComponent();
      if (this.gone) return;
      const ref = this.host().createComponent(component);
      ref.instance.satisfied.subscribe(() => {
        ref.destroy();
        this.satisfied.emit();
      });
      ref.instance.dismissed.subscribe(() => {
        ref.destroy();
        this.dismissed.emit(false);
      });
      ref.instance.unavailable.subscribe(() => {
        ref.destroy();
        this.state.set('dark');
      });
      this.state.set('dialog');
    } catch {
      if (!this.gone) this.fallBack();
    }
  }

  /** The moderator closed the dark notice: tell the console MFA cannot be confirmed here. */
  closeDark(): void {
    this.dismissed.emit(true);
  }

  private fallBack(): void {
    this.href.set(mfaChallengeHref(this.router.url));
    this.state.set('link');
  }
}

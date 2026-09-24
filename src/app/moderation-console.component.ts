import { ChangeDetectorRef, Component, DestroyRef, ElementRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  BanRequest,
  BlockFederation,
  BlockRequest,
  DomainLockRole,
  ModAction,
  ModBffService,
  ModerationRequest,
  PendingReconcile,
  RecommendRequest,
} from './mod-bff.service';
import { ModWriteError, ModWriteResult, describeWriteFailure } from './mod-write-error';
import { MfaStepUpDialogComponent } from './mfa/mfa-step-up-dialog.component';
import { isStepUpRequiredError } from './mfa/step-up-error';
import { AdminBffService } from './admin-bff.service';
import { SessionService } from './session.service';
import { accessibleName } from './accessible-name';
import { TargetTypeaheadComponent } from './target-typeahead.component';

/**
 * What an ambiguous refusal of a sensitive mod write USUALLY means — offered as a
 * possibility, and ONLY when the server gave no reason of its own. Two different
 * rules return a bare 403 on these endpoints (the privileged/self-target guard,
 * and mod-bff's ModStepUpGate once armed), which is exactly why the console must
 * not assert either one. See hugmesh-mod-ui#14.
 */
const FORBIDDEN_HINT =
  'it is usually a privileged or self target (which this console already disables where it ' +
  'can), but the mod-bff step-up (MFA) gate refuses with a bare 403 too.';

/**
 * A sensitive write that was refused for a fresh MFA step-up, held so the SAME
 * call can be re-issued verbatim once the challenge succeeds.
 *
 * <p>{@link retry} closes over a SNAPSHOT of the request, not over the live form
 * fields. That is the whole reason this type exists: the challenge dialog stays
 * open for as long as the moderator needs to find their authenticator, and a
 * retry that re-read the form could ban a different target than the one the
 * moderator reviewed and submitted. hugmesh-superadmin-service-catalog-ui#11
 * made the same call ("retry the same snapshot").
 */
interface PendingStepUp {
  /** Which form is stalled — the console renders the dialog under that form only.
   *  Exactly ONE of these exists at a time: {@code offerStepUp} refuses to replace
   *  a live one, because replacing it would discard the stalled write's retry with
   *  nothing on screen saying so. */
  readonly form: 'ban' | 'domainLock' | 'block';
  /** The action, lower-case, as it reads mid-sentence ("ban", "domain-lock"). */
  readonly action: string;
  /** Re-issue the identical write. */
  readonly retry: () => Promise<void>;
}

/**
 * Moderation console (ROLE_MOD / ROLE_ADMIN only, route-guarded). The single
 * working surface of the moderator remote, the role analog of admin-ui's
 * route-access view. It composes the mod's whole (deliberately narrow) toolkit,
 * wiring ONLY the hugmesh-mod-bff-api ModController endpoints that EXIST and
 * rendering the admin-only / no-endpoint controls DISABLED with WHY-helptext
 * (defence in depth: the API is the source of truth; the UI mirrors its gates):
 *
 *  WIRED (mod-bff endpoints):
 *  - the federation moderation QUEUE (GET /bff/mod/moderation), with a status
 *    filter (surfaces the user-written self-silence-appeal rows) + a refer action
 *    per row (POST /bff/mod/moderation/{id}/refer) — the ONLY removal path: a mod
 *    escalates, never decides;
 *  - a RECOMMEND form (POST /bff/mod/moderation) — record a mod→admin
 *    instance-block / user-removal recommendation into the federation queue;
 *  - a BAN / LIFT form (POST/DELETE /bff/mod/ban) — platform-access ban, timed via
 *    ttlSeconds (blank = permanent), 202 pending-reconcile;
 *  - a DOMAIN-LOCK add/remove form (POST/DELETE /bff/mod/domain-lock/{role}/{user})
 *    — force a user local-only (additive marker), 202 pending-reconcile;
 *  - a server-wide BLOCK form (POST /bff/mod/block) — mechanism differs by
 *    platform/scope (operator decisions 50/51, 2026-09-18): Matrix user-block is a
 *    REVERSIBLE local-only lock (not the homeserver's one-way deactivate — undo via
 *    the Domain-lock form's "Remove lock"), Matrix instance-block has no live verb
 *    so it records a REQUEST applied by an administrator, and the Mastodon (akkoma)
 *    leg is WIRED to real pleroma-admin verbs but ships dark by default; always
 *    locally audited either way;
 *  - the local mod-action AUDIT trail (GET /bff/mod/audit).
 *
 *  ADMIN-only, wired via {@link AdminBffService} (hugmesh-admin-bff-api, a
 *  DIFFERENT service than mod-bff-api):
 *  - appeals DECIDE (approve/deny) — POST /bff/admin/moderation/{id}/decide.
 *    Shown ONLY when {@link isAdmin} (the console is MOD/ADMIN route-guarded and
 *    a mod never decides directly — only escalates via /refer). A mod sees the
 *    control DISABLED with helptext instead. A failed/degraded decide is
 *    surfaced honestly and NEVER renders the row as decided.
 *
 *  DISABLED + helptext (NO mod-bff endpoint — verified against ModController):
 *  - general role grant / revoke — no endpoint anywhere (role assignment happens
 *    at Casdoor via the reconcile loop);
 *  - external-client GRANT — no endpoint (external-client is user owner-scoped
 *    self-service in user-bff; mod/admin cannot grant it).
 *
 * All data access goes through {@link ModBffService}, whose BehaviorSubjects are
 * the one source of truth; this component subscribes them into signals. There is
 * NO mod-facing SSE (mod-bff-api exposes no SSE endpoint of its own), so write
 * results are surfaced as honest async "pending reconcile" notes and the queue
 * is refreshed on demand (poll-on-action), never via an invented stream.
 *
 * <h3>Target pickers</h3>
 * Every field naming a user or instance is a {@link TargetTypeaheadComponent} — a
 * type-to-filter combobox suggesting accounts already visible in THIS moderator's
 * own domain-scoped queues (findings / moderation queue / audit trail; see
 * {@link ModDirectoryService} for why a directory search is not available to a MOD
 * and why filtering those already-scoped lists is not an enumeration hole). Free
 * text is always still accepted, because a moderator must be able to act on a
 * remote account that has never appeared in their queues.
 */
@Component({
  selector: 'hug-moderation-console',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, TargetTypeaheadComponent, MfaStepUpDialogComponent],
  templateUrl: './moderation-console.component.html',
  styleUrl: './moderation-console.component.scss',
})
export class ModerationConsoleComponent implements OnInit {
  private readonly bff = inject(ModBffService);
  private readonly admin = inject(AdminBffService);
  private readonly session = inject(SessionService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Drives the disabled+helptext gating of the admin-only DECIDE controls. */
  readonly isAdmin = this.session.isAdmin;

  readonly queue = signal<ModerationRequest[]>([]);
  readonly auditRows = signal<ModAction[]>([]);

  /** Audit-trail "only my own actions" filter — the BFF supports GET
   *  /bff/mod/audit?mine (ModBffService.loadAudit(mine)); this exposes it as an
   *  opt-in toggle. Default false = the full domain-scoped trail (every mod's
   *  actions), matching the prior behaviour. */
  auditMine = false;

  /** Request ids currently mid-flight on a decide call (prevents a double-submit;
   *  drives the row's decide buttons' disabled state alongside isAdmin). */
  readonly decidingIds = signal<Set<number>>(new Set());
  /** Surfaced honestly on a failed/degraded decide — never rendered as applied. */
  readonly decideError = signal('');
  /** Surfaced honestly when a refer fails — every other write in this console
   *  announces its failure, so refer must not be silent. */
  readonly referError = signal('');

  /**
   * The sensitive write currently stalled on an MFA step-up, or null. Non-null
   * renders {@code <hug-mfa-step-up-dialog>} under that form and holds the exact
   * call to re-issue afterwards.
   *
   * <p>INERT AS LANDED: nothing can set this today. hugmesh-mod-bff-api's
   * {@code ModStepUpGate} denies with a bare Spring 403 that carries neither the
   * {@code X-Step-Up-Required} header nor the "requires step-up" phrase, so
   * {@code isStepUpRequiredError} never returns true — and the gate ships dark
   * besides. The measurement, and the one cross-repo change that unblocks it, are
   * written up in {@code mfa/step-up-error.ts}. See hugmesh-mod-ui#1.
   */
  readonly pendingStepUp = signal<PendingStepUp | null>(null);

  // ── Queue status filter ────────────────────────────────────────────
  /** The closed federation status vocab + a self-silence-appeal convenience. */
  readonly statusFilters: { value: string; label: string }[] = [
    { value: '', label: 'all' },
    { value: 'recommended', label: 'recommended' },
    { value: 'referred', label: 'referred' },
    { value: 'approved', label: 'approved' },
    { value: 'denied', label: 'denied' },
    { value: 'self-silence-appeal', label: 'self-silence appeals' },
  ];
  statusFilter = '';

  // ── Recommend (mod→admin escalation) form model ────────────────────
  readonly recommendKinds: RecommendRequest['kind'][] = ['instance-block', 'user-removal'];
  recommendKind: RecommendRequest['kind'] = 'instance-block';
  recommendTarget = '';
  recommendReason = '';
  readonly recommendError = signal('');
  readonly recommendNote = signal('');

  // ── Server-wide block form model ───────────────────────────────────
  readonly platforms: BlockRequest['platform'][] = ['matrix', 'mastodon'];
  readonly scopes: BlockRequest['scope'][] = ['user', 'instance'];
  platform: BlockRequest['platform'] = 'matrix';
  scope: BlockRequest['scope'] = 'user';
  target = '';
  reason = '';
  /** Inline validation surfaced in a role=alert live region. Empty = valid. */
  readonly blockError = signal('');
  /** Outcome of the last block (the STUBBED/ok/degraded note), announced politely. */
  readonly blockNote = signal('');
  /** Decision 84d: the federation-api moderation_requests id the last block filed or
   *  reused (mod-bff's dedicated {@code moderationRequestId} field), or null. Drives the
   *  "view it in the queue" link — the id is NEVER scraped out of the prose note. */
  readonly blockRequestId = signal<number | null>(null);
  /** The federation-api leg of the last Matrix INSTANCE block, or null for every other
   *  block. Rendered as its status word plus a plain sentence, so an 'unauthorized'
   *  leg (decision 84b: the moderator's own token was refused) is not buried in prose. */
  readonly blockFederation = signal<BlockFederation | null>(null);
  /** The queue row the moderator last jumped to from a block result (highlighted). */
  readonly highlightedRequestId = signal<number | null>(null);
  /** Said plainly when the linked request is not in this moderator's queue view. */
  readonly requestMissing = signal('');

  // ── Ban / lift form model ──────────────────────────────────────────
  readonly banPlatforms: BanRequest['platform'][] = ['matrix', 'mastodon', 'profile'];
  banPlatform: BanRequest['platform'] = 'matrix';
  banTarget = '';
  /** ttlSeconds as a string so blank = permanent (no value submitted). */
  banTtlSeconds = '';
  banReason = '';
  readonly banError = signal('');
  readonly banNote = signal('');

  // ── Domain-lock add/remove form model ──────────────────────────────
  readonly domainLockRoles: { value: DomainLockRole; label: string }[] = [
    { value: 'ROLE_MATRIX_DOMAINLOCKED', label: 'Matrix (local-only)' },
    { value: 'ROLE_MASTODON_DOMAINLOCKED', label: 'Mastodon (local-only)' },
  ];
  domainLockRole: DomainLockRole = 'ROLE_MATRIX_DOMAINLOCKED';
  domainLockUser = '';
  domainLockReason = '';
  readonly domainLockError = signal('');
  readonly domainLockNote = signal('');

  ngOnInit(): void {
    // Bridge the BFF BehaviorSubjects into Angular signals so the template can
    // use them directly without the `async` pipe. Unsubscribe on destroy so
    // repeated navigation into this routed remote doesn't accumulate subscriptions
    // against the root-provided ModBffService's long-lived subjects.
    this.bff.moderation.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => this.queue.set(q));
    this.bff.audit.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((a) => this.auditRows.set(a));
    void this.bff.loadModeration();
    void this.bff.loadAudit();
  }

  // ── Queue ──────────────────────────────────────────────────────────
  /** Reload the queue with the selected status filter (blank = all). */
  async applyStatusFilter(): Promise<void> {
    await this.bff.loadModeration(this.statusFilter || undefined);
  }

  /** Reload the audit trail honouring the "only my own actions" toggle (the
   *  BFF-supported GET /bff/mod/audit?mine option). */
  async applyAuditFilter(): Promise<void> {
    await this.bff.loadAudit(this.auditMine);
  }

  /**
   * The accessible (aria-label) name for a queue row's target — announces an
   * ASCII screenReaderName when present (the target may render a non-ASCII
   * display name). The federation row currently carries a plain `target` string;
   * accessibleName degrades to it when no screen-reader name is available.
   */
  targetName(r: ModerationRequest): string {
    return accessibleName(r.target, (r as { screenReaderName?: string | null }).screenReaderName);
  }

  /**
   * Escalate a queue item up to an admin (the only mod removal path). A
   * {@code !ok} result means the refer did not take (the row was already decided,
   * a 404/5xx, an expired session, an offline browser) — surface WHAT THE SERVER
   * SAID instead of silently leaving the row un-referred or guessing a reason
   * (bff.refer already reloaded the queue, so a real success is reflected by the
   * row flipping to `referred`).
   */
  async refer(id: number): Promise<void> {
    this.referError.set('');
    const referred = await this.bff.refer(id);
    if (!referred.ok) {
      this.referError.set(
        describeWriteFailure(
          referred.error,
          `referral of request #${id}`,
          'it may already be decided or referred, or outside your domain.',
        ),
      );
    }
  }

  /**
   * ADMIN-only: approve/deny a referred request via
   * {@link AdminBffService#decide} (hugmesh-admin-bff-api, which proxies to
   * federation-api's decide→apply chain — an approved user-removal auto-applies
   * a kill-switch override; a denied re-decision rearms it). A mod never calls
   * this (the control is disabled+helptext for them); {@link isAdmin} gates the
   * enabled control template-side as defence in depth. A {@code null} result
   * (failed/degraded call) is surfaced honestly and the row's rendered status is
   * left untouched — the queue only refreshes on a real success.
   */
  async decide(id: number, approve: boolean): Promise<void> {
    this.decideError.set('');
    this.decidingIds.update((s) => new Set(s).add(id));
    const decided = await this.admin.decide(id, approve);
    this.decidingIds.update((s) => { const n = new Set(s); n.delete(id); return n; });
    if (!decided) {
      this.decideError.set(`Could not ${approve ? 'approve' : 'deny'} request #${id} — it was NOT applied.`);
    }
  }

  // ── Recommend (mod→admin) ──────────────────────────────────────────
  async recommend(): Promise<void> {
    // Clear any prior success note so a later rejected/invalid submit never
    // renders a stale "recorded" note beside the fresh error (the error is
    // reset before every call below).
    this.recommendNote.set('');
    if (!this.recommendTarget.trim()) {
      this.recommendError.set('A target (instance domain or user) is required.');
      return;
    }
    this.recommendError.set('');
    const result = await this.bff.recommend({
      kind: this.recommendKind,
      target: this.recommendTarget.trim(),
      reason: this.recommendReason.trim() || undefined,
    });
    if (result.ok) {
      this.recommendNote.set('Recommendation recorded in the federation queue for an admin to decide.');
      this.recommendTarget = '';
      this.recommendReason = '';
    } else {
      this.recommendError.set(
        describeWriteFailure(result.error, 'recommendation', 'your MOD/ADMIN role may not cover this target.'),
      );
    }
  }

  // ── Server-wide block ──────────────────────────────────────────────
  async block(): Promise<void> {
    // Drop any stale success note (see recommend()) — and the previous block's
    // request link / federation line, which would otherwise read as this block's.
    this.blockNote.set('');
    this.blockRequestId.set(null);
    this.blockFederation.set(null);
    this.requestMissing.set('');
    if (!this.target.trim()) {
      this.blockError.set('A target (user MXID/acct or instance domain) is required.');
      return;
    }
    this.blockError.set('');
    await this.submitBlock({
      platform: this.platform,
      scope: this.scope,
      target: this.target.trim(),
      reason: this.reason.trim() || undefined,
    });
  }

  /** Issue — or RE-issue after a step-up — one block against an unchanging
   *  snapshot of the form. See {@link PendingStepUp} for why the snapshot and not
   *  the live fields. */
  private async submitBlock(req: BlockRequest): Promise<void> {
    const result = await this.bff.block(req);
    if (result.ok) {
      this.blockNote.set(result.value.note ?? `Recorded. External result: ${result.value.external}.`);
      this.target = '';
      this.reason = '';
      const id = result.value.moderationRequestId;
      this.blockRequestId.set(typeof id === 'number' ? id : null);
      this.blockFederation.set(result.value.federation ?? null);
      // ModBffService.block() refreshes only the audit trail. A filed/referred request
      // must be in the cached queue before the link to it can land anywhere.
      if (typeof id === 'number') await this.bff.loadModeration(this.statusFilter || undefined);
    } else if (this.offerStepUp(result.error, 'block', 'block', () => this.submitBlock(req))) {
      // offerStepUp owns this form's error line in the step-up case — it CLEARS it
      // when the dialog opens and WRITES it when it refuses a second challenge.
    } else {
      this.blockError.set(describeWriteFailure(result.error, 'block', FORBIDDEN_HINT));
    }
  }

  /** True when the federation leg did NOT reach administrators (announced as an alert). */
  federationFailed(f: BlockFederation): boolean {
    return f.status === 'unauthorized' || f.status === 'error' || f.status === 'not-configured';
  }

  /**
   * The plain sentence for a block's federation-api leg (decisions 84a-d). The status
   * word itself is rendered verbatim beside it; this says what it MEANS. It is derived
   * from the structured fields only — the prose {@code note} is never parsed.
   */
  federationMessage(f: BlockFederation): string {
    const id = f.moderationRequestId;
    const http = typeof f.httpStatus === 'number' ? `HTTP ${f.httpStatus}` : null;
    switch (f.status) {
      case 'filed':
        return `request #${id} was filed and referred to administrators for a decision.`;
      case 'referred-existing':
        return `an open recommendation for this domain already existed (#${id}); it has now been referred to administrators.`;
      case 'existing':
        return `request #${id} for this domain was already referred to administrators; nothing new was filed.`;
      case 'unauthorized':
        return (
          (id === null
            ? 'the request was NOT filed'
            : `request #${id} was created but NOT referred to administrators`) +
          ` — federation-api refused your sign-in (${http ?? 'HTTP 401'}). This happens for a moderator ` +
          'signed in through the platform\'s own login when the Casdoor token exchange failed or is ' +
          'switched off. The block itself is still recorded in the audit trail.'
        );
      case 'error':
        return (
          `the federation request could not be completed (${http ?? 'federation-api unreachable or timed out'})` +
          (id === null ? '; nothing was filed.' : `; request #${id} exists but was NOT referred.`) +
          ' The block itself is still recorded in the audit trail.'
        );
      case 'not-configured':
        return 'NOT filed — this deployment has no federation-api client configured for moderation.';
      default:
        return 'this console does not recognise that status; check the note above and the moderation queue.';
    }
  }

  /**
   * Follow a block result's link to its request in the moderation queue: make sure the
   * row is rendered (the current status filter may hide it — widen to "all" and reload
   * rather than silently landing nowhere), then highlight, scroll to and focus it. The
   * RouterLink on the same anchor records the {@code #mc-request-<id>} fragment in the
   * URL; scrolling is done HERE because the host shell owns the router's anchorScrolling.
   */
  async revealRequest(id: number): Promise<void> {
    this.requestMissing.set('');
    const present = () => this.queue().some((r) => r.id === id);
    if (!present()) {
      this.statusFilter = '';
      await this.bff.loadModeration(undefined);
    }
    if (!present()) {
      this.highlightedRequestId.set(null);
      this.requestMissing.set(
        `Request #${id} is not in your moderation queue view — it may be outside your domain, ` +
          'or the queue could not be loaded. Reload the queue with the "all" filter to look again.',
      );
      return;
    }
    this.highlightedRequestId.set(id);
    // Render the (possibly just reloaded) row now, so it exists to be focused.
    this.cdr.detectChanges();
    const row = this.host.nativeElement.querySelector<HTMLElement>(`#mc-request-${id}`);
    row?.scrollIntoView?.({ block: 'center' });
    row?.focus();
  }

  // MFA STEP-UP (hugmesh-mod-ui#1) — the UI half is WIRED but INERT.
  //
  // ban/lift, domainLock/domainUnlock and block now route their failures through
  // offerStepUp() below, which opens <hug-mfa-step-up-dialog> and re-issues the
  // SAME request snapshot once the challenge succeeds. Nothing can open it today.
  //
  // The SERVER half exists but does not SIGNAL. hugmesh-mod-bff-api's
  // ModStepUpGate is the @PreAuthorize companion on exactly these five endpoints
  // ("hasAnyRole('MOD','ADMIN') and @modStepUpGate.satisfied(authentication)" —
  // ModController.java :200, :242, :264, :298, :329), armed by
  // app.mfa.enforce-sensitive-writes and shipping DARK (SecurityConfig.java:305).
  // A denial is therefore a bare Spring AccessDeniedException 403: re-measured on
  // that repo's origin/main 86de22e on 2026-09-17, it has ZERO occurrences of
  // X-Step-Up-Required / STEP_UP_REQUIRED / stepUpRequired and no
  // accessDeniedHandler, so neither leg of isStepUpRequiredError can fire.
  //
  // ONE cross-repo change unblocks it, with NO release of this remote: make the
  // denial carry the platform signal — e.g. lift the step-up conjunct out of
  // @PreAuthorize into an explicit check throwing
  // ApiException.forbidden("... requires step-up ..."), which the legacy-phrase
  // leg already matches. mfa/step-up-error.ts carries the full measurement, the
  // two deliberate divergences from admin-ui's predicate, and the status policy.
  //
  // The seam that made this writable at all is hugmesh-mod-ui#15: ModBffService
  // no longer collapses write failures to null, so every write returns a
  // ModWriteResult carrying the status, the response body and the
  // X-Step-Up-Required header, and surfaceBan/surfaceDomainLock report what the
  // server actually said instead of asserting "you cannot ban yourself or a
  // moderator/administrator" for every failure. See README Roadmap.

  // ── Ban / lift ─────────────────────────────────────────────────────
  /** Parse the ttlSeconds field: blank => undefined (permanent ban). */
  private parsedTtl(): number | undefined {
    const raw = this.banTtlSeconds.trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private banRequest(): BanRequest {
    return {
      platform: this.banPlatform,
      target: this.banTarget.trim(),
      ttlSeconds: this.parsedTtl(),
      reason: this.banReason.trim() || undefined,
    };
  }

  async ban(): Promise<void> {
    this.banNote.set(''); // drop any stale success note (see recommend())
    if (!this.banTarget.trim()) {
      this.banError.set('A target user is required.');
      return;
    }
    this.banError.set('');
    await this.submitBan(this.banRequest(), 'Ban');
  }

  async lift(): Promise<void> {
    this.banNote.set(''); // drop any stale success note (see recommend())
    if (!this.banTarget.trim()) {
      this.banError.set('A target user is required.');
      return;
    }
    this.banError.set('');
    await this.submitBan(this.banRequest(), 'Lift');
  }

  /** Issue — or RE-issue after a step-up — one ban/lift against an unchanging
   *  snapshot of the form. See {@link PendingStepUp}. */
  private async submitBan(req: BanRequest, verb: 'Ban' | 'Lift'): Promise<void> {
    const result = verb === 'Ban' ? await this.bff.ban(req) : await this.bff.lift(req);
    this.surfaceBan(result, verb, req);
  }

  /**
   * Render a ban/lift outcome. The failure branch reports WHAT THE SERVER SAID —
   * status, body, and the step-up header when present. It used to assert
   * "you cannot ban yourself or a moderator/administrator" for EVERY failure,
   * which was a false accusation for an expired session, a gateway 5xx, an
   * offline browser and (once mod-bff's gate is armed) a step-up 403. That
   * sentence now survives only as the 403 hint, and only when the server itself
   * gave no reason. See hugmesh-mod-ui#14.
   */
  private surfaceBan(
    result: ModWriteResult<PendingReconcile>,
    verb: 'Ban' | 'Lift',
    req: BanRequest,
  ): void {
    if (result.ok) {
      this.banNote.set(this.pendingMessage(result.value, `${verb} accepted`));
      this.banTarget = '';
      this.banTtlSeconds = '';
      this.banReason = '';
    } else if (
      this.offerStepUp(result.error, 'ban', verb.toLowerCase(), () => this.submitBan(req, verb))
    ) {
      // offerStepUp owns this form's error line in the step-up case — it CLEARS it
      // when the dialog opens and WRITES it when it refuses a second challenge.
    } else {
      this.banError.set(describeWriteFailure(result.error, verb.toLowerCase(), FORBIDDEN_HINT));
    }
  }

  // ── Domain-lock add / remove ───────────────────────────────────────
  async domainLock(): Promise<void> {
    this.domainLockNote.set(''); // drop any stale success note (see recommend())
    if (!this.domainLockUser.trim()) {
      this.domainLockError.set('A target user is required.');
      return;
    }
    this.domainLockError.set('');
    const body = this.domainLockReason.trim() ? { reason: this.domainLockReason.trim() } : undefined;
    await this.submitDomainLock(this.domainLockRole, this.domainLockUser.trim(), 'Domain-lock', body);
  }

  async domainUnlock(): Promise<void> {
    this.domainLockNote.set(''); // drop any stale success note (see recommend())
    if (!this.domainLockUser.trim()) {
      this.domainLockError.set('A target user is required.');
      return;
    }
    this.domainLockError.set('');
    await this.submitDomainLock(this.domainLockRole, this.domainLockUser.trim(), 'Domain-unlock');
  }

  /** Issue — or RE-issue after a step-up — one domain-lock/unlock against an
   *  unchanging snapshot of the form. See {@link PendingStepUp}. */
  private async submitDomainLock(
    role: DomainLockRole,
    user: string,
    verb: 'Domain-lock' | 'Domain-unlock',
    body?: { reason: string },
  ): Promise<void> {
    const result =
      verb === 'Domain-lock'
        ? await this.bff.domainLock(role, user, body)
        : await this.bff.domainUnlock(role, user);
    this.surfaceDomainLock(result, verb, () => this.submitDomainLock(role, user, verb, body));
  }

  /** Same contract as {@link surfaceBan}: report the server's own reason, and
   *  fall back to the privileged/self-target rule only as a NAMED POSSIBILITY. */
  private surfaceDomainLock(
    result: ModWriteResult<PendingReconcile>,
    verb: 'Domain-lock' | 'Domain-unlock',
    retry: () => Promise<void>,
  ): void {
    if (result.ok) {
      this.domainLockNote.set(this.pendingMessage(result.value, `${verb} accepted`));
      this.domainLockUser = '';
      this.domainLockReason = '';
    } else if (this.offerStepUp(result.error, 'domainLock', verb.toLowerCase(), retry)) {
      // offerStepUp owns this form's error line in the step-up case — it CLEARS it
      // when the dialog opens and WRITES it when it refuses a second challenge.
    } else {
      this.domainLockError.set(describeWriteFailure(result.error, verb.toLowerCase(), FORBIDDEN_HINT));
    }
  }

  // ── MFA step-up (hugmesh-mod-ui#1) ─────────────────────────────────
  /**
   * If {@code error} is the platform's step-up refusal, TAKE OVER this form's
   * error line and answer true; otherwise leave everything alone and answer false
   * so the caller renders its ordinary failure sentence.
   *
   * <p>Taking over means one of two things, and the caller must not write over
   * either: with no challenge open it stores {@code retry}, clears the error and
   * lets the dialog render; with one already open it stores nothing and writes an
   * error naming the action the moderator has to finish first. AT MOST ONE
   * challenge is live at a time — see the {@code live} branch for why.
   *
   * <p>INERT AS LANDED — {@code isStepUpRequiredError} cannot return true against
   * today's mod-bff, which denies with a bare 403 carrying neither signal leg.
   * The evidence and the unblocking change are in {@code mfa/step-up-error.ts}.
   */
  private offerStepUp(
    error: ModWriteError,
    form: PendingStepUp['form'],
    action: string,
    retry: () => Promise<void>,
  ): boolean {
    if (!isStepUpRequiredError(error)) return false;
    const live = this.pendingStepUp();
    if (live) {
      // NEVER overwrite a live challenge. The dialog is INLINE, not modal (its
      // own .scss sets no position/backdrop/z-index), so the other two forms stay
      // fully interactive while one is stalled — a moderator really can submit a
      // second gated write here. Replacing `live` would throw away its retry with
      // nothing on screen saying so, which is exactly the silent drop
      // stepUpDismissed() calls the worst outcome; it would also tear down a
      // ceremony that may already be mid-flight. Refuse the newcomer and say why.
      this.setFormError(
        form,
        `The ${action} was NOT performed — it needs an MFA step-up, and a step-up for the ` +
          `${live.action} is already open. Finish or cancel that one, then retry this.`,
      );
      return true;
    }
    this.pendingStepUp.set({ form, action, retry });
    this.setFormError(form, '');
    return true;
  }

  /** The three step-up-gated forms each own an error signal; this is the single
   *  place that maps a {@link PendingStepUp} form to it. */
  private setFormError(form: PendingStepUp['form'], message: string): void {
    if (form === 'ban') this.banError.set(message);
    else if (form === 'domainLock') this.domainLockError.set(message);
    else this.blockError.set(message);
  }

  /** The challenge succeeded: dismiss the dialog and re-issue the SAME write. The
   *  retry carries no token — mod-bff's gate reads the MFA_SATISFIED marker off
   *  the caller's own session, which the challenge has just stamped. */
  async stepUpSatisfied(): Promise<void> {
    const pending = this.pendingStepUp();
    if (!pending) return;
    this.pendingStepUp.set(null);
    await pending.retry();
  }

  /**
   * The moderator cancelled (or the deployment has no MFA): dismiss the dialog and
   * say plainly that NOTHING was applied. Silence here would be the worst outcome —
   * the write was refused, and a console that just closes the dialog looks like it
   * succeeded.
   */
  stepUpDismissed(dark = false): void {
    const pending = this.pendingStepUp();
    if (!pending) return;
    this.pendingStepUp.set(null);
    // Do NOT advise a retry the deployment cannot honour. The dialog reports
    // `dark` when every /bff/mfa/* call answered 503, i.e. app.casdoor.mfa.enabled
    // is off; in a deployment with enforce-sensitive-writes=true and that flag off
    // (mod-bff's own README warns they must be flipped together) no retry from
    // this console can EVER succeed, so the moderator is told to escalate instead.
    const message = dark
      ? `The ${pending.action} was NOT performed — it needs an MFA step-up, but two-factor ` +
        'authentication is not enabled on this deployment, so it cannot be confirmed here. ' +
        'Nothing was changed; ask an administrator to enable it.'
      : `The ${pending.action} was NOT performed — it needs a fresh MFA step-up, which was not ` +
        'completed. Nothing was changed; retry when you can confirm.';
    this.setFormError(pending.form, message);
  }

  /**
   * Build the honest async result message for a 202 desired-state write: the
   * effect is applied asynchronously by the reconcile loop, so we NEVER claim a
   * synchronous success — and we surface a degraded note when the admin-bff
   * breaker is open.
   */
  private pendingMessage(result: PendingReconcile, prefix: string): string {
    const degraded = result.degraded ? ` (degraded: ${result.degraded})` : '';
    return `${prefix} — the effect applies asynchronously (pending reconcile)${degraded}.`;
  }
}

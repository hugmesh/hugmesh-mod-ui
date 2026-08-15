import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  BanRequest,
  BlockRequest,
  DomainLockRole,
  ModAction,
  ModBffService,
  ModerationRequest,
  PendingReconcile,
  RecommendRequest,
} from './mod-bff.service';
import { AdminBffService } from './admin-bff.service';
import { SessionService } from './session.service';
import { accessibleName } from './accessible-name';
import { TargetTypeaheadComponent } from './target-typeahead.component';

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
 *  - a server-wide BLOCK form (POST /bff/mod/block) — the Matrix (tuwunel) leg
 *    is permanently STUBBED (no admin REST API exists), the Mastodon (akkoma)
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
  imports: [CommonModule, FormsModule, TargetTypeaheadComponent],
  templateUrl: './moderation-console.component.html',
  styleUrl: './moderation-console.component.scss',
})
export class ModerationConsoleComponent implements OnInit {
  private readonly bff = inject(ModBffService);
  private readonly admin = inject(AdminBffService);
  private readonly session = inject(SessionService);
  private readonly destroyRef = inject(DestroyRef);

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
  /** Surfaced honestly when a refer fails (bff.refer resolved null) — every other
   *  write in this console announces its failure, so refer must not be silent. */
  readonly referError = signal('');

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
   * Escalate a queue item up to an admin (the only mod removal path). A {@code
   * null} result means the refer was rejected server-side (e.g. the row was
   * already decided, or a 404/5xx) — surface it honestly instead of silently
   * leaving the row un-referred (bff.refer already reloaded the queue, so a real
   * success is reflected by the row flipping to `referred`).
   */
  async refer(id: number): Promise<void> {
    this.referError.set('');
    const referred = await this.bff.refer(id);
    if (!referred) {
      this.referError.set(`Could not refer request #${id} — it was NOT escalated (it may already be decided or referred).`);
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
    if (result) {
      this.recommendNote.set('Recommendation recorded in the federation queue for an admin to decide.');
      this.recommendTarget = '';
      this.recommendReason = '';
    } else {
      this.recommendError.set('The recommendation was rejected by the server.');
    }
  }

  // ── Server-wide block ──────────────────────────────────────────────
  async block(): Promise<void> {
    // Drop any stale success note (see recommend()).
    this.blockNote.set('');
    if (!this.target.trim()) {
      this.blockError.set('A target (user MXID/acct or instance domain) is required.');
      return;
    }
    this.blockError.set('');
    const result = await this.bff.block({
      platform: this.platform,
      scope: this.scope,
      target: this.target.trim(),
      reason: this.reason.trim() || undefined,
    });
    if (result) {
      this.blockNote.set(result.note ?? `Recorded. External result: ${result.external}.`);
      this.target = '';
      this.reason = '';
    } else {
      this.blockError.set('The block was rejected by the server.');
    }
  }

  // TODO: ban/lift, domainLock/domainUnlock, and block below submit with no MFA
  // step-up gate. Platform MFA + a step-up dialog already shipped in admin-ui
  // (wired into its own sensitive-write consoles); this remote never adopted
  // the same pattern for its own sensitive writes. See README Roadmap.
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
    const result = await this.bff.ban(this.banRequest());
    this.surfaceBan(result, 'Ban');
  }

  async lift(): Promise<void> {
    this.banNote.set(''); // drop any stale success note (see recommend())
    if (!this.banTarget.trim()) {
      this.banError.set('A target user is required.');
      return;
    }
    this.banError.set('');
    const result = await this.bff.lift(this.banRequest());
    this.surfaceBan(result, 'Lift');
  }

  private surfaceBan(result: PendingReconcile | null, verb: string): void {
    if (result) {
      this.banNote.set(this.pendingMessage(result, `${verb} accepted`));
      this.banTarget = '';
      this.banTtlSeconds = '';
      this.banReason = '';
    } else {
      this.banError.set(
        `The ${verb.toLowerCase()} was rejected — you cannot ban yourself or a moderator/administrator.`,
      );
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
    const result = await this.bff.domainLock(this.domainLockRole, this.domainLockUser.trim(), body);
    this.surfaceDomainLock(result, 'Domain-lock');
  }

  async domainUnlock(): Promise<void> {
    this.domainLockNote.set(''); // drop any stale success note (see recommend())
    if (!this.domainLockUser.trim()) {
      this.domainLockError.set('A target user is required.');
      return;
    }
    this.domainLockError.set('');
    const result = await this.bff.domainUnlock(this.domainLockRole, this.domainLockUser.trim());
    this.surfaceDomainLock(result, 'Domain-unlock');
  }

  private surfaceDomainLock(result: PendingReconcile | null, verb: string): void {
    if (result) {
      this.domainLockNote.set(this.pendingMessage(result, `${verb} accepted`));
      this.domainLockUser = '';
      this.domainLockReason = '';
    } else {
      this.domainLockError.set(
        `The ${verb.toLowerCase()} was rejected — you cannot domain-lock yourself or a moderator/administrator.`,
      );
    }
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

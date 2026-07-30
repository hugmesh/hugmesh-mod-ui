import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ModeratorService } from './api/services/moderator.service';

/**
 * Talks to the Spring Moderator BFF (hugmesh-mod-bff-api, behind the gateway),
 * the role analog of admin-ui's BffService. As a federated remote the Moderator
 * console only needs the MOD-scoped endpoints (`/bff/mod/**`); the
 * registration / login / service-token broker flow lives in the login remote,
 * which establishes the HttpOnly `bff_` session cookie and writes the shared
 * `hug.session` metadata (incl. roles) that this remote reads via SessionService.
 *
 * <p>Unlike a stateless wrapper this service is RxJS-BehaviorSubject-backed: the
 * moderation queue and the audit trail are cached in subjects so multiple views
 * (the console + a future dashboard) observe one source of truth and a mutation
 * (refer / block) can refresh the queue without each component re-fetching.
 *
 * <p><b>ng-openapi-gen migration:</b> this service now DELEGATES every call to
 * the generated, typed {@link ModeratorService} (under {@code src/app/api},
 * generated from the mod-bff-api OpenAPI spec) instead of hand-rolling
 * {@code fetch} URLs + a Bearer header. The generated client calls the SAME
 * same-origin {@code /bff/mod/**} paths (its {@code rootUrl} defaults to ''),
 * and the HttpOnly {@code bff_} session cookie is forwarded (credentials) by the
 * {@code authInterceptor} wired in bootstrap.ts — the gateway turns it into the
 * upstream Bearer server-side. This service keeps its OWN public {@link ModerationRequest} /
 * {@link ModAction} / request + response types so the consuming components
 * (moderation-console) need no change; the generated, weakly-typed
 * {@code Map<String,Object>} response bodies are bridged at the delegation
 * boundary (the BFF returns untyped envelopes, so the generated models are
 * {@code {[k:string]: {}}}). The historic contract is preserved exactly:
 * reads that fail resolve to {@code []}, writes that fail resolve to
 * {@code null} (never throw), and successful writes refresh the relevant cache.
 */
@Injectable({ providedIn: 'root' })
export class ModBffService {
  private readonly api = inject(ModeratorService);

  // ── BehaviorSubject-backed state (one source of truth per surface) ──
  private readonly moderation$ = new BehaviorSubject<ModerationRequest[]>([]);
  private readonly audit$ = new BehaviorSubject<ModAction[]>([]);
  private readonly findings$ = new BehaviorSubject<SystemFinding[]>([]);

  /** The cached moderation queue, observable by any view. */
  readonly moderation: Observable<ModerationRequest[]> = this.moderation$.asObservable();
  /** The cached local mod-action audit trail, observable by any view. */
  readonly audit: Observable<ModAction[]> = this.audit$.asObservable();
  /** The cached automated edge-AI system-finding queue, observable by any view. */
  readonly findings: Observable<SystemFinding[]> = this.findings$.asObservable();

  /** Untyped BFF envelope (generated body type is `{[k:string]: {}}`). */
  private static env(body: unknown): Record<string, unknown> {
    return (body ?? {}) as Record<string, unknown>;
  }

  // ── Moderation triage (federation-api queue) ───────────────────────
  /** GET /bff/mod/moderation — load the queue and push it onto the subject. */
  async loadModeration(status?: string): Promise<ModerationRequest[]> {
    const requests = await this.api.listModeration({ status })
      .then((b) => (ModBffService.env(b)['requests'] as ModerationRequest[]) ?? [])
      .catch(() => [] as ModerationRequest[]);
    this.moderation$.next(requests);
    return requests;
  }

  /**
   * POST /bff/mod/moderation/{id}/refer — refer/escalate a request UP to an
   * admin (the ONLY mod escalation path; a mod never removes directly). Refreshes
   * the cached queue so the referred row reflects its new status.
   */
  async refer(id: number): Promise<ModerationRequest | null> {
    const referred = await this.api.referModeration({ id })
      .then((b) => (ModBffService.env(b)['request'] as ModerationRequest) ?? null)
      .catch(() => null as ModerationRequest | null);
    await this.loadModeration();
    return referred;
  }

  /**
   * POST /bff/mod/moderation — record a moderation RECOMMENDATION into the
   * federation queue (the user→mod→admin chain's middle step). Refreshes the
   * cached queue so the new row appears.
   */
  async recommend(req: RecommendRequest): Promise<ModerationRequest | null> {
    const recommended = await this.api.recommendModeration({ body: req })
      .then((b) => (ModBffService.env(b)['request'] as ModerationRequest) ?? null)
      .catch(() => null as ModerationRequest | null);
    await this.loadModeration();
    return recommended;
  }

  // ── Server-wide block (external homeserver admin + local audit) ────
  /**
   * POST /bff/mod/block — block a user/instance server-wide on Matrix/Mastodon.
   * The Matrix (tuwunel) leg is permanently STUBBED (no admin REST API exists);
   * the Mastodon (akkoma) leg is WIRED to real pleroma-admin verbs but ships
   * dark by default. Either way the action is always recorded in the audit
   * table; the audit cache is refreshed on success.
   */
  async block(req: BlockRequest): Promise<BlockResult | null> {
    const result = await this.api.blockServerWide({ body: req })
      .then((b) => b as unknown as BlockResult)
      .catch(() => null as BlockResult | null);
    if (result === null) return null;
    await this.loadAudit();
    return result;
  }

  // ── Access-role ban / lift (write the access_suspension desired-state) ──
  /**
   * POST /bff/mod/ban — ban a user from a platform-access role. Returns the
   * 202 {state:'pending-reconcile', ...} envelope (NOT a synchronous "banned":
   * the effect is asynchronous). `ttlSeconds` absent/null = a PERMANENT ban.
   * Refreshes the audit cache so the recorded action appears. Returns null on a
   * non-2xx (e.g. the 403 a MOD gets banning a privileged/self target — which the
   * UI already mirrors by disabling those targets).
   */
  async ban(req: BanRequest): Promise<PendingReconcile | null> {
    const result = await this.api.banUser({ body: req })
      .then((b) => b as unknown as PendingReconcile)
      .catch(() => null as PendingReconcile | null);
    if (result === null) return null;
    await this.loadAudit();
    return result;
  }

  /**
   * DELETE /bff/mod/ban — lift a previously written ban (same BanRequest body;
   * ttlSeconds/reason ignored). Same 202 pending-reconcile contract.
   */
  async lift(req: BanRequest): Promise<PendingReconcile | null> {
    const result = await this.api.liftBan({ body: req })
      .then((b) => b as unknown as PendingReconcile)
      .catch(() => null as PendingReconcile | null);
    if (result === null) return null;
    await this.loadAudit();
    return result;
  }

  // ── Domain-lock / unlock (write domain_lock desired-state; ADD-semantics) ──
  /**
   * POST /bff/mod/domain-lock/{role}/{user} — force a user LOCAL-ONLY (ADD a
   * ROLE_*_DOMAINLOCKED marker; the user KEEPS their access role). role and user
   * travel as PATH variables; the optional {reason?, idempotencyKey?} body is
   * sent only when present. Same 202 pending-reconcile contract.
   */
  async domainLock(role: DomainLockRole, user: string, body?: DomainLockBody): Promise<PendingReconcile | null> {
    return this.domainLockCall('POST', role, user, body);
  }

  /**
   * DELETE /bff/mod/domain-lock/{role}/{user} — clear the local-only marker.
   * Same path-variable shape + 202 pending-reconcile contract (reason ignored).
   */
  async domainUnlock(role: DomainLockRole, user: string, body?: DomainLockBody): Promise<PendingReconcile | null> {
    return this.domainLockCall('DELETE', role, user, body);
  }

  private async domainLockCall(
    method: 'POST' | 'DELETE',
    role: DomainLockRole,
    user: string,
    body?: DomainLockBody,
  ): Promise<PendingReconcile | null> {
    const hasBody = !!(body && (body.reason || body.idempotencyKey));
    const params = { role, user, body: hasBody ? body : undefined };
    const call =
      method === 'POST' ? this.api.domainLockUser(params) : this.api.domainUnlockUser(params);
    const result = await call
      .then((b) => b as unknown as PendingReconcile)
      .catch(() => null as PendingReconcile | null);
    if (result === null) return null;
    await this.loadAudit();
    return result;
  }

  // ── Local mod-action audit trail ───────────────────────────────────
  /** GET /bff/mod/audit — load the audit trail and push it onto the subject. */
  async loadAudit(mine = false): Promise<ModAction[]> {
    const actions = await this.api.listAuditTrail(mine ? { mine: true } : {})
      .then((b) => (ModBffService.env(b)['actions'] as ModAction[]) ?? [])
      .catch(() => [] as ModAction[]);
    this.audit$.next(actions);
    return actions;
  }

  // ── Automated edge-AI system-finding queue ─────────────────────────
  /**
   * GET /bff/mod/findings — load the automated edge-AI moderation finding queue
   * (avatar/image vision checks filed by user-bff → federation-api) and push it
   * onto the subject. The list is issuer-domain-scoped server-side (a per-brand
   * mod sees only their own brand's findings). `status` ∈ held|dismissed|actioned;
   * omit for the full queue. Same fail-soft contract as the moderation read:
   * a non-2xx resolves to `[]` (never throws).
   */
  async loadFindings(status?: string): Promise<SystemFinding[]> {
    const findings = await this.api.listFindings({ status })
      .then((b) => (ModBffService.env(b)['findings'] as SystemFinding[]) ?? [])
      .catch(() => [] as SystemFinding[]);
    this.findings$.next(findings);
    return findings;
  }

  /**
   * POST /bff/mod/findings/{id}/resolve?actioned=<bool> — resolve a HELD finding:
   * `actioned=true` marks it ACTIONED (the mod confirmed it bad / took action),
   * `false` DISMISSES it (the mod cleared it). The reviewer is recorded server-side
   * from the forwarded JWT subject; a cross-domain id is 404'd server-side. On
   * success refreshes the cached queue (optimistic refresh) so the resolved row
   * reflects its new status. Returns the resolved finding, or null on a non-2xx
   * (never throws), mirroring the refer/recommend contract.
   */
  async resolveFinding(id: number, actioned: boolean): Promise<SystemFinding | null> {
    const resolved = await this.api.resolveFinding({ id, actioned })
      .then((b) => (ModBffService.env(b)['finding'] as SystemFinding) ?? null)
      .catch(() => null as SystemFinding | null);
    await this.loadFindings();
    return resolved;
  }
}

/**
 * Wire shape of a federation moderation-queue row — matched field-for-field to
 * hugmesh-mod-bff-api's {@code ModerationRequestDto}.
 *  - kind:   'instance-block' | 'user-removal'
 *  - status: 'recommended' | 'referred' | 'approved' | 'denied'
 */
export interface ModerationRequest {
  id: number;
  requester: string;
  kind: string;
  target: string;
  reason: string | null;
  status: string;
  modReferrer: string | null;
  adminDecider: string | null;
  ts: string;
}

/** Wire shape of a local audit row — matched to mod-bff-api's {@code ModAction}. */
export interface ModAction {
  id: string;
  actor: string;
  action: string;
  platform: string;
  target: string;
  reason: string | null;
  result: string;
  ts: string;
}

/**
 * Wire shape of an automated edge-AI {@code system_findings} row — matched
 * field-for-field to hugmesh-mod-bff-api's {@code SystemFindingDto}. A finding
 * is filed AUTOMATICALLY by an upstream avatar/image vision moderation check and
 * lands {@code held} for a human moderator to LIST + RESOLVE.
 *  - reporter:    always '@system' (the automated origin);
 *  - subject:     the content owner (Casdoor subject) whose image was flagged;
 *  - surface:     where the content was set ('profile-avatar', ...);
 *  - disposition: 'flagged' (published, queued) | 'rejected' (blocked at upload);
 *  - status:      'held' (awaiting review) | 'dismissed' (cleared) | 'actioned';
 *  - reviewer:    the mod/admin who resolved it (null while held);
 *  - confidence/policyHit/classification/perceptualHash: the edge-AI verdict;
 *  - domain:      the brand this finding belongs to (multi-tenancy).
 */
export interface SystemFinding {
  id: number;
  reporter: string;
  subject: string;
  surface: string;
  disposition: string;
  classification: string | null;
  confidence: number | null;
  policyHit: boolean | null;
  perceptualHash: string | null;
  status: string;
  reviewer: string | null;
  ts: string;
  domain: string | null;
}

/** Body for POST /bff/mod/block. */
export interface BlockRequest {
  platform: 'matrix' | 'mastodon';
  scope: 'user' | 'instance';
  target: string;
  reason?: string;
}

/** Response from POST /bff/mod/block: { blocked, external, note? }. */
export interface BlockResult {
  blocked: ModAction;
  external: string;
  note?: string;
}

/**
 * Body for POST /bff/mod/moderation — record a recommendation into the
 * federation queue. `kind` is the closed vocab federation-api validates.
 */
export interface RecommendRequest {
  kind: 'instance-block' | 'user-removal';
  target: string;
  reason?: string;
}

/**
 * Body for POST/DELETE /bff/mod/ban — ban a user from a platform-access role.
 * `ttlSeconds` absent = PERMANENT; a present value must be > 0. On a lift the
 * server ignores ttlSeconds/reason (only platform+target matter).
 */
export interface BanRequest {
  platform: 'matrix' | 'mastodon' | 'profile';
  target: string;
  ttlSeconds?: number;
  reason?: string;
  idempotencyKey?: string;
}

/** The two additive domain-lock marker roles (force a user local-only). */
export type DomainLockRole = 'ROLE_MATRIX_DOMAINLOCKED' | 'ROLE_MASTODON_DOMAINLOCKED';

/** Optional body for POST/DELETE /bff/mod/domain-lock/{role}/{user}. */
export interface DomainLockBody {
  reason?: string;
  idempotencyKey?: string;
}

/**
 * The 202 envelope every desired-state write (ban/lift/domain-lock/unlock)
 * returns — the effect is applied ASYNCHRONOUSLY by the single-writer reconcile
 * loop, so the UI surfaces this as an honest "pending reconcile" note, never as
 * a synchronous success. `degraded` is set when the admin-bff breaker is open.
 */
export interface PendingReconcile {
  state: string; // 'pending-reconcile' (or 'restored'/'cleared' on a lift/unlock)
  propagation?: string;
  deduped?: boolean;
  degraded?: string;
  [key: string]: unknown;
}

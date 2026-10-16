import { Injectable, signal, computed } from '@angular/core';

/**
 * The deserialized shape of the `hug.session` localStorage entry. Written by
 * the login remote once native login completes and the BFF has set the
 * HttpOnly `bff_` session cookie; read by every federated remote via this
 * service. This record itself carries no token (see the class doc below) —
 * only non-secret metadata. `roles` are lowercase Casdoor role slugs
 * (`'user'`, `'mod'`, `'admin'`, etc.).
 */
export interface SnapSession {
  /** Casdoor identity key, e.g. `google:alice@gmail.com`. */
  id: string;
  /** Human-readable display label (email or Discord handle). */
  label: string;
  /** The upstream identity provider (proxied through Casdoor) that authenticated this session. */
  provider: 'google' | 'discord';
  /** Lowercase Casdoor role slugs granted to this user. */
  roles: string[];
  /** Whether the user has completed the post-login registration flow. */
  registrationComplete: boolean;
}

/**
 * Holds the logged-in session (persisted to `localStorage` under `hug.session`)
 * and derives the Casdoor-style role-tier signals used by the moderator remote's
 * route guard ({@link modGuard}) and the moderation console, plus the
 * registration-complete gate the host uses to unlock the Matrix/Mastodon
 * micro-frontends.
 *
 * Holds only non-secret metadata: the BFF session and homeserver access tokens
 * are server-held and injected by the gateway/user-bff hsproxy
 * (`/bff/mod/**`, `/bff/user/matrix|mastodon/**`) keyed off the HttpOnly
 * `bff_` cookie — they never reach the browser. See {@link authInterceptor}
 * for how the cookie is attached to outgoing requests.
 *
 * This is the canonical HugMesh SessionService (its session plumbing is copied in
 * each native-federation remote because the federation runtime forbids shared
 * singletons across remote boundaries; the derived role-tier signals are NOT
 * guaranteed identical across copies — this remote's {@link isMod} admits
 * `'superadmin'` since decision 100, which not every copy does). Every copy reads/writes the SAME `hug.session`
 * localStorage key and dispatches/listens for the SAME `hug-session-change`
 * broadcast so all in-page instances (host shell + every loaded remote) stay in
 * sync without a round-trip to the server.
 *
 * @see {@link modGuard}              — uses {@link isMod} to gate the `/mod` route.
 * @see {@link ModerationConsoleComponent} — uses {@link isAdmin} for admin-only controls.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly key = 'hug.session';
  private readonly channel = 'hug-session-change';

  /** Reactive signal over the current session; `null` when logged out. */
  readonly session = signal<SnapSession | null>(this.load());

  /** `true` when a session is present (any role). */
  readonly loggedIn = computed(() => this.session() !== null);

  /**
   * ADMIN tier — Casdoor `'admin'` or `'superadmin'` role. The admin-bff gates its
   * endpoints on `hasRole('ADMIN')` (and `hasRole('SUPERADMIN')`); the
   * moderation console uses this to enable/disable the admin-only DECIDE controls.
   *
   * `'superadmin'` counts since operator decision 100 = A (2026-09-23,
   * hugmesh-generator#522). It grants no new privilege — it removes the one layer
   * that disagreed with every other:
   *  - mod-bff-api SecurityConfig: `/bff/mod/**` -> `hasAnyRole("MOD","ADMIN","SUPERADMIN")`,
   *    and its method-security role hierarchy makes SUPERADMIN a superset of ADMIN and MOD;
   *  - the host shell's own `isMod()` (hugmesh-host-shell session.service.ts) is
   *    `mod || admin || superadmin`, and it is what shows the Moderation menu entry.
   * Before this, a superadmin-only account saw that entry and was then sent to
   * `/login` by this remote's guard. Matching is by exact role slug, never substring.
   */
  readonly isAdmin = computed(() => {
    const roles = this.session()?.roles ?? [];
    return roles.includes('admin') || roles.includes('superadmin');
  });

  /**
   * MOD tier — a Casdoor `'mod'`, `'admin'` OR `'superadmin'` role. Unlocks this
   * entire remote; used by {@link modGuard} to allow/deny entry.
   *
   * `'superadmin'` counts since operator decision 100 = A (2026-09-23,
   * hugmesh-generator#522). It grants no new privilege — it removes the one layer
   * that disagreed with every other:
   *  - mod-bff-api SecurityConfig: `/bff/mod/**` -> `hasAnyRole("MOD","ADMIN","SUPERADMIN")`,
   *    and its method-security role hierarchy makes SUPERADMIN a superset of ADMIN and MOD;
   *  - the host shell's own `isMod()` (hugmesh-host-shell session.service.ts) is
   *    `mod || admin || superadmin`, and it is what shows the Moderation menu entry.
   * Before this, a superadmin-only account saw that entry and was then sent to
   * `/login` by this remote's guard. Matching is by exact role slug, never substring.
   */
  readonly isMod = computed(() => {
    const roles = this.session()?.roles ?? [];
    return roles.includes('mod') || roles.includes('admin') || roles.includes('superadmin');
  });

  /**
   * Whether the user has completed the post-login registration flow. Matrix and
   * Mastodon micro-frontends are available only after this is `true`.
   */
  readonly fullyRegistered = computed(() => this.session()?.registrationComplete === true);

  /**
   * Whether the user is a superadmin. This is a convenience signal for the
   * moderation console to distinguish superadmin-only accounts from admin-only
   * accounts (the DECIDE controls are now enabled for superadmin since decision
   * 100 = A).
   */
  readonly isSuperadmin = computed(() => (this.session()?.roles ?? []).includes('superadmin'));

  constructor() {
    // Each native-federation remote and the host shell get their OWN Angular
    // injector, so each holds its OWN SessionService instance. We keep them in
    // sync by:
    //  1. Listening for `hug-session-change` (same-document custom event, fired by
    //     whichever instance last called set/patch/clear) so in-page remotes stay
    //     current without a storage event.
    //  2. Listening for the `storage` event so cross-tab writes (e.g. logging in a
    //     second tab) propagate here too.
    if (typeof window !== 'undefined') {
      window.addEventListener(this.channel, () => this.session.set(this.load()));
      window.addEventListener('storage', (e) => {
        if (e.key === this.key) this.session.set(this.load());
      });
    }
  }

  /**
   * Replace the stored session with `s`, persist to `localStorage`, and broadcast
   * to the other in-page service instances.
   *
   * @param s The new session to store.
   */
  set(s: SnapSession): void {
    localStorage.setItem(this.key, JSON.stringify(s));
    this.session.set(s);
    this.broadcast();
  }

  /**
   * Apply a partial update to the current session (no-op when logged out).
   *
   * @param p Partial session fields to merge.
   */
  patch(p: Partial<SnapSession>): void {
    const s = this.session();
    if (s) this.set({ ...s, ...p });
  }

  /**
   * Log out: remove the stored session from `localStorage`, reset the signal to
   * `null`, and broadcast to the other in-page instances.
   */
  clear(): void {
    localStorage.removeItem(this.key);
    this.session.set(null);
    this.broadcast();
  }

  /**
   * Read and parse the stored session from `localStorage`. Returns `null` when
   * absent or on parse error (e.g. corrupted storage value).
   */
  private load(): SnapSession | null {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /**
   * Dispatch a same-document `hug-session-change` event so the other in-page
   * SessionService instances (host shell + other loaded remotes) re-read from
   * `localStorage` without waiting for a cross-tab `storage` event.
   */
  private broadcast(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(this.channel));
  }
}

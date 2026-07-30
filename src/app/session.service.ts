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
 * This is the canonical HugMesh SessionService (copied verbatim in each
 * native-federation remote because the federation runtime forbids shared singletons
 * across remote boundaries). Every copy reads/writes the SAME `hug.session`
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
   * ADMIN tier — Casdoor `'admin'` role. The admin-bff gates its endpoints on
   * `hasRole('ADMIN')`; the moderation console uses this to enable/disable the
   * admin-only DECIDE controls.
   */
  readonly isAdmin = computed(() => (this.session()?.roles ?? []).includes('admin'));

  /**
   * MOD tier — a Casdoor `'mod'` OR `'admin'` role. Unlocks this entire remote;
   * mirrors the mod-bff-api's defence-in-depth `hasAnyRole('MOD','ADMIN')`.
   * Used by {@link modGuard} to allow/deny entry.
   */
  readonly isMod = computed(() => {
    const roles = this.session()?.roles ?? [];
    return roles.includes('mod') || roles.includes('admin');
  });

  /**
   * Whether the user has completed the post-login registration flow. Matrix and
   * Mastodon micro-frontends are available only after this is `true`.
   */
  readonly fullyRegistered = computed(() => this.session()?.registrationComplete === true);

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

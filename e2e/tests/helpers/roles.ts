import { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * Catalogue of Casdoor seed users for the mod-ui e2e matrix. Adapted from the
 * proven hugmesh.games/e2e helper, keyed to THIS app's session model: the
 * mod-ui (and its host) persist a {@link SnapSession} under the `hug.session`
 * localStorage key (see src/app/session.service.ts), whose `roles: string[]`
 * drives the modGuard and the isMod()/isAdmin() flags. The Moderator surface
 * unlocks on a Casdoor 'mod' OR 'admin' role (defence-in-depth match to the
 * mod-bff-api's hasAnyRole('MOD','ADMIN')).
 *
 * The mod-ui is the MODERATION keystone, so the catalogue is built to exercise
 * the THREE coverage classes the wave demands AND the load-bearing distinction
 * the prompt names: a MOD acts over USERs but is NOT a superset of ADMIN.
 *   - USER-SITUATIONAL  — the moderation console surfaces, ALLOW (mod can act
 *                         over a user) + DENY/disabled+helptext (the admin-only
 *                         DECIDE / role-grant / external-client controls a mod
 *                         can never reach).
 *   - MULTIUSER         — a mod referring/recommending a user up to an admin.
 *   - CROSS-USER        — a mod DENIED on a privileged target (admin / another
 *                         mod / self) and DENIED across a tenant boundary; a
 *                         plain user bounced off the console entirely.
 *
 * The `kind` tag selects which role-specific assertions a feature drives. The
 * `domain` tag drives the cross-tenant isolation scenarios. Passwords default to
 * `process.env.E2E_PASSWORD` (or `e2e-pass`) unless a per-user override env var
 * is exported.
 */
export type RoleKind = 'superadmin' | 'admin' | 'mod' | 'user';

export interface SeedUser {
  /** CLI-friendly username referenced from .feature lines. */
  username: string;
  /** env var the compose overlay routes the cred through. */
  passwordEnv: string;
  /** Identity provider — mod-ui sessions are google- or discord-backed. */
  provider: 'google' | 'discord';
  /** The lowercased Casdoor roles this user carries in `hug.session.roles`. */
  roles: string[];
  /** Drives role-specific assertions. */
  kind: RoleKind;
  /** Brand/domain this user belongs to — used by the cross-tenant DENY specs. */
  domain?: string;
}

export const SEED_USERS: SeedUser[] = [
  // ── Moderator — the surface under test. A 'mod' role unlocks the console and
  //    may act OVER USERS (refer/recommend/ban/domain-lock/block) but is NOT a
  //    superset of admin: the DECIDE / role-grant / external-client controls are
  //    permanently disabled (no mod-bff endpoint). domain-a is the home tenant.
  { username: 'mod-domain-a', passwordEnv: 'E2E_MOD_A_PASSWORD', provider: 'google', roles: ['mod'], kind: 'mod', domain: 'domain-a' },

  // ── A second-tenant mod — drives cross-tenant isolation: a domain-A mod must
  //    not be able to act on a domain-B user/instance, and vice-versa.
  { username: 'mod-domain-b', passwordEnv: 'E2E_MOD_B_PASSWORD', provider: 'discord', roles: ['mod'], kind: 'mod', domain: 'domain-b' },

  // ── Admin — also admitted to the console (isMod() = mod OR admin). An admin
  //    DOES get a real, ENABLED approve/deny decide control per queue row here
  //    (moderation-console.component.html isAdmin() branch → AdminBffService →
  //    /bff/admin/moderation/{id}/decide); a MOD instead sees an aria-disabled
  //    `decide` button with why-helptext. The admin still gets NO role-grant /
  //    external-client control (those have no endpoint for anyone). The real
  //    admin decide round-trip is exercised in cross-user/admin-decide.feature.
  { username: 'admin-domain-a', passwordEnv: 'E2E_ADMIN_A_PASSWORD', provider: 'google', roles: ['admin'], kind: 'admin', domain: 'domain-a' },

  // ── A privileged TARGET the cross-user matrix uses: another moderator the
  //    mod-under-test must NOT be able to ban/domain-lock (the server 403s; the
  //    UI surfaces the rejection). Carries the 'mod' role as a target identity.
  { username: 'mod-target', passwordEnv: 'E2E_MOD_TARGET_PASSWORD', provider: 'google', roles: ['mod'], kind: 'mod', domain: 'domain-a' },

  // ── Plain user — no mod/admin role; bounced to /login by modGuard. The floor
  //    of the DENY matrix, and the legitimate TARGET of a mod action.
  { username: 'plain-user', passwordEnv: 'E2E_USER_PASSWORD', provider: 'google', roles: [], kind: 'user', domain: 'domain-a' },

  // ── Superadmin — the TOP of the role cascade (SUPERADMIN > ADMIN > MOD > USER).
  //    Deliberate fold-into-admin contract, matching the ACTUAL SessionService in
  //    src: mod-ui's isMod() recognises ONLY 'mod' or 'admin' (there is no
  //    superadmin flag in this remote, and mod-bff-api's @PreAuthorize is
  //    hasAnyRole('MOD','ADMIN') with no RoleHierarchy), so a superadmin reaches
  //    the moderation console EXCLUSIVELY through the folded 'admin' role their
  //    session carries. Seeded ['superadmin','admin'] — the same catalogue shape
  //    the admin-ui e2e uses for its superadmin persona.
  { username: 'superadmin', passwordEnv: 'E2E_SUPERADMIN_PASSWORD', provider: 'google', roles: ['superadmin', 'admin'], kind: 'superadmin', domain: 'domain-a' },
];

/** Resolve a seed user's password — env override or `E2E_PASSWORD` fallback —
 *  without throwing on a missing env. */
export function passwordFor(user: SeedUser): string {
  return process.env[user.passwordEnv]
    ?? process.env['E2E_PASSWORD']
    ?? 'e2e-pass';
}

/**
 * Create a fresh browser context that trusts the e2e self-signed cert AND uses
 * the same baseURL as the playwright config. The default `browser.newContext()`
 * does NOT inherit project-level `use` options (Playwright design choice), so a
 * spec that opens a manual context misses `ignoreHTTPSErrors: true` and every
 * HTTPS request fails the cert check — the native-federation manifest fetch is
 * the first casualty. Specs that need multiple users in parallel (the cross-user
 * isolation matrix) MUST call this instead of `browser.newContext()`.
 */
export async function newE2eContext(browser: Browser): Promise<BrowserContext> {
  return await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: process.env.E2E_BASE_URL ?? 'https://host.docker.internal:8443',
  });
}

/**
 * Drive the federated login form and wait for `hug.session` in localStorage.
 *
 * @cluster-only — this helper hits a LIVE Casdoor + host shell, so it is only
 * exercised by scenarios tagged `@cluster` today (wave 2b ships dark). It is
 * written now so a later wave can un-skip a feature without rewriting steps.
 *
 * The mod-ui's host shell renders the login micro-frontend; on success the
 * SessionService writes `hug.session` (see set()/broadcast()) and the gateway
 * sets the HttpOnly `bff_` session cookie. We wait for that key to carry an `id`
 * so a follow-up guarded navigation doesn't race the write.
 */
export async function login(page: Page, user: SeedUser): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  // The login remote exposes its form via formControlName selectors (the public
  // selector contract shared across the HugMesh UIs).
  await page.locator('input[formControlName="username"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.fill('input[formControlName="username"]', user.username);
  await page.fill('input[formControlName="password"]', passwordFor(user));
  await page.click('button.login-btn');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const raw = window.localStorage.getItem('hug.session');
      if (!raw) return false;
      try {
        return Boolean(JSON.parse(raw).id);
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15_000 },
  );
}

/**
 * Seed a {@link SnapSession} directly into localStorage WITHOUT a Casdoor round
 * trip. Mirrors the shape SessionService.set() writes, so the modGuard reading
 * the `roles` array behaves exactly as in production. Used ONLY by scenarios
 * that assert pure client-side guard/render behaviour (skip-link focus,
 * disabled+helptext, guard redirects, required-field validation): the HttpOnly
 * `bff_` cookie is minted exclusively by the real {@link login} flow, so a
 * seeded session fires every /bff/* request ANONYMOUSLY (401). Any scenario
 * whose steps read or write server truth — mod-console writes, GET /bff/session
 * markers, the hsproxy whoami probe, queue reloads, honest-envelope POSTs —
 * must prime the persona with {@link login} instead.
 */
export async function seedSession(page: Page, user: SeedUser): Promise<void> {
  const session = {
    id: `${user.provider}:${user.username}@example.test`,
    label: user.username,
    provider: user.provider,
    roles: user.roles,
    registrationComplete: true,
  };
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    ['hug.session', JSON.stringify(session)] as const,
  );
}

/** Clear the session — used between role swaps so a stale identity doesn't carry
 *  into the next scenario's guard check. */
export async function clearSession(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.removeItem('hug.session'));
}

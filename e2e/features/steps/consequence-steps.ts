// CROSS-USER CONSEQUENCE step definitions — the missing half of the moderation
// story: after a mod acts, the TARGET (in their OWN browser context, at the
// shared front door) must actually observe the consequence, and an escalation
// must actually arrive where it claims to go.
//
// Honesty rules encoded here:
//   - Never a fabricated oracle: chains that need a queue row CREATE it with a
//     per-scenario UNIQUE target (scenarioState.uniqueTarget) and later assert
//     THAT exact row from the other persona's context.
//   - Never a bare waitForTimeout: every mod-bff write is an honest async 202
//     (the reconcile loop applies the effect), so target-side observation uses
//     the expect.poll helpers in tests/helpers/waits.ts against the target's
//     OWN authenticated responses (hsproxy whoami / GET /bff/session roles) or
//     the reloaded moderation queue.
//   - The target's localStorage roles are only ever refreshed from the SERVER
//     truth (GET /bff/session — the login remote's hydrate contract), never
//     hand-written to the value the test wants to see.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { pageRegistry, ctxRegistry, scenarioState } from './_registry';
import { SeedUser, login, newE2eContext } from '../../tests/helpers/roles';
import {
  MATRIX_WHOAMI_PATH,
  pollBffStatus,
  pollQueueRow,
  pollSessionMarker,
  queueRowFor,
} from '../../tests/helpers/waits';

function pageOf(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  return page;
}

/** Per-scenario unique suffix so a queue-row oracle can never collide with a
 *  row left behind by an earlier run against the same stack. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

// ── Unique-target recommend / refer / observe chain ──────────────────────────

When('{string} recommends {string} of a unique target',
  async ({ user }, username: string, kind: string) => {
    const page = pageOf(user(username).username);
    const target = kind === 'user-removal'
      ? `@e2e-victim-${uniqueSuffix()}:domain-a.example`
      : `e2e-${uniqueSuffix()}.example`;
    scenarioState.uniqueTarget = target;
    await page.locator('[data-testid="mc-rec-kind"]').selectOption(kind);
    await page.locator('[data-testid="mc-rec-target"]').fill(target);
    await page.locator('[data-testid="mc-rec-submit"]').click();
  });

When('{string} refers the queue row for the unique target',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    if (!scenarioState.uniqueTarget) throw new Error('No unique target recorded — recommend one first.');
    // The recommend write refreshed the cached queue, so the freshly created row
    // is on screen; refer exactly THAT row (never a guessed id).
    const row = queueRowFor(page, scenarioState.uniqueTarget);
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.locator('button[data-refer]').click();
  });

Then('{string} sees the queue row for the unique target within {int} seconds',
  async ({ user }, username: string, seconds: number) => {
    const page = pageOf(user(username).username);
    if (!scenarioState.uniqueTarget) throw new Error('No unique target recorded — recommend one first.');
    await pollQueueRow(page, scenarioState.uniqueTarget, seconds * 1000);
  });

Then('{string} sees the queue row for the unique target with status {string} within {int} seconds',
  async ({ user }, username: string, status: string, seconds: number) => {
    const page = pageOf(user(username).username);
    if (!scenarioState.uniqueTarget) throw new Error('No unique target recorded — recommend one first.');
    await pollQueueRow(page, scenarioState.uniqueTarget, seconds * 1000, status);
  });

// ── USER→MOD chain: the user-ui recommend-instance-block submission ──────────

Given('{string} has submitted an instance-block recommendation for a unique instance in their own context',
  async ({ browser, user }, username: string) => {
    // The user persona files the recommendation through the user-bff endpoint
    // the user-ui block form POSTs (/bff/user/recommend-instance-block), from
    // their OWN context — via the REAL login flow, because the POST rides the
    // HttpOnly bff_ cookie only login mints (a seeded localStorage session
    // would submit anonymously and 401). The Given PROVES the submission landed
    // (2xx) — the mod queue assertion that follows is then a real cross-user
    // observation, not a hope.
    const u: SeedUser = user(username);
    const ctx = await newE2eContext(browser);
    const page = await ctx.newPage();
    ctxRegistry.set(u.username, ctx);
    pageRegistry.set(u.username, page);
    await login(page, u);

    const target = `e2e-${uniqueSuffix()}.example`;
    scenarioState.uniqueTarget = target;
    const status = await page.evaluate(
      async ({ instance }) => {
        const r = await fetch('/bff/user/recommend-instance-block', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instance, reason: 'e2e cross-user recommend chain' }),
        });
        return r.status;
      },
      { instance: target },
    );
    if (status < 200 || status >= 300) {
      throw new Error(`recommend-instance-block for "${target}" did not land: HTTP ${status}`);
    }
  });

// ── Matrix ban consequences (target-side) ────────────────────────────────────

Then('{string} can use the Matrix surface in their own context',
  async ({ user }, username: string) => {
    // Pre-ban ALLOW proof: the surface renders AND the identity resolves via the
    // ROLE_MATRIX-gated hsproxy — so the later gated state is a real transition.
    const page = pageOf(user(username).username);
    await page.goto('/social/matrix', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="matrix-view"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="matrix-whoami"]')).toBeVisible({ timeout: 30_000 });
  });

Then('{string} loses Matrix access within {int} seconds',
  async ({ user }, username: string, seconds: number) => {
    // The ban is a 202 desired-state write; the reconcile loop revokes
    // ROLE_MATRIX, at which point the target's OWN hsproxy identity probe flips
    // 200 → 401/403 (fail-closed). Poll the target's real response — never a
    // fixed sleep.
    const page = pageOf(user(username).username);
    await pollBffStatus(page, MATRIX_WHOAMI_PATH, [401, 403], seconds * 1000);
  });

Then('{string} regains Matrix access within {int} seconds',
  async ({ user }, username: string, seconds: number) => {
    const page = pageOf(user(username).username);
    await pollBffStatus(page, MATRIX_WHOAMI_PATH, [200], seconds * 1000);
  });

Then('{string} sees the Matrix identity gated in their own context',
  async ({ user }, username: string) => {
    // Post-ban UI state: the shell still renders (the route is registration-
    // gated, not role-gated) but the whoami identity line never resolves — the
    // banned state as the matrix remote actually surfaces it.
    //
    // matrix-whoami is *ngIf-gated on the ASYNC whoami fetch, so a bare
    // toHaveCount(0) straight after goto would pass vacuously mid-load for a
    // non-banned user too. Anchor the absence to the SETTLED state instead:
    // capture the page's own whoami response (registered BEFORE the navigation
    // so it can't be missed), require it to be the 401/403 revocation, and only
    // then assert the identity line was never rendered. The component fetches
    // whoami once in ngOnInit and leaves userId null on a non-OK response, so
    // after the failed fetch the absence is a stable, meaningful UI state.
    const page = pageOf(user(username).username);
    const whoamiSettled = page.waitForResponse(
      (r) => r.url().includes('/_matrix/client/v3/account/whoami'),
      { timeout: 30_000 },
    );
    await page.goto('/social/matrix', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="matrix-view"]')).toBeVisible({ timeout: 30_000 });
    const whoami = await whoamiSettled;
    expect([401, 403], 'the gated identity must come from a real auth rejection').toContain(whoami.status());
    await expect(page.locator('[data-testid="matrix-whoami"]')).toHaveCount(0);
  });

// ── Domain-lock consequences (target-side session marker + composer) ─────────

Then('{string} observes the {string} session marker within {int} seconds',
  async ({ user }, username: string, marker: string, seconds: number) => {
    const page = pageOf(user(username).username);
    await pollSessionMarker(page, marker, true, seconds * 1000);
  });

Then('{string} observes the {string} session marker cleared within {int} seconds',
  async ({ user }, username: string, marker: string, seconds: number) => {
    const page = pageOf(user(username).username);
    await pollSessionMarker(page, marker, false, seconds * 1000);
  });

When('{string} refreshes their session roles from the server',
  async ({ user }, username: string) => {
    // Mirror the login remote's hydrate custody: re-read the SERVER-truth roles
    // from GET /bff/session and fold them into hug.session (the marker value is
    // never invented by the test — a non-OK hydrate fails loudly). The broadcast
    // event is the same channel SessionService instances sync over.
    const page = pageOf(user(username).username);
    await page.evaluate(async () => {
      const r = await fetch('/bff/session', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`GET /bff/session returned ${r.status} — cannot hydrate roles`);
      const data = (await r.json()) as { roles?: string[]; registrationComplete?: boolean };
      const raw = window.localStorage.getItem('hug.session');
      const s = raw ? JSON.parse(raw) : {};
      s.roles = data.roles ?? [];
      if (typeof data.registrationComplete === 'boolean') s.registrationComplete = data.registrationComplete;
      window.localStorage.setItem('hug.session', JSON.stringify(s));
      window.dispatchEvent(new Event('hug-session-change'));
    });
  });

Then('{string} sees the composer coerced to local-only in their own context',
  async ({ user }, username: string) => {
    // The mastodon compose box, domain-locked: federated-reach options
    // (public/unlisted) DISABLED with the why-helptext wired, followers/direct
    // still usable, and the local-only toggle enforced ON. Server-side the
    // homeserver MRF is the source of truth; this asserts the honest mirror the
    // target is shown.
    const page = pageOf(user(username).username);
    await page.goto('/social/mastodon', { waitUntil: 'domcontentloaded' });
    const visibility = page.locator('[data-testid="compose-visibility"]').first();
    await expect(visibility).toBeVisible({ timeout: 30_000 });
    await expect(visibility.locator('option[value="public"]')).toBeDisabled();
    await expect(visibility.locator('option[value="unlisted"]')).toBeDisabled();
    await expect(visibility.locator('option[value="private"]')).toBeEnabled();
    await expect(visibility.locator('option[value="direct"]')).toBeEnabled();
    const help = page.locator('[data-testid="compose-visibility-help"]').first();
    await expect(help).toBeVisible();
    await expect(help).toContainText('domain-locked');
    const toggle = page.locator('[data-testid="compose-local-only-toggle"]').first();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

Then('{string} sees the composer offering federated reach in their own context',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    await page.goto('/social/mastodon', { waitUntil: 'domcontentloaded' });
    const visibility = page.locator('[data-testid="compose-visibility"]').first();
    await expect(visibility).toBeVisible({ timeout: 30_000 });
    await expect(visibility.locator('option[value="public"]')).toBeEnabled();
    await expect(visibility.locator('option[value="unlisted"]')).toBeEnabled();
    // No lock → the domain-locked visibility helptext is not rendered at all.
    await expect(page.locator('[data-testid="compose-visibility-help"]')).toHaveCount(0);
    const toggle = page.locator('[data-testid="compose-local-only-toggle"]').first();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

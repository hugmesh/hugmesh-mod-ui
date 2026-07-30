// Session / login / navigation step definitions backing the mod-ui features.
//
// Two flavours of session priming (each with a per-context cross-user variant):
//   - `Given "X" is logged in`         — full Casdoor round-trip via login()
//     (LIVE; only reached by @cluster scenarios in wave 2b). The ONLY flavour
//     that mints the HttpOnly `bff_` cookie, so any scenario whose steps hit
//     /bff/* (writes, session-truth reads, the honest-envelope POSTs) MUST use
//     this one.
//   - `Given "X" has a seeded session` — writes hug.session directly via an
//     addInitScript (OFFLINE-capable; exercises the pure client-side modGuard
//     and rendered disabled+helptext behaviour — no cookie, so /bff/* requests
//     from such a session are anonymous 401s).
//
// The navigation steps assert the guard outcome: a guarded route either renders
// its console view (ALLOW) or modGuard redirects to /login (DENY). All such
// steps live in @cluster features today because they need the host shell to be
// serving the remote; bddgen still compiles them so `--list` proves they parse.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { pageRegistry, ctxRegistry, responseState } from './_registry';
import {
  SeedUser,
  login,
  seedSession,
  clearSession,
  newE2eContext,
} from '../../tests/helpers/roles';

// ── Session priming ───────────────────────────────────────────────────────

Given('a clean session', async ({ page }) => {
  await clearSession(page);
});

Given('{string} is logged in', async ({ page, user }, username: string) => {
  const u: SeedUser = user(username);
  await login(page, u);
  pageRegistry.set(u.username, page);
});

Given('{string} has a seeded session', async ({ page, user }, username: string) => {
  const u: SeedUser = user(username);
  // addInitScript must run BEFORE the first navigation, so register the page and
  // seed; the navigation step that follows picks the session up on load.
  await seedSession(page, u);
  pageRegistry.set(u.username, page);
});

Given('{string} has a seeded session in their own context', async ({ browser, user }, username: string) => {
  // Cross-user matrix: give each user an isolated context so two identities can
  // coexist in one scenario without sharing localStorage. LOCALSTORAGE-ONLY —
  // no HttpOnly `bff_` cookie is minted, so this primes CLIENT-side guard/render
  // behaviour only; a persona whose steps hit /bff/* must use the logged-in
  // variant below instead.
  const u: SeedUser = user(username);
  const ctx = await newE2eContext(browser);
  const page = await ctx.newPage();
  await seedSession(page, u);
  ctxRegistry.set(u.username, ctx);
  pageRegistry.set(u.username, page);
});

Given('{string} is logged in in their own context', async ({ browser, user }, username: string) => {
  // Cross-user matrix, AUTHENTICATED: each persona gets an isolated context AND
  // a full Casdoor round-trip via login(), because only the real login flow
  // mints the HttpOnly `bff_` session cookie the gateway exchanges for the
  // upstream Bearer. Every step that reads/writes server truth from this
  // persona's context (GET /bff/session markers, the hsproxy whoami probe,
  // mod-console writes, queue reloads) REQUIRES this — a seeded localStorage
  // session would fire those requests anonymously and 401.
  const u: SeedUser = user(username);
  const ctx = await newE2eContext(browser);
  const page = await ctx.newPage();
  await login(page, u);
  ctxRegistry.set(u.username, ctx);
  pageRegistry.set(u.username, page);
});

// ── Navigation ─────────────────────────────────────────────────────────────

When('{string} navigates to {string}', async ({ user }, username: string, path: string) => {
  const u: SeedUser = user(username);
  const page = pageRegistry.get(u.username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
});

// ── Guard-outcome assertions ────────────────────────────────────────────────

Then('{string} sees the {string} view', async ({ user }, username: string, testid: string) => {
  // ALLOW: modGuard passed and the view rendered. mod-home-view and
  // moderation-console-view are the two stable data-testids in this remote.
  const page = pageRegistry.get(user(username).username)!;
  await expect(page.locator(`[data-testid="${testid}"]`)).toBeVisible({ timeout: 15_000 });
});

Then('{string} is redirected to the login page', async ({ user }, username: string) => {
  // DENY: modGuard returns router.parseUrl('/login'), so the URL settles on
  // /login and the console view never renders.
  const page = pageRegistry.get(user(username).username)!;
  await page.waitForURL(/\/login(\?|$)/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/login(\?|$)/);
});

Then('{string} does not see the {string} view', async ({ user }, username: string, testid: string) => {
  const page = pageRegistry.get(user(username).username)!;
  await expect(page.locator(`[data-testid="${testid}"]`)).toHaveCount(0);
});

// ── API-level cross-user / cross-tenant DENY ─────────────────────────────────
// The console is display-only; the mod-bff is the real gate. These steps fire a
// same-origin fetch with `credentials: 'include'` so the HttpOnly `bff_` session
// cookie travels (the gateway turns it into the upstream Bearer); the request
// exercises the actual mod-bff @PreAuthorize + the server-side "cannot act on a
// privileged/self/cross-tenant target" check, and capture the status.

/** A relative fetch from a page still parked on about:blank cannot resolve —
 *  move the page to the app origin first so the same-origin call (and its
 *  cookies) actually exercise the gateway. Exported so other step files (e.g.
 *  findings-steps.ts, seeding fixtures before navigation) can issue the same
 *  same-origin authenticated fetches. */
export async function ensureAppOrigin(page: NonNullable<ReturnType<typeof pageRegistry.get>>): Promise<void> {
  if (!page.url().startsWith('http')) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
}

When('{string} GETs {string}', async ({ user }, username: string, path: string) => {
  const page = pageRegistry.get(user(username).username)!;
  await ensureAppOrigin(page);
  responseState.lastStatus = await page.evaluate(
    async ({ url }) => {
      const r = await fetch(url, { credentials: 'include' });
      return r.status;
    },
    { url: path },
  );
});

When('{string} POSTs {string} with body {string}', async ({ user }, username: string, path: string, body: string) => {
  const page = pageRegistry.get(user(username).username)!;
  await ensureAppOrigin(page);
  // Capture status AND the parsed JSON envelope: the honest-envelope assertions
  // check the body (202 {state:'pending-reconcile'} / external stubbed) — a
  // desired-state write must NEVER be asserted as a synchronous success.
  const res = await page.evaluate(
    async ({ url, b }) => {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: b,
      });
      let parsed: unknown = null;
      try {
        parsed = await r.json();
      } catch {
        parsed = null;
      }
      return { status: r.status, body: parsed };
    },
    { url: path, b: body },
  );
  responseState.lastStatus = res.status;
  responseState.lastBody = res.body;
});

When('the unauthenticated client GETs {string}', async ({ page }, path: string) => {
  await page.goto('/');
  responseState.lastStatus = await page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return r.status;
  }, path);
});

When('the unauthenticated client POSTs {string}', async ({ page }, path: string) => {
  // The POST twin of the anonymous GET above: a genuinely unauthenticated caller
  // (no `bff_` cookie) hitting a write endpoint. The mod-bff filter chain gates
  // the whole /bff/mod/** path, so this settles the resolve endpoint's anonymous
  // floor (401) before any {id} lookup — an id-independent role-gate oracle.
  await page.goto('/');
  responseState.lastStatus = await page.evaluate(async (p) => {
    const r = await fetch(p, { method: 'POST', credentials: 'include' });
    return r.status;
  }, path);
});

Then('the response status is {int}', async ({}, expected: number) => {
  expect(responseState.lastStatus).toBe(expected);
});

Then('the response status is one of {int} or {int}', async ({}, a: number, b: number) => {
  expect([a, b]).toContain(responseState.lastStatus);
});

// ── Honest-envelope assertions (the anti-fake-success contract) ──────────────
// Every desired-state write (ban/lift/domain-lock) is applied ASYNCHRONOUSLY by
// the reconcile loop, and the Matrix admin leg of /bff/mod/block is STUBBED BY
// DESIGN (tuwunel has no REST admin API). These steps pin the honest envelope
// the operator is shown — 202 + pending — and would FAIL if the server ever
// started claiming a synchronous success it cannot prove.

function lastEnvelope(): Record<string, unknown> {
  expect(responseState.lastBody, 'expected a JSON envelope on the last response').toBeTruthy();
  return responseState.lastBody as Record<string, unknown>;
}

Then('the response is the honest 202 pending-reconcile envelope', async ({}) => {
  expect(responseState.lastStatus).toBe(202);
  const body = lastEnvelope();
  expect(body['state']).toBe('pending-reconcile');
});

Then('the response reports the Matrix block leg as stubbed and pending', async ({}) => {
  // The Matrix homeserver admin call is deliberately NOT made (stub), so the
  // block is NEVER "blocked"/ok — 202 with external:'stubbed' is the contract.
  expect(responseState.lastStatus).toBe(202);
  const body = lastEnvelope();
  expect(body['state']).toBe('pending-reconcile');
  expect(body['state']).not.toBe('blocked');
  expect(body['external']).toBe('stubbed');
});

Then('the response reports the Mastodon block leg as pending and never ok', async ({}) => {
  // The Akkoma leg is WIRED to pleroma-admin verbs, but on the local/dev stack
  // (vanilla Mastodon upstream, no admin token) those verbs 404/fail → the leg
  // reports stubbed or degraded:<reason>, NEVER ok, and the caller stays 202.
  expect(responseState.lastStatus).toBe(202);
  const body = lastEnvelope();
  expect(body['state']).toBe('pending-reconcile');
  expect(body['state']).not.toBe('blocked');
  expect(String(body['external'])).toMatch(/^(stubbed|degraded)/);
});

// ── Signed-out UI navigation bounce (no session of ANY kind) ─────────────────
// Unlike 'a clean session' (which clears a key on an existing page), these steps
// exercise a genuinely anonymous visitor: a fresh context with no hug.session
// ever written, navigating the guarded route directly.

Given('a signed-out visitor', async ({ page }) => {
  pageRegistry.set('anonymous', page);
});

When('the signed-out visitor navigates to {string}', async ({}, path: string) => {
  const page = pageRegistry.get('anonymous');
  if (!page) throw new Error('No anonymous page registered — add "Given a signed-out visitor" first.');
  await page.goto(path, { waitUntil: 'domcontentloaded' });
});

Then('the signed-out visitor is redirected to the login page', async ({}) => {
  const page = pageRegistry.get('anonymous')!;
  await page.waitForURL(/\/login(\?|$)/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/login(\?|$)/);
});

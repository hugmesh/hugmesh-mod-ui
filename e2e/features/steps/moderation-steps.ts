// Moderation-console step definitions — the heart of the mod-ui wave. They
// exercise the load-bearing distinction the prompt names: a MOD acts OVER USERS
// (refer / recommend / ban / domain-lock / block) but is NOT a superset of
// ADMIN, so the DECIDE / role-grant / external-client controls are PERMANENTLY
// disabled with WHY-helptext, and a mod-over-privileged/self/cross-tenant write
// is rejected by the server (the UI announces it in a role=alert live region).
//
// Markup under test (src/app/moderation-console.component.html):
//   - section data-testid="moderation-console-view" aria-labelledby="mc-heading"
//   - queue rows: button [data-refer]="id" (WIRED) + button [data-decide]="id"
//     aria-disabled (admin-only, NO mod endpoint) each with a [data-*-help] span
//   - recommend form: mc-rec-* (kind/target/reason/submit) + mc-rec-error(role=alert)
//     + mc-rec-note(role=status)
//   - ban form: mc-ban-* (platform/target/ttl/reason/submit/lift) + mc-ban-error/note
//   - domain-lock form: mc-dl-* (role/user/reason/lock/unlock) + mc-dl-error/note
//   - block form: mc-* (platform/scope/target/reason/block) + mc-block-error/note
//   - admin-only list: mc-role-grant-disabled / mc-external-client-disabled (+ help)
//
// All write scenarios are @cluster (need a live mod-bff + reconcile loop). The
// disabled+helptext + a11y-attribute assertions run OFFLINE against the rendered
// remote (no BFF needed) — those features carry @cluster only because the host
// shell must serve the remote; bddgen compiles them regardless.

import { Locator, Page, expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { banRequestState, pageRegistry } from './_registry';

function pageOf(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  return page;
}

// ── Disabled + helptext (the boundary a mod can NEVER cross) ─────────────────
// The DECIDE / role-grant / external-client controls use aria-disabled (NOT
// native disabled) so a screen reader still lands on them and reads the WHY.

Then('{string} sees the {string} control disabled with help text {string}',
  async ({ user }, username: string, controlTestid: string, helpTestid: string) => {
    const page = pageOf(user(username).username);
    const ctrl = page.locator(`[data-testid="${controlTestid}"]`);
    await expect(ctrl).toBeVisible();
    // aria-disabled is the a11y contract for these focusable-but-inert controls.
    await expect(ctrl).toHaveAttribute('aria-disabled', 'true');
    // The control names its own reason via aria-describedby → the help span.
    const describedby = await ctrl.getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();
    const help = page.locator(`[data-testid="${helpTestid}"]`);
    await expect(help).toBeVisible();
    const helpText = (await help.textContent())?.trim() ?? '';
    expect(helpText.length).toBeGreaterThan(0);
  });

Then('the per-row decide control for request {string} is disabled',
  async ({ page }, id: string) => {
    // The admin-only DECIDE control is rendered per queue row but is never
    // wired for a mod — aria-disabled, with a [data-decide-help] reason span.
    // (Single-persona step: the pattern carries only the row id, so it reads
    // the scenario's default page — the arity previously declared here made
    // the step un-runnable: bddgen flagged "Function has 3 arguments, but
    // expected 2".)
    const decide = page.locator(`[data-decide="${id}"]`);
    await expect(decide).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator(`[data-decide-help="${id}"]`)).toBeVisible();
  });

Then('the per-row refer control for request {string} is enabled',
  async ({ page }, id: string) => {
    // refer (escalate up to an admin) is the ONLY mod removal path and IS wired
    // — enabled unless the row is already referred.
    await expect(page.locator(`[data-refer="${id}"]`)).toBeEnabled();
  });

// ── Mod-over-user ALLOW: fill + submit a moderation write form ───────────────
// These assert the UI plumbing (form fill → submit → live-region outcome). The
// outcome text is the honest async "pending reconcile" note, surfaced politely.

When('{string} recommends {string} of {string}',
  async ({ user }, username: string, kind: string, target: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-rec-kind"]').selectOption(kind);
    await page.locator('[data-testid="mc-rec-target"]').fill(target);
    await page.locator('[data-testid="mc-rec-submit"]').click();
  });

When('{string} refers queue request {string} up to an admin',
  async ({ user }, username: string, id: string) => {
    const page = pageOf(user(username).username);
    await page.locator(`[data-refer="${id}"]`).click();
  });

When('{string} bans {string} on {string}',
  async ({ user }, username: string, target: string, platform: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-ban-platform"]').selectOption(platform);
    await page.locator('[data-testid="mc-ban-target"]').fill(target);
    await page.locator('[data-testid="mc-ban-submit"]').click();
  });

When('{string} domain-locks {string}',
  async ({ user }, username: string, target: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-dl-user"]').fill(target);
    await page.locator('[data-testid="mc-dl-lock"]').click();
  });

// ── Ban variants: TTL vs permanent, and the LIFT (DELETE) control ────────────
// The mc-ban-ttl field is the real timed-ban control: a positive value writes a
// TTL'd access_suspension; leaving it BLANK is the explicit permanent variant.
// "Lift ban" (mc-ban-lift) issues the DELETE /bff/mod/ban for the same
// platform+target — the restore half of the ALLOW pair.
//
// Both variants render the SAME "Ban accepted" note, so the note alone cannot
// distinguish the TTL semantics. The observable oracle is the request the
// console actually sends: submitBanCapturing() registers waitForRequest BEFORE
// the click and records the POST /bff/mod/ban JSON body, which the
// "submitted ban carried ..." Then-steps pin (ttlSeconds present vs omitted —
// the component drops a blank field to undefined, which never serialises).

async function submitBanCapturing(page: Page): Promise<void> {
  const captured = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === '/bff/mod/ban',
    { timeout: 15_000 },
  );
  await page.locator('[data-testid="mc-ban-submit"]').click();
  banRequestState.lastBody = (await captured).postDataJSON() as Record<string, unknown>;
}

When('{string} bans {string} on {string} with a TTL of {string} seconds',
  async ({ user }, username: string, target: string, platform: string, ttl: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-ban-platform"]').selectOption(platform);
    await page.locator('[data-testid="mc-ban-target"]').fill(target);
    await page.locator('[data-testid="mc-ban-ttl"]').fill(ttl);
    await submitBanCapturing(page);
  });

When('{string} bans {string} on {string} with the TTL left blank',
  async ({ user }, username: string, target: string, platform: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-ban-platform"]').selectOption(platform);
    await page.locator('[data-testid="mc-ban-target"]').fill(target);
    // Explicitly clear the TTL field (it may carry a value from an earlier fill
    // in the same scenario); the captured request body — NOT this fill — is
    // what proves the permanent semantics.
    await page.locator('[data-testid="mc-ban-ttl"]').fill('');
    await submitBanCapturing(page);
  });

Then('the submitted ban carried a TTL of {int} seconds', async ({}, ttl: number) => {
  const body = banRequestState.lastBody;
  expect(body, 'expected a captured /bff/mod/ban request body — submit a ban first').toBeTruthy();
  expect(body!['ttlSeconds']).toBe(ttl);
});

Then('the submitted ban carried no TTL and is permanent', async ({}) => {
  const body = banRequestState.lastBody;
  expect(body, 'expected a captured /bff/mod/ban request body — submit a ban first').toBeTruthy();
  // A blank TTL field parses to undefined and the key never serialises; a
  // defensive null is equally "permanent" per the BanRequest API model.
  expect(body!['ttlSeconds'] ?? null).toBeNull();
});

When('{string} lifts the ban for {string} on {string}',
  async ({ user }, username: string, target: string, platform: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-ban-platform"]').selectOption(platform);
    await page.locator('[data-testid="mc-ban-target"]').fill(target);
    await page.locator('[data-testid="mc-ban-lift"]').click();
  });

// ── Domain-lock with an explicit platform (matrix | mastodon) ────────────────
// The mc-dl-role select carries the two additive marker roles; mapping the
// business-language platform here keeps the feature lines declarative.

const DOMAIN_LOCK_ROLE: Record<string, string> = {
  matrix: 'ROLE_MATRIX_DOMAINLOCKED',
  mastodon: 'ROLE_MASTODON_DOMAINLOCKED',
};

function domainLockRoleFor(platform: string): string {
  const role = DOMAIN_LOCK_ROLE[platform];
  if (!role) throw new Error(`Unknown domain-lock platform "${platform}" — use matrix or mastodon.`);
  return role;
}

When('{string} domain-locks {string} on the {string} platform',
  async ({ user }, username: string, target: string, platform: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-dl-role"]').selectOption(domainLockRoleFor(platform));
    await page.locator('[data-testid="mc-dl-user"]').fill(target);
    await page.locator('[data-testid="mc-dl-lock"]').click();
  });

When('{string} removes the domain-lock for {string} on the {string} platform',
  async ({ user }, username: string, target: string, platform: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-dl-role"]').selectOption(domainLockRoleFor(platform));
    await page.locator('[data-testid="mc-dl-user"]').fill(target);
    await page.locator('[data-testid="mc-dl-unlock"]').click();
  });

When('{string} blocks {string} at {string} scope',
  async ({ user }, username: string, target: string, scope: string) => {
    const page = pageOf(user(username).username);
    await page.locator('[data-testid="mc-scope"]').selectOption(scope);
    await page.locator('[data-testid="mc-target"]').fill(target);
    await page.locator('[data-testid="mc-block"]').click();
  });

// ── Live-region outcome assertions (polite success / assertive rejection) ────

Then('{string} sees the recommend success note', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const note = page.locator('[data-testid="mc-rec-note"]');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
});

Then('{string} sees the ban accepted note', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const note = page.locator('[data-testid="mc-ban-note"]');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
});

Then('{string} sees the ban note containing {string}',
  async ({ user }, username: string, fragment: string) => {
    // Distinguishes the Ban vs Lift outcome: the note is the honest async
    // "<verb> accepted — the effect applies asynchronously (pending reconcile)"
    // message, so asserting the verb fragment pins WHICH write was accepted.
    const page = pageOf(user(username).username);
    const note = page.locator('[data-testid="mc-ban-note"]');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('role', 'status');
    await expect(note).toContainText(fragment);
  });

Then('{string} sees the domain-lock note containing {string}',
  async ({ user }, username: string, fragment: string) => {
    const page = pageOf(user(username).username);
    const note = page.locator('[data-testid="mc-dl-note"]');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('role', 'status');
    await expect(note).toContainText(fragment);
  });

Then('{string} sees the domain-lock accepted note', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const note = page.locator('[data-testid="mc-dl-note"]');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
});

Then('{string} sees the block recorded note', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const note = page.locator('[data-testid="mc-block-note"]');
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('role', 'status');
});

// ── CROSS-USER DENY (mod-over-privileged / self / cross-tenant) ──────────────
// The server 403s a mod banning/locking a privileged or self target; the BFF
// service returns {ok:false, error} carrying that status and the component sets
// the *-error signal, which renders in a role=alert / aria-live=assertive
// region. We assert that announced refusal appears (the user-facing half of the
// defence-in-depth).
//
// What is asserted is the INVARIANT, not one sentence. Two things make a fixed
// string wrong here:
//   1. Since hugmesh-mod-ui#14 the console prints the server's OWN reason when
//      mod-bff supplies one, and only falls back to the privileged/self-target
//      possibility when it does not — so pinning the old fixed accusation would
//      fail the moment the API starts explaining itself, which is a change we
//      want, not a regression.
//   2. This feature's own API-layer scenarios (below) assert "403 or 404" for
//      exactly these targets, because the mod-bff is free to fail closed either
//      way — a 404 hides whether the target even exists. Pinning 403 alone would
//      fail on the 404 branch of the contract this file documents, and neither
//      CI nor this host can run these scenarios to catch it (they are @cluster
//      and ship dark).
// So: an accessible alert, naming THIS action, refused or not-applied, at a
// status inside the documented DENY set — and never the old asserted accusation.

/** The DENY invariant both cross-user steps assert, for `ban` or `domain-lock`. */
async function expectDeniedAtDenyStatus(err: Locator, action: string): Promise<void> {
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('role', 'alert');
  const text = (await err.textContent())?.toLowerCase() ?? '';
  // `describeWriteFailure` renders "The <action> was refused — HTTP 403 …" and
  // "The <action> was not applied — HTTP 404 …"; anything the server explained
  // is appended AFTER, so this matches with or without a server reason.
  expect(text).toMatch(
    new RegExp(`the ${action} was (refused|not applied) \u2014 http (403|404)\\b`),
  );
  // The defect #14 fixed: a cause asserted as fact for every failure. The
  // privileged/self-target rule may now only be OFFERED, after "gave no reason".
  expect(text).not.toMatch(/was rejected \u2014 you cannot/);
}

Then('{string} sees the ban rejected alert', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const err = page.locator('[data-testid="mc-ban-error"]');
  await expect(err).toHaveAttribute('aria-live', 'assertive');
  await expectDeniedAtDenyStatus(err, 'ban');
});

Then('{string} sees the domain-lock rejected alert', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await expectDeniedAtDenyStatus(page.locator('[data-testid="mc-dl-error"]'), 'domain-lock');
});

// ── Required-field validation (USER-SITUATIONAL, runs offline) ──────────────

When('{string} submits the ban form with an empty target', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await page.locator('[data-testid="mc-ban-target"]').fill('');
  await page.locator('[data-testid="mc-ban-submit"]').click();
});

Then('{string} sees a required-target validation alert on the ban form', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const err = page.locator('[data-testid="mc-ban-error"]');
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(page.locator('[data-testid="mc-ban-target"]')).toHaveAttribute('aria-invalid', 'true');
});

// ── Queue status filter (USER-SITUATIONAL) ──────────────────────────────────

When('{string} filters the queue by {string}', async ({ user }, username: string, status: string) => {
  const page = pageOf(user(username).username);
  await page.locator('[data-testid="mc-status"]').selectOption(status);
});

Then('{string} sees the moderation queue table', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await expect(page.locator('[data-testid="mc-queue"]')).toBeVisible();
});

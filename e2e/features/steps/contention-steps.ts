// CONTENTION / DECIDE / AUDIT / TENANT-ISOLATION step definitions — the
// multiuser gaps the existing suite left open (see the audit's e2e_gaps):
//   - the ADMIN approve/deny decide ROUND-TRIP this console actually wires
//     (moderation-console.component.html isAdmin() branch → data-approve /
//     data-deny → AdminBffService.decide → /bff/admin/moderation/{id}/decide),
//     incl. the honest mc-decide-error failure surface and two-admin contention;
//   - MOD-B's view after MOD-A refers (disabled-once-referred, cross-context);
//   - findings double-resolve (two same-tenant mods contend over one held row);
//   - cross-tenant findings isolation against a REAL seeded finding;
//   - audit-trail CONTENT + cross-mod visibility (a shared server record, not a
//     per-browser echo — the trail is DOMAIN-scoped server-side, so the second
//     observer is a SAME-tenant mod);
//   - the moderation-queue status filter's captured scoped-GET oracle (parity
//     with the findings filter, which the queue filter previously lacked).
//
// Honesty rules (same as consequence-steps.ts): unique per-scenario targets
// (never a fabricated id used as a DENY oracle), victim-creates-first for every
// real-resource DENY, real Casdoor logins for anything touching /bff/*, and
// bounded expect.poll reloads (never a fixed sleep). All scenarios that use
// these steps are @cluster (a live host shell + mod-bff + admin-bff +
// federation-api + reconcile loop is required) and ship dark; bddgen still
// compiles them so `playwright test --list` proves they parse.

import { expect } from '@playwright/test';
import { When, Then } from '../support/fixtures';
import { pageRegistry, scenarioState, moderationState, findingsState } from './_registry';
import { queueRowFor } from '../../tests/helpers/waits';
import { ensureAppOrigin } from './session-steps';

function pageOf(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  return page;
}

/** Per-scenario unique suffix (mirrors consequence-steps) so a row/target oracle
 *  can never collide with one left behind by an earlier run on the same stack. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

/** The mod-action AUDIT row whose Target cell is EXACTLY `target`. Audit columns:
 *  When | Actor | Action | Platform | Target | Result. */
function auditRowFor(page: ReturnType<typeof pageOf>, target: string) {
  return page
    .locator('[data-testid="mc-audit"] tbody tr')
    .filter({ has: page.getByRole('cell', { name: target, exact: true }) });
}

// ── ADMIN decide round-trip (approve / deny the unique referred row) ─────────
// The admin's console renders a real, ENABLED approve/deny pair per row
// (data-approve / data-deny) wired to AdminBffService.decide; clicking flips the
// server-side status, which the queue reload (pollQueueRow) then observes.

When('{string} approves the queue row for the unique target', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const target = scenarioState.uniqueTarget;
  if (!target) throw new Error('No unique target recorded — recommend one first.');
  const row = queueRowFor(page, target);
  await expect(row, `expected exactly one queue row for "${target}" to approve`).toHaveCount(1, { timeout: 15_000 });
  await row.locator('button[data-approve]').click();
});

When('{string} denies the queue row for the unique target', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const target = scenarioState.uniqueTarget;
  if (!target) throw new Error('No unique target recorded — recommend one first.');
  const row = queueRowFor(page, target);
  await expect(row, `expected exactly one queue row for "${target}" to deny`).toHaveCount(1, { timeout: 15_000 });
  await row.locator('button[data-deny]').click();
});

// ── Honest decide FAILURE surface (mc-decide-error, row left untouched) ──────
// Failure injection at the transport layer: force the decide POST to 500 so
// AdminBffService.decide resolves null and the component surfaces the honest
// mc-decide-error WITHOUT ever rendering the row as decided. This exercises the
// component's real failure branch (not a fabricated queue), and the companion
// Then-step asserts the row's status is left at 'referred' (never fabricated).
When('{string} will have their next decide call fail with a server error',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    await page.route('**/bff/admin/moderation/**/decide**', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    );
  });

Then('{string} sees the decide error', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  const err = page.locator('[data-testid="mc-decide-error"]');
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toHaveAttribute('aria-live', 'assertive');
});

// ── Two-admin double-decide: the row settles to ONE server-authoritative
//    terminal status (approved|denied), never two contradictory terminals ─────
Then('{string} sees the queue row for the unique target settle to a single terminal decided status within {int} seconds',
  async ({ user }, username: string, seconds: number) => {
    const page = pageOf(user(username).username);
    const target = scenarioState.uniqueTarget;
    if (!target) throw new Error('No unique target recorded — recommend one first.');
    await expect
      .poll(
        async () => {
          // Reload the queue from server truth (poll-on-action; no mod SSE).
          await page.locator('[data-testid="mc-status-apply"]').click();
          const total = await queueRowFor(page, target).count();
          if (total !== 1) return `rows=${total}`;
          const approved = await queueRowFor(page, target, 'approved').count();
          const denied = await queueRowFor(page, target, 'denied').count();
          return approved + denied === 1 ? 'terminal' : 'not-terminal';
        },
        {
          timeout: seconds * 1000,
          message: `expected the "${target}" row to settle to exactly one approved|denied terminal status within ${seconds}s`,
        },
      )
      .toBe('terminal');
  });

// ── MOD-B's view after MOD-A refers: disabled-once-referred, cross-context ───
Then('{string} sees the refer control disabled on the queue row for the unique target',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    const target = scenarioState.uniqueTarget;
    if (!target) throw new Error('No unique target recorded — recommend one first.');
    const row = queueRowFor(page, target, 'referred');
    await expect(row, `expected the referred "${target}" row on MOD-B's reloaded queue`).toHaveCount(1, { timeout: 15_000 });
    await expect(row.locator('button[data-refer]')).toBeDisabled();
  });

// ── Findings double-resolve: the seeded row is authoritative to MOD-A's win ──
// After MOD-A confirms (actioned) and MOD-B's stale dismiss is rejected, a
// reload must show the finding as MOD-A resolved it — the server state, not
// MOD-B's later click.
Then('{string} sees the seeded finding resolved as {string}',
  async ({ user }, username: string, expectedStatus: string) => {
    const page = pageOf(user(username).username);
    const seededId = findingsState.lastSeededFindingId;
    if (!seededId) throw new Error('no seeded finding id — seed a held finding first');
    await expect
      .poll(
        async () => {
          // Reload the panel from server truth via the real Apply control.
          await page.locator('[data-testid="fp-status-apply"]').click();
          const row = page.locator(`[data-finding-id="${seededId}"]`);
          if ((await row.count()) === 0) return 'absent';
          // Columns: ID | Surface | Subject | Status | Created | Reviewer | actions.
          return (await row.locator('td').nth(3).textContent())?.trim() ?? '';
        },
        {
          timeout: 15_000,
          message: `expected seeded finding #${seededId} to read "${expectedStatus}" after reload`,
        },
      )
      .toBe(expectedStatus);
  });

// ── Cross-tenant findings isolation: a domain-B mod cannot SEE a domain-A
//    seeded finding (victim-creates-first — the finding genuinely exists) ─────
Then('{string} does not see the seeded finding in their findings queue',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    await ensureAppOrigin(page);
    const seededId = findingsState.lastSeededFindingId;
    if (!seededId) throw new Error('no seeded finding id — seed a held finding first');
    const ids = await page.evaluate(async () => {
      const r = await fetch('/bff/mod/findings', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!r.ok) throw new Error(`GET /bff/mod/findings returned ${r.status}`);
      const data = (await r.json()) as { findings?: { id?: number }[] };
      return (data.findings ?? []).map((f) => f.id);
    });
    expect(ids, `a domain-B mod must not see the domain-A finding #${seededId} in their own queue`)
      .not.toContain(seededId);
  });

// ── Audit-trail CONTENT + cross-mod visibility ───────────────────────────────
// A mod's server-wide block is ALWAYS locally audited (ModController.block →
// mod_action). The unique target is the strong oracle; the actor is captured
// from the acting mod's own view and re-asserted from a SECOND same-tenant mod's
// reloaded view (the trail is domain-scoped, so both domain-a mods see it).

When('{string} records a server-wide user block for a unique target',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    const target = `@spammer-${uniqueSuffix()}:e2e-audit.example`;
    scenarioState.uniqueTarget = target;
    // platform defaults to matrix; scope=user blocks a single account.
    await page.locator('[data-testid="mc-scope"]').selectOption('user');
    await page.locator('[data-testid="mc-target"]').fill(target);
    await page.locator('[data-testid="mc-reason"]').fill('e2e audit-trail visibility');
    await page.locator('[data-testid="mc-block"]').click();
  });

Then('{string} sees the audit row for the unique target with a recorded actor',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    const target = scenarioState.uniqueTarget;
    if (!target) throw new Error('No unique target recorded — record a block first.');
    const row = auditRowFor(page, target);
    await expect(row, `expected an mc-audit row for "${target}" (the block is always locally audited)`)
      .toHaveCount(1, { timeout: 15_000 });
    // Actor is the 2nd cell (When | Actor | Action | Platform | Target | Result).
    const actor = (await row.locator('td').nth(1).textContent())?.trim() ?? '';
    expect(actor.length, 'the audit row must record an acting moderator').toBeGreaterThan(0);
    scenarioState.auditActor = actor;
  });

Then('{string} also sees the same audit row for the unique target within {int} seconds',
  async ({ user }, username: string, seconds: number) => {
    const page = pageOf(user(username).username);
    const target = scenarioState.uniqueTarget;
    if (!target) throw new Error('No unique target recorded — record a block first.');
    await expect
      .poll(
        async () => {
          // Fresh mount → ModController /audit read (domain-scoped) each attempt.
          await page.goto('/mod/console', { waitUntil: 'domcontentloaded' });
          return auditRowFor(page, target).count();
        },
        {
          timeout: seconds * 1000,
          message: `expected the SECOND same-tenant mod to also see the audit row for "${target}" within ${seconds}s`,
        },
      )
      .toBeGreaterThan(0);
    // Same server record → the SAME actor, not this browser's own identity.
    const actor = (await auditRowFor(page, target).locator('td').nth(1).textContent())?.trim() ?? '';
    expect(actor, 'the shared audit row must show the ORIGINAL actor to both mods').toBe(scenarioState.auditActor);
  });

// ── Moderation queue status-filter captured scoped-GET oracle ────────────────
// Parity with the findings filter: prove applyStatusFilter() reloaded the queue
// scoped to the chosen status by capturing the OUTBOUND GET (issued client-side
// regardless of the response, so it is observable on a seeded/offline session).

When('{string} filters the queue by {string} capturing the reload',
  async ({ user }, username: string, status: string) => {
    const page = pageOf(user(username).username);
    const captured = page.waitForRequest(
      (r) => {
        if (r.method() !== 'GET') return false;
        const u = new URL(r.url());
        return u.pathname === '/bff/mod/moderation' && u.searchParams.get('status') === status;
      },
      { timeout: 15_000 },
    );
    await page.locator('[data-testid="mc-status"]').selectOption(status);
    moderationState.lastListUrl = (await captured).url();
  });

Then('the moderation queue reload was scoped to the {string} status', async ({}, status: string) => {
  expect(moderationState.lastListUrl, 'expected a captured GET /bff/mod/moderation — filter the queue first').toBeTruthy();
  const u = new URL(moderationState.lastListUrl!);
  expect(u.pathname).toBe('/bff/mod/moderation');
  expect(u.searchParams.get('status')).toBe(status);
});

// ── Audit-trail 'mine' filter captured scoped-GET oracle ─────────────────────
// Parity with the queue/findings filter oracles: prove the newly-exposed
// "only my own actions" toggle reloaded the audit trail scoped to ?mine=true by
// capturing the OUTBOUND GET (fired client-side regardless of the response, so
// it is observable on a seeded/offline session — it proves applyAuditFilter()
// re-queried GET /bff/mod/audit?mine).

When('{string} filters the audit trail to only their own actions capturing the reload',
  async ({ user }, username: string) => {
    const page = pageOf(user(username).username);
    const captured = page.waitForRequest(
      (r) => {
        if (r.method() !== 'GET') return false;
        const u = new URL(r.url());
        return u.pathname === '/bff/mod/audit' && u.searchParams.get('mine') === 'true';
      },
      { timeout: 15_000 },
    );
    await page.locator('[data-testid="mc-audit-mine"]').check();
    moderationState.lastAuditUrl = (await captured).url();
  });

Then('the audit trail reload was scoped to only my own actions', async ({}) => {
  expect(moderationState.lastAuditUrl, 'expected a captured GET /bff/mod/audit?mine — toggle the mine filter first').toBeTruthy();
  const u = new URL(moderationState.lastAuditUrl!);
  expect(u.pathname).toBe('/bff/mod/audit');
  expect(u.searchParams.get('mine')).toBe('true');
});

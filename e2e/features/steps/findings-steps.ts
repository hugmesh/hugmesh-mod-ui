// System-findings-panel step definitions. Markup under test
// (src/app/findings-panel.component.html): section
// data-testid="findings-panel-view", queue table data-testid="fp-queue" with
// column headers ID/Surface/Subject/Status/Created/Reviewer, an empty-state row
// data-testid="fp-queue-empty", a disposition <select data-testid="fp-status">
// (closed vocab '' | held | actioned | dismissed) with an Apply submit
// (fp-status-apply), per-held-row resolve buttons [data-confirm]=id /
// [data-dismiss]=id (native-[disabled] once terminal), and a polite live region
// data-testid="fp-resolve-note" (role=status). Session priming / navigation /
// GET+POST+status steps are shared with the rest of the suite (session-steps.ts);
// this file adds the findings-specific VIEW / FILTER / RESOLVE assertions.

import { Page, expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { pageRegistry, findingsState, responseState } from './_registry';
import { ensureAppOrigin } from './session-steps';

function pageOf(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  return page;
}

// ── SEED: file a real HELD finding through the test-seed fixture route ───────
// POST /bff/mod/findings/test-seed (TestSeedFindingController, mod-bff-api).
// Ships dark behind app.test-seed.enabled — a misconfigured e2e run gets a real
// 503 here (not a silently-empty queue), so this step FAILS LOUDLY rather than
// leaving the round-trip scenarios with no held finding to click. The caller
// MUST already be logged in (the real Casdoor round-trip, not a seeded
// localStorage session) so the HttpOnly bff_ cookie travels — federation-api's
// file() endpoint is self-only, so the seeded finding's content-owner is
// THIS caller (mod-domain-a), which is exactly who resolves it next.

Given('{string} has seeded a held finding', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await ensureAppOrigin(page);
  const result = await page.evaluate(async () => {
    const r = await fetch('/bff/mod/findings/test-seed', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    let parsed: unknown = null;
    try {
      parsed = await r.json();
    } catch {
      parsed = null;
    }
    return { status: r.status, body: parsed };
  });
  expect(
    result.status,
    `test-seed failed: expected 200, got ${result.status} (body=${JSON.stringify(result.body)}) — ` +
      'is APP_TEST_SEED_ENABLED=true on mod-bff-api, and is federation-api reachable?',
  ).toBe(200);
  const id = (result.body as { id?: number } | null)?.id;
  expect(id, 'test-seed response carried no finding id').toBeTruthy();
  findingsState.lastSeededFindingId = id!;
});

// ── DENY (real id): a plain user cannot resolve a REAL, seeded finding ───────
// victim-creates-first: reuses the id "Given ... has seeded a held finding"
// just produced — never a fabricated/hardcoded id — so the 403 is proven
// against a resource that genuinely exists, not explained away by a 404.

When('{string} attempts to resolve the seeded finding as actioned {string}',
  async ({ user }, username: string, actioned: string) => {
    const page = pageOf(user(username).username);
    await ensureAppOrigin(page);
    const id = findingsState.lastSeededFindingId;
    if (!id) {
      throw new Error('no seeded finding id — add a "... has seeded a held finding" step first');
    }
    const status = await page.evaluate(
      async ({ url }) => {
        const r = await fetch(url, { method: 'POST', credentials: 'include' });
        return r.status;
      },
      { url: `/bff/mod/findings/${id}/resolve?actioned=${actioned}` },
    );
    responseState.lastStatus = status;
  });

// ── VIEW: the queue table and its triage surface ─────────────────────────────

Then('{string} sees the finding queue table', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await expect(page.locator('[data-testid="fp-queue"]')).toBeVisible();
});

Then('{string} sees the finding-queue triage columns', async ({ user }, username: string) => {
  // The mod triages by these fields, so the header row must expose each one.
  // Asserting the specific column names (not merely "a table exists") is the
  // non-vacuous VIEW oracle — it fails against a blank page or a renamed schema.
  const page = pageOf(user(username).username);
  const table = page.locator('[data-testid="fp-queue"]');
  await expect(table).toBeVisible();
  for (const column of ['ID', 'Surface', 'Subject', 'Status', 'Created', 'Reviewer']) {
    await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  }
});

Then('{string} sees the finding status filter offering the held, actioned and dismissed dispositions',
  async ({ user }, username: string) => {
    // The filter is the closed federation status vocab: '' (all) | held | actioned
    // | dismissed. Pin the exact option value set so a drift (an added/removed
    // disposition) is caught — a specific DOM assertion, not "a select exists".
    const page = pageOf(user(username).username);
    const select = page.locator('[data-testid="fp-status"]');
    await expect(select).toBeVisible();
    const values = await select
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(values).toEqual(['', 'held', 'actioned', 'dismissed']);
  });

Then('{string} sees the empty finding-queue message when there are no findings',
  async ({ user }, username: string) => {
    // The *ngIf="findings().length === 0" branch renders a single explanatory row
    // instead of a headers-only table. A seeded (cookieless) session reads the
    // queue anonymously → [] → this row is deterministically shown.
    const page = pageOf(user(username).username);
    const empty = page.locator('[data-testid="fp-queue-empty"]');
    await expect(empty).toBeVisible();
    await expect(empty).toContainText('empty');
  });

// ── FILTER: narrowing the queue reloads it scoped ────────────────────────────
// applyStatusFilter() → bff.loadFindings(status) → GET /bff/mod/findings[?status].
// The OUTBOUND reload is the observable oracle: it is issued client-side
// regardless of the response, so the scope is provable without a populated queue.

async function captureFilterReload(page: Page, match: (u: URL) => boolean, act: () => Promise<unknown>): Promise<void> {
  const captured = page.waitForRequest(
    (r) => {
      if (r.method() !== 'GET') return false;
      const u = new URL(r.url());
      return u.pathname === '/bff/mod/findings' && match(u);
    },
    { timeout: 15_000 },
  );
  await act();
  findingsState.lastListUrl = (await captured).url();
}

When('{string} filters the findings queue by {string}', async ({ user }, username: string, status: string) => {
  const page = pageOf(user(username).username);
  await captureFilterReload(
    page,
    (u) => u.searchParams.get('status') === status,
    () => page.locator('[data-testid="fp-status"]').selectOption(status),
  );
});

When('{string} clears the findings filter back to all', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  // First narrow to a real disposition so clearing back to '' (all) is an
  // observable change event; then capture the unscoped reload it fires.
  await page.locator('[data-testid="fp-status"]').selectOption('held');
  await captureFilterReload(
    page,
    (u) => !u.searchParams.has('status'),
    () => page.locator('[data-testid="fp-status"]').selectOption(''),
  );
});

Then('the findings queue reload was scoped to the {string} disposition', async ({}, status: string) => {
  expect(findingsState.lastListUrl, 'expected a captured GET /bff/mod/findings — filter the queue first').toBeTruthy();
  const u = new URL(findingsState.lastListUrl!);
  expect(u.pathname).toBe('/bff/mod/findings');
  expect(u.searchParams.get('status')).toBe(status);
});

Then('the findings queue reload carried no disposition scope', async ({}) => {
  expect(findingsState.lastListUrl, 'expected a captured GET /bff/mod/findings — clear the filter first').toBeTruthy();
  const u = new URL(findingsState.lastListUrl!);
  expect(u.pathname).toBe('/bff/mod/findings');
  expect(u.searchParams.has('status')).toBe(false);
});

// ── RESOLVE: confirm / dismiss a held finding ────────────────────────────────
// confirm(id)/dismiss(id) → bff.resolveFinding(id, actioned) →
// POST /bff/mod/findings/{id}/resolve?actioned=<bool>. Only a HELD row's buttons
// are enabled ([disabled]="!isHeld(f)"); the "... has seeded a held finding" step
// (test-seed fixture) guarantees at least one enabled button exists to click.

async function resolveFirstHeld(page: Page, action: 'confirm' | 'dismiss'): Promise<void> {
  // Prefer the button for the finding THIS scenario itself seeded — a
  // domain-a queue that already carries older held rows (a re-run against a
  // persistent live stack) must not let the test click a coincidental OTHER
  // row and still appear to pass. Falls back to "first enabled" only when no
  // seed step ran in this scenario.
  const seededId = findingsState.lastSeededFindingId;
  const button = seededId
    ? page.locator(`button[data-${action}="${seededId}"]:not([disabled])`).first()
    : page.locator(`button[data-${action}]:not([disabled])`).first();
  await expect(
    button,
    seededId
      ? `expected the seeded finding #${seededId} to render an enabled ${action} button — is it still held?`
      : `expected at least one HELD finding with an enabled ${action} button — seed one first`,
  ).toBeVisible();
  const id = await button.getAttribute(`data-${action}`);
  expect(id, `the ${action} button must carry its finding id`).toBeTruthy();
  if (seededId) {
    expect(Number(id), 'resolved the SEEDED finding, not a coincidental other row').toBe(seededId);
  }
  const captured = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === `/bff/mod/findings/${id}/resolve`,
    { timeout: 15_000 },
  );
  const capturedResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/bff/mod/findings/${id}/resolve`,
    { timeout: 15_000 },
  );
  await button.click();
  findingsState.lastResolveUrl = (await captured).url();
  const response = await capturedResponse;
  findingsState.lastResolveBody = await response.json().catch(() => null);
}

When('{string} confirms the first held finding', async ({ user }, username: string) => {
  await resolveFirstHeld(pageOf(user(username).username), 'confirm');
});

When('{string} dismisses the first held finding', async ({ user }, username: string) => {
  await resolveFirstHeld(pageOf(user(username).username), 'dismiss');
});

Then('the resolve request marked that finding actioned', async ({}) => {
  expect(findingsState.lastResolveUrl, 'expected a captured POST .../resolve — confirm a finding first').toBeTruthy();
  const u = new URL(findingsState.lastResolveUrl!);
  expect(u.pathname).toMatch(/^\/bff\/mod\/findings\/\d+\/resolve$/);
  expect(u.searchParams.get('actioned')).toBe('true');
});

Then('the resolve request cleared that finding as dismissed', async ({}) => {
  expect(findingsState.lastResolveUrl, 'expected a captured POST .../resolve — dismiss a finding first').toBeTruthy();
  const u = new URL(findingsState.lastResolveUrl!);
  expect(u.pathname).toMatch(/^\/bff\/mod\/findings\/\d+\/resolve$/);
  expect(u.searchParams.get('actioned')).toBe('false');
});

// ── RESOLVE (state-change oracle): the finding ACTUALLY changed server-side ──
// Reads the resolve endpoint's own RESPONSE body ({finding:{status:...}}), not
// merely its 200 status — proves the write took effect, not just that the HTTP
// call succeeded.

Then('the resolved finding is actually marked {string}', async ({}, expectedStatus: string) => {
  const body = findingsState.lastResolveBody as { finding?: { id?: number; status?: string } } | null;
  expect(body, 'expected a captured resolve response body — confirm/dismiss a finding first').toBeTruthy();
  expect(body!.finding?.status, 'the resolve response finding.status must reflect the real write').toBe(expectedStatus);
  if (findingsState.lastSeededFindingId) {
    expect(body!.finding?.id, 'the resolved finding must be the one THIS scenario seeded')
      .toBe(findingsState.lastSeededFindingId);
  }
});

Then('{string} sees the resolve note containing {string}',
  async ({ user }, username: string, fragment: string) => {
    // The outcome is announced in a polite live region (role=status,
    // aria-live=polite). Asserting the verb fragment ("confirmed" / "dismissed")
    // pins WHICH resolution the mod was told happened.
    const page = pageOf(user(username).username);
    const note = page.locator('[data-testid="fp-resolve-note"]');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('role', 'status');
    await expect(note).toHaveAttribute('aria-live', 'polite');
    await expect(note).toContainText(fragment);
  });

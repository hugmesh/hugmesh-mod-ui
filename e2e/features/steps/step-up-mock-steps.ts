// Step definitions backing features/moderation/mfa-step-up-mocked.feature —
// the MFA step-up LOOP (hugmesh-mod-ui#1) driven against a MOCKED mod-bff.
//
// Everything the BFF would say is answered by page.route() in the exact wire
// shapes hugmesh-mod-bff-api documents on origin/main (a036b55):
//   refusal  403 + `X-Step-Up-Required: X-Mod-StepUp` + `{error:"… requires step-up re-authentication …"}`
//   bare     403 with no header and no phrase (the privileged/self/cross-tenant rule)
//   accepted 202 `{state:"pending-reconcile"}` (ban / domain-lock) or the block envelope
//   MFA      POST /bff/mfa/challenge → 200 `{mfaSatisfied:true}`, or 503 when DARK
// so the CLIENT half of the loop is proven on a default stack whose real gate
// ships dark. The steps here deliberately do NOT reuse the armed-stack
// vocabulary of mfa-step-up-writes.feature ("the MFA step-up gate is armed on
// this stack" / "sees the step-up challenge dialog"), which is a different lane.
//
// Dialog locators accept both the inline port's `mfa-stepup-*` testids and
// login-ui's federated `mfa-challenge-*` ones (see the feature's header).

import { Route, expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { pageRegistry } from './_registry';

type WriteKind = 'ban' | 'block' | 'domain-lock';

/** The three step-up-gated writes: the glob the mock answers on, and the
 *  accepted envelope the console renders as its success note. */
const WRITES: Record<WriteKind, { glob: string; accepted: { status: number; body: unknown } }> = {
  ban: { glob: '**/bff/mod/ban', accepted: { status: 202, body: { state: 'pending-reconcile' } } },
  block: {
    glob: '**/bff/mod/block',
    accepted: { status: 202, body: { external: 'stubbed', note: 'Recorded (mocked mod-bff). External result: stubbed.' } },
  },
  'domain-lock': {
    glob: '**/bff/mod/domain-lock/**',
    accepted: { status: 202, body: { state: 'pending-reconcile' } },
  },
};

/** Every write the console actually sent to a mocked endpoint, in order —
 *  the oracle for "sent exactly once" and "re-issued with the identical body".
 *  Keyed by write kind; cleared when a scenario installs its mock. */
const sent = new Map<WriteKind, Array<{ method: string; url: string; body: string | null }>>();

function pageOf(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  return page;
}

function kindOf(raw: string): WriteKind {
  if (raw === 'ban' || raw === 'block' || raw === 'domain-lock') return raw;
  throw new Error(`Unknown write kind "${raw}" — one of ban, block, domain-lock`);
}

const DIALOG = '[data-testid="mfa-stepup-dialog"], [data-testid="mfa-challenge-view"]';
const INTRO = '[data-testid="mfa-stepup-intro"], [data-testid="mfa-challenge-intro"]';
const DARK = '[data-testid="mfa-stepup-dark"], [data-testid="mfa-challenge-dark"]';
const CODE = '[data-testid="mfa-stepup-code"], [data-testid="mfa-challenge-code"]';
const SUBMIT = '[data-testid="mfa-stepup-submit"], [data-testid="mfa-challenge-submit"]';
const CANCEL = '[data-testid="mfa-stepup-cancel"], [data-testid="mfa-challenge-cancel"]';
const CLOSE = '[data-testid="mfa-stepup-close"]';
const FORM_ERROR: Record<WriteKind, string> = {
  ban: '[data-testid="mc-ban-error"]',
  block: '[data-testid="mc-block-error"]',
  'domain-lock': '[data-testid="mc-dl-error"]',
};

/** Install the write mock: the FIRST write is answered with `first`, every later
 *  one with the accepted envelope — which is exactly the sequence an armed
 *  ModStepUpGate produces around a successful challenge. */
async function mockWrite(
  username: string,
  kind: WriteKind,
  first: (route: Route) => Promise<void>,
): Promise<void> {
  const page = pageOf(username);
  sent.set(kind, []);
  await page.route(WRITES[kind].glob, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST' && req.method() !== 'DELETE') return route.fallback();
    const log = sent.get(kind)!;
    log.push({ method: req.method(), url: req.url(), body: req.postData() });
    if (log.length === 1) return first(route);
    const { status, body } = WRITES[kind].accepted;
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

// ── Mocks ──────────────────────────────────────────────────────────────────

Given('the mod-bff will refuse the next {string} write demanding a step-up',
  async ({}, raw: string) => {
    // Registered on the page of whoever seeded last — the scenario's single persona.
    const username = [...pageRegistry.keys()].pop();
    if (!username) throw new Error('No page registered — add a session step first.');
    const kind = kindOf(raw);
    await mockWrite(username, kind, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: { 'X-Step-Up-Required': 'X-Mod-StepUp' },
        // ModStepUpAccessDeniedHandler's body: {"error": "<verb> requires step-up
        // re-authentication (present X-Mod-StepUp)"} — the legacy-phrase leg.
        body: JSON.stringify({
          error: `${kind === 'ban' ? 'ban' : kind === 'block' ? 'block' : 'domain-lock'} requires step-up re-authentication (present X-Mod-StepUp)`,
        }),
      }),
    );
  });

Given('the mod-bff will refuse the next {string} write with a bare 403', async ({}, raw: string) => {
  const username = [...pageRegistry.keys()].pop();
  if (!username) throw new Error('No page registered — add a session step first.');
  // No signal header, no phrase: byte-for-byte the privileged-target refusal.
  await mockWrite(username, kindOf(raw), (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }),
  );
});

Given('the MFA challenge endpoint will accept any code', async ({}) => {
  const username = [...pageRegistry.keys()].pop();
  if (!username) throw new Error('No page registered — add a session step first.');
  await pageOf(username).route('**/bff/mfa/challenge', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ mfaSatisfied: true }) }),
  );
});

Given('the MFA surface answers dark', async ({}) => {
  const username = [...pageRegistry.keys()].pop();
  if (!username) throw new Error('No page registered — add a session step first.');
  // app.casdoor.mfa.enabled=false: every /bff/mfa/* answers 503 (MfaService.DARK_STATUS).
  await pageOf(username).route('**/bff/mfa/**', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'MFA is not enabled' }) }),
  );
});

// ── Driving the challenge ──────────────────────────────────────────────────

When('{string} confirms the step-up with the code {string}', async ({ user }, username: string, code: string) => {
  const page = pageOf(user(username).username);
  await page.locator(CODE).first().fill(code);
  await page.locator(SUBMIT).first().click();
});

When('{string} declines the step-up challenge', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await page.locator(CANCEL).first().click();
});

When('{string} closes the dark step-up notice', async ({ user }, username: string) => {
  // The inline port renders a Close control in its DARK state; login-ui's
  // federated dialog renders none (it emits `unavailable` and the consumer
  // unmounts it) — so close when there is something to close.
  const page = pageOf(user(username).username);
  const close = page.locator(CLOSE);
  if ((await close.count()) > 0) await close.first().click();
});

// ── Assertions ─────────────────────────────────────────────────────────────

Then('{string} is offered the MFA step-up challenge', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await expect(page.locator(DIALOG).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(INTRO).first()).toBeVisible();
  // A LIVE challenge, not the dark "not enabled" shell.
  await expect(page.locator(DARK)).toHaveCount(0);
});

Then('{string} is not offered any MFA step-up challenge', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  // The refusal has already rendered (the caller asserted the alert), so a
  // zero count here is a settled negative, not a not-yet.
  await expect(page.locator(DIALOG)).toHaveCount(0);
});

Then('{string} sees the step-up challenge report that MFA is not enabled here', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await expect(page.locator(DARK).first()).toBeVisible({ timeout: 15_000 });
});

Then('no ban accepted note is shown to {string}', async ({ user }, username: string) => {
  const page = pageOf(user(username).username);
  await expect(page.locator('[data-testid="mc-ban-note"]')).toHaveCount(0);
});

Then('the {string} write has been sent exactly once so far', async ({}, raw: string) => {
  const log = sent.get(kindOf(raw)) ?? [];
  expect(log, `expected exactly one ${raw} write, saw ${JSON.stringify(log)}`).toHaveLength(1);
});

Then('the {string} write was re-issued exactly once with the identical body', async ({}, raw: string) => {
  const kind = kindOf(raw);
  // The retry is issued after the challenge resolves; poll the log rather than
  // read it once, so the assertion is on the settled count.
  await expect.poll(() => (sent.get(kind) ?? []).length, { timeout: 15_000 }).toBe(2);
  const [first, second] = sent.get(kind)!;
  expect(second.method).toBe(first.method);
  expect(second.url).toBe(first.url);
  // The SNAPSHOT contract: the retry carries the request the moderator confirmed,
  // never a re-read of the live form.
  expect(second.body).toBe(first.body);
});

Then('{string} sees the {string} form report that nothing was changed', async ({ user }, username: string, raw: string) => {
  const page = pageOf(user(username).username);
  const err = page.locator(FORM_ERROR[kindOf(raw)]);
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toContainText(/was NOT performed/);
  await expect(err).toContainText(/Nothing was changed/);
});

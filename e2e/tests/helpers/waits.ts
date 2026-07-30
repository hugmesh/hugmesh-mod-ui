import { Page, expect } from '@playwright/test';

/**
 * Cross-user wait helpers — the repo's expect.poll idiom for "X appears in
 * <ctx>'s surface within Ns". Every mod-bff write is an HONEST async 202
 * (pending-reconcile: the single-writer reconcile loop applies the Casdoor /
 * homeserver effect later), so a target-side observation can NEVER be a bare
 * waitForTimeout — it must poll the real oracle (the target's own authenticated
 * BFF responses / the reloaded moderation queue) until the effect lands or the
 * budget honestly expires.
 */

/** The Matrix CS-API identity probe, via the same-origin user-bff hsproxy that
 *  enforces ROLE_MATRIX server-side. 200 = the target HAS matrix access; a ban
 *  that reconciled flips it to 401/403 (fail-closed). */
export const MATRIX_WHOAMI_PATH = '/bff/user/matrix/_matrix/client/v3/account/whoami';

/** Fetch a same-origin BFF path from INSIDE the persona's page (credentials:
 *  'include' so the HttpOnly `bff_` session cookie travels) and return the
 *  status. Pages parked on about:blank are first moved to the app origin so the
 *  relative fetch resolves. */
export async function bffStatus(page: Page, path: string): Promise<number> {
  if (!page.url().startsWith('http')) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
  return page.evaluate(async (p) => {
    const r = await fetch(p, { credentials: 'include' });
    return r.status;
  }, path);
}

/** Poll a same-origin BFF path in the persona's context until its status is one
 *  of `accept` (e.g. [200] = access restored, [401,403] = access revoked). */
export async function pollBffStatus(
  page: Page,
  path: string,
  accept: number[],
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(async () => bffStatus(page, path).then((s) => accept.includes(s)), {
      timeout: timeoutMs,
      message: `expected ${path} to return one of [${accept.join(', ')}] within ${timeoutMs}ms`,
    })
    .toBe(true);
}

/**
 * Poll the target persona's OWN server session (`GET /bff/session`, the login
 * remote's hydrate endpoint: the server-truth {roles[]} for the HttpOnly `bff_`
 * cookie) until the given lowercase marker role (e.g. 'mastodon_domainlocked')
 * is present/absent. This is the honest target-side oracle for a mod's
 * domain-lock/unlock write: the marker only appears once the reconcile loop
 * really applied it to the TARGET's identity — never seeded by the test.
 */
export async function pollSessionMarker(
  page: Page,
  marker: string,
  present: boolean,
  timeoutMs: number,
): Promise<void> {
  if (!page.url().startsWith('http')) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
  }
  await expect
    .poll(
      async () =>
        page.evaluate(async (m) => {
          const r = await fetch('/bff/session', {
            credentials: 'include',
            headers: { accept: 'application/json' },
          });
          // A non-OK session read proves nothing — report "marker unknown" so the
          // poll keeps trying and honestly times out instead of passing vacuously.
          if (!r.ok) return 'session-unreadable';
          const data = (await r.json()) as { roles?: string[] };
          return (data.roles ?? []).includes(m) ? 'present' : 'absent';
        }, marker),
      {
        timeout: timeoutMs,
        message: `expected the '${marker}' session marker to be ${present ? 'present' : 'absent'} within ${timeoutMs}ms`,
      },
    )
    .toBe(present ? 'present' : 'absent');
}

/** Locator for the moderation-queue row whose Target cell is EXACTLY `target`
 *  (optionally narrowed to an exact Status cell too). */
export function queueRowFor(page: Page, target: string, status?: string) {
  let row = page
    .locator('[data-testid="mc-queue"] tbody tr')
    .filter({ has: page.getByRole('cell', { name: target, exact: true }) });
  if (status) {
    row = row.filter({ has: page.getByRole('cell', { name: status, exact: true }) });
  }
  return row;
}

/**
 * Poll until the moderation queue in `page`'s console shows a row for `target`
 * (optionally with an exact `status`). Each attempt RELOADS the queue via the
 * real Apply control (the console is poll-on-action by design — there is no
 * mod-facing SSE), so a row written by ANOTHER persona/context is picked up.
 */
export async function pollQueueRow(
  page: Page,
  target: string,
  timeoutMs: number,
  status?: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        // Re-apply the current status filter — applyStatusFilter() re-fetches
        // GET /bff/mod/moderation, so cross-context writes become visible.
        await page.locator('[data-testid="mc-status-apply"]').click();
        return queueRowFor(page, target, status).count();
      },
      {
        timeout: timeoutMs,
        message: `expected a queue row for "${target}"${status ? ` with status "${status}"` : ''} within ${timeoutMs}ms`,
      },
    )
    .toBeGreaterThan(0);
}

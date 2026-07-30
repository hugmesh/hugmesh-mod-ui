// Shared per-scenario state. playwright-bdd recreates the test instance for
// each scenario so we reset these maps in the After() hook in
// features/support/fixtures.ts. Keys are usernames so steps can reference a user
// by name without threading a token/page through.

import { BrowserContext, Page } from '@playwright/test';

export const pageRegistry = new Map<string, Page>();
export const ctxRegistry = new Map<string, BrowserContext>();

/** Last HTTP status code + parsed JSON body captured by an API-style step (the
 *  cross-user DENY assertions read the status; the honest-envelope assertions
 *  read the body — 202 pending-reconcile / stubbed-never-ok). Module-global
 *  instead of test-info attached so the assertion step doesn't need to thread
 *  the World through. Cleared on scenario teardown. */
export const responseState = { lastStatus: 0, lastBody: null as unknown };

/** The parsed JSON body of the last /bff/mod/ban request the CONSOLE ITSELF
 *  submitted (captured via page.waitForRequest around the real submit click).
 *  This is the observable oracle that distinguishes the timed-vs-permanent ban
 *  semantics: a TTL'd submit carries `ttlSeconds: n`, the permanent variant
 *  omits the key entirely (the component drops a blank field to undefined).
 *  Cleared on scenario teardown. */
export const banRequestState = { lastBody: null as Record<string, unknown> | null };

/** Per-scenario UNIQUE oracle the cross-user chains create and then look for.
 *  A scenario that needs to prove "the OTHER persona sees what I created" first
 *  generates a unique target (never a fabricated id used as a DENY oracle),
 *  records it here, and the observing persona's step asserts THAT exact row
 *  appears. `auditActor` is the Actor cell text captured from the acting mod's
 *  own audit view, re-asserted from a SECOND same-tenant mod's view to prove the
 *  audit trail is a shared server record (not a per-browser echo). Cleared on
 *  scenario teardown. */
export const scenarioState = { uniqueTarget: '', auditActor: '' };

/** The URL of the last GET /bff/mod/moderation the queue's status filter fired,
 *  captured via page.waitForRequest around the real Apply/select interaction —
 *  the observable oracle that applyStatusFilter() reloaded the queue scoped to
 *  the chosen status (the parity of the findings filter's captured-GET oracle,
 *  which the queue filter previously lacked). Cleared on scenario teardown. */
export const moderationState = { lastListUrl: null as string | null, lastAuditUrl: null as string | null };

/** The URL of the last findings-panel request the panel ITSELF issued, captured
 *  via page.waitForRequest around a real UI interaction. `lastListUrl` is the
 *  GET /bff/mod/findings the disposition filter fires (its `status` query param
 *  is the observable oracle that applyStatusFilter() reloaded the right scope);
 *  `lastResolveUrl` is the POST /bff/mod/findings/{id}/resolve a Confirm/Dismiss
 *  button fires (its `actioned` query param proves which disposition was written).
 *  `lastResolveBody` is that SAME request's parsed JSON RESPONSE — the state-change
 *  oracle: `{finding:{status:...}}` proves the resolve actually took effect
 *  server-side, not merely that the POST returned 200. `lastSeededFindingId` is
 *  the REAL id POST /bff/mod/findings/test-seed returned — the victim-creates-first
 *  fixture every DENY-with-a-real-id scenario reuses instead of a fabricated id.
 *  Cleared on scenario teardown. */
export const findingsState = {
  lastListUrl: null as string | null,
  lastResolveUrl: null as string | null,
  lastResolveBody: null as unknown,
  lastSeededFindingId: null as number | null,
};

export function resetRegistry(): void {
  pageRegistry.clear();
  ctxRegistry.clear();
  responseState.lastStatus = 0;
  responseState.lastBody = null;
  banRequestState.lastBody = null;
  scenarioState.uniqueTarget = '';
  scenarioState.auditActor = '';
  moderationState.lastListUrl = null;
  moderationState.lastAuditUrl = null;
  findingsState.lastListUrl = null;
  findingsState.lastResolveUrl = null;
  findingsState.lastResolveBody = null;
  findingsState.lastSeededFindingId = null;
}

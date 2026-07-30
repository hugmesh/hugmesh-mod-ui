# SYSTEM-FINDINGS TRIAGE coverage — the VIEW + FILTER + RESOLVE functions of the
# automated edge-AI finding queue (/mod/findings, FindingsPanelComponent). The
# companion file findings-panel.feature already covers the ROUTE/ROLE GATE (who
# may reach the panel + who may READ the queue); THIS file covers what a mod
# actually DOES once inside it: read the triage columns, narrow the queue by
# disposition, and resolve (confirm/dismiss) a held finding.
#
# Verified against source before writing this file:
#   - findings-panel.component.html: the queue table data-testid="fp-queue" with
#     column headers ID/Surface/Subject/Status/Created/Reviewer; a disposition
#     filter <select data-testid="fp-status"> (closed vocab: '' | held | actioned |
#     dismissed) with an Apply submit (data-testid="fp-status-apply"); per-held-row
#     resolve buttons [data-confirm]=id (actioned=true) and [data-dismiss]=id
#     (actioned=false), both native-[disabled] once the row is no longer held; and
#     a polite live region data-testid="fp-resolve-note" (role=status).
#   - findings-panel.component.ts: applyStatusFilter() → bff.loadFindings(status);
#     confirm(id)/dismiss(id) → bff.resolveFinding(id, actioned) then a queue
#     refresh; the confirm note contains "confirmed", the dismiss note "dismissed".
#   - api/fn/moderator/list-findings.ts: GET /bff/mod/findings, query `status`.
#   - api/fn/moderator/resolve-finding.ts: POST /bff/mod/findings/{id}/resolve,
#     query `actioned` (boolean → "true"/"false"). rootUrl '' → same-origin.
#   - mod-bff-api SecurityConfig.commonRoutes: the WHOLE /bff/mod/** path is gated
#     at the FILTER-CHAIN level to hasAnyRole('MOD','ADMIN','SUPERADMIN'), so a
#     plain-user or anonymous POST to the resolve endpoint is rejected by the chain
#     itself BEFORE any {id} lookup runs — an id-independent, deterministic
#     role-gate oracle (no fabricated-resource DENY), exactly as the GET guard in
#     findings-panel.feature.
#
# OBSERVABLE ORACLES (non-vacuous — each fails against a blank page):
#   - VIEW: the exact column headers and the exact closed disposition vocab of the
#     filter select (a specific DOM assertion, not "an element exists").
#   - FILTER: the OUTBOUND reload the select fires — a captured
#     GET /bff/mod/findings?status=<disposition> (or unscoped when cleared). The
#     request is issued client-side regardless of the response, so it is observed
#     without a populated queue; it simply proves applyStatusFilter() reloaded the
#     right scope.
#   - RESOLVE (API gate): the deterministic 403/401 the filter chain returns to a
#     plain user / anonymous caller POSTing the resolve endpoint.
#   - RESOLVE (round-trip): the captured POST .../resolve?actioned=<bool> the
#     Confirm/Dismiss button fires, plus the polite fp-resolve-note that announces
#     the outcome.
#
# SEED: the round-trip (Confirm / Dismiss) and the real-id DENY pair below all
# start with `"mod-domain-a" has seeded a held finding` — POST
# /bff/mod/findings/test-seed (mod-bff-api TestSeedFindingController), which
# calls federation-api's PRODUCTION POST /api/federation/findings (the SAME
# SystemFindingService write user-bff's pre-publish avatar-vision check would
# use) through the caller's own forwarded bearer. federation-api's file() is
# self-only, so the seeded finding's content-owner is mod-domain-a themselves —
# no cross-user write capability, no parallel/hand-written insert. Ships DARK
# behind app.test-seed.enabled: a misconfigured e2e run gets a real 503 from the
# seed step itself (asserted, not swallowed) rather than a silently-empty queue.
# VICTIM-CREATES-FIRST: every scenario below resolves/attempts-to-resolve the
# id THAT SEED CALL returned — never a fabricated id — so the round-trip proves
# a REAL row changed state, and the DENY proves rejection of a resource that
# genuinely exists.
#
# RESOLVED (was a disclosed known gap at the time this file was written):
# hugmesh-generator's tests/stack/compose.local.yaml now sets
# APP_TEST_SEED_ENABLED=true for hugmesh-mod-bff-api (generator#231,
# merged 2026-07-03), so the seed step below reaches a real 200 on a fresh
# `make stack-up`, not the 503 this comment originally disclosed. This PR's
# own validation of these three scenarios was still OFFLINE ONLY (bddgen
# discovery + compile-proof, per the file footer below); a live round-trip run
# against the now-wired stack is a good follow-up check, not yet reconfirmed
# here.
#
# @cluster — the mod-ui is a native-federation REMOTE; the host shell must serve
# it for /mod/findings to resolve, so (like every feature in this suite) the file
# ships dark: config filters `not @cluster`, and a no-filter `bddgen` +
# `playwright test --list` proves it compiles + discovers offline.
@cluster @mod-ui @user-situational
Feature: System-findings triage — view the queue, filter by disposition, resolve a held finding
  As a moderator working the automated edge-AI finding queue
  I want to read, narrow, and resolve findings
  So a held finding is confirmed (actioned) or dismissed (cleared) with an accessible outcome

  # ── VIEW: the triage surface a moderator reads ─────────────────────────────
  Scenario: the findings panel shows the triage columns a moderator reads
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    Then "mod-domain-a" sees the "findings-panel-view" view
    And "mod-domain-a" sees the finding-queue triage columns

  Scenario: the disposition filter offers exactly the closed finding-status vocabulary
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    Then "mod-domain-a" sees the finding status filter offering the held, actioned and dismissed dispositions

  Scenario: an empty finding queue announces itself rather than showing a blank table
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    Then "mod-domain-a" sees the empty finding-queue message when there are no findings

  # ── FILTER: narrowing the queue reloads it scoped ──────────────────────────
  # The observable oracle is the reload the select fires, captured as an outbound
  # GET — proving applyStatusFilter() re-queried the chosen disposition.
  Scenario: filtering to held reloads the queue scoped to held findings
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    And "mod-domain-a" filters the findings queue by "held"
    Then the findings queue reload was scoped to the "held" disposition

  Scenario: filtering to actioned reloads the queue scoped to actioned findings
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    And "mod-domain-a" filters the findings queue by "actioned"
    Then the findings queue reload was scoped to the "actioned" disposition

  Scenario: clearing the filter back to all reloads the whole queue unscoped
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    And "mod-domain-a" clears the findings filter back to all
    Then the findings queue reload carried no disposition scope

  # ── RESOLVE (API gate, id-independent): the resolve endpoint's role boundary
  # These pin the resolve endpoint's authorization deterministically with NO
  # fabricated-id ALLOW: the filter chain decides the code by the caller's role,
  # before the {id} lookup, so the id in the path is irrelevant to the outcome
  # (documented, id-agnostic exception to the fabricated-id rule — see
  # findings-panel.feature's matching GET trio).
  Scenario: the mod-bff rejects a plain user from resolving a finding (403, role gate)
    Given "plain-user" is logged in
    When "plain-user" POSTs "/bff/mod/findings/1/resolve?actioned=true" with body "{}"
    Then the response status is 403

  Scenario: an unauthenticated client cannot resolve a finding (401)
    Given a clean session
    When the unauthenticated client POSTs "/bff/mod/findings/1/resolve?actioned=true"
    Then the response status is 401

  # ── RESOLVE (round-trip, victim-creates-first): confirm / dismiss a REAL
  #    held finding, seeded through the test-seed fixture (see the file header).
  #    Each scenario asserts THREE distinct oracles: the outbound POST's query
  #    param (which disposition was requested), the resolve RESPONSE body
  #    (the finding's status actually changed server-side — not just a 200),
  #    and the accessible note the mod is shown.
  Scenario: a moderator confirms a held finding (actioned=true) and is told so
    Given "mod-domain-a" is logged in
    And "mod-domain-a" has seeded a held finding
    When "mod-domain-a" navigates to "/mod/findings"
    And "mod-domain-a" confirms the first held finding
    Then the resolve request marked that finding actioned
    And the resolved finding is actually marked "actioned"
    And "mod-domain-a" sees the resolve note containing "confirmed"

  Scenario: a moderator dismisses a held finding (actioned=false) and is told so
    Given "mod-domain-a" is logged in
    And "mod-domain-a" has seeded a held finding
    When "mod-domain-a" navigates to "/mod/findings"
    And "mod-domain-a" dismisses the first held finding
    Then the resolve request cleared that finding as dismissed
    And the resolved finding is actually marked "dismissed"
    And "mod-domain-a" sees the resolve note containing "dismissed"

  # ── RESOLVE (API gate, victim-creates-first): DENY against a REAL finding ──
  # The ALLOW half of this pair is the confirm/dismiss scenarios above (the
  # SAME test-seed fixture mechanism); here a DIFFERENT, unprivileged actor
  # (plain-user) attempts to resolve a finding that GENUINELY EXISTS — not a
  # fabricated id that could vacuously 403/404 regardless of whether the
  # resource is real.
  Scenario: the mod-bff rejects a plain user from resolving a REAL seeded finding (403)
    Given "mod-domain-a" is logged in in their own context
    And "mod-domain-a" has seeded a held finding
    And "plain-user" is logged in in their own context
    When "plain-user" attempts to resolve the seeded finding as actioned "true"
    Then the response status is 403

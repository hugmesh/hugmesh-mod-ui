# SYSTEM-FINDINGS PANEL coverage — the automated edge-AI avatar/image
# moderation queue (/mod/findings, FindingsPanelComponent), the companion
# AUTOMATED queue to the human moderation console covered by mod-surfaces.feature.
#
# Verified against source before writing this file:
#   - mod-ui: mod.routes.ts mounts FindingsPanelComponent at 'findings' (host
#     mounts the remote at /mod, so /mod/findings); the view carries
#     data-testid="findings-panel-view" and the queue table
#     data-testid="fp-queue" (findings-panel.component.html).
#   - mod-bff-api ModController: GET /bff/mod/findings and
#     POST /bff/mod/findings/{id}/resolve are both
#     @PreAuthorize("hasAnyRole('MOD','ADMIN')").
#   - mod-bff-api SecurityConfig.commonRoutes: the WHOLE /bff/mod/** path is
#     additionally gated at the FILTER-CHAIN level to
#     hasAnyRole('MOD','ADMIN','SUPERADMIN') — a caller without any of those
#     roles is rejected by the chain itself, before any method body or id/domain
#     lookup ever runs. That makes a plain-user GET /bff/mod/findings a clean,
#     ownership-independent ROLE-GATE oracle (deterministic 403), unlike the
#     privileged-target DENYs in mod-isolation.feature (which need a REAL victim
#     id because THAT check happens inside the service after authorization).
#
# HONEST SCOPE: filing a system finding (POST /api/federation/findings on
# federation-api) is reachable only from an AUTHENTICATED caller acting about
# THEIR OWN content, and the only PRODUCTION writer is user-bff's pre-publish
# avatar vision check — a non-deterministic edge-AI classification — because
# federation-api's /api/federation/findings is not proxied to the browser by
# the gateway. mod-bff-api's POST /bff/mod/findings/test-seed (added alongside
# this file) closes that gap for e2e purposes: a TEST/SEED-ONLY route, ships
# dark behind app.test-seed.enabled, that drives the SAME federation-api write
# path a MOD/ADMIN caller already reaches. This file still covers exactly the
# route/role guard (UI + API layers) — the list read and, for the
# queue-affecting POST, nothing asserted against a fabricated id (the banned
# fabricated-id DENY oracle: these three fire the SAME GET/POST regardless of
# id because the filter chain decides before any lookup). The REAL,
# victim-creates-first Confirm/Dismiss round-trip (seed → resolve → re-read the
# state change) lives in the companion findings-triage.feature.
#
# @cluster — ships dark; config filters `not @cluster` so no live stack is
# needed. Compiles + discovers offline (a no-filter bddgen + `playwright test
# --list` proves it).
@cluster @mod-ui @user-situational
Feature: System-findings panel — mod/admin ALLOW, plain-user and anonymous DENY
  As the mod-ui shell
  I must let a moderator or admin triage the automated edge-AI finding queue
  So the same MOD/ADMIN-only boundary the console enforces also covers findings

  # ── UI-layer guard (mirrors mod-surfaces.feature's ALLOW/DENY floor) ───────
  Scenario: a moderator reaches the findings panel (ALLOW)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/findings"
    Then "mod-domain-a" sees the "findings-panel-view" view
    And "mod-domain-a" sees the finding queue table

  Scenario: an admin is also admitted to the findings panel (ALLOW — mod OR admin)
    Given "admin-domain-a" has a seeded session
    When "admin-domain-a" navigates to "/mod/findings"
    Then "admin-domain-a" sees the "findings-panel-view" view
    And "admin-domain-a" sees the finding queue table

  Scenario: a plain user is bounced from the findings panel (DENY floor)
    Given "plain-user" has a seeded session
    When "plain-user" navigates to "/mod/findings"
    Then "plain-user" is redirected to the login page

  Scenario: a signed-out visitor is bounced from the findings panel (anonymous floor)
    Given a signed-out visitor
    When the signed-out visitor navigates to "/mod/findings"
    Then the signed-out visitor is redirected to the login page

  Scenario: each tenant mod reaches only their own findings panel (parallel ALLOW)
    Given "mod-domain-a" has a seeded session in their own context
    And "mod-domain-b" has a seeded session in their own context
    When "mod-domain-a" navigates to "/mod/findings"
    And "mod-domain-b" navigates to "/mod/findings"
    Then "mod-domain-a" sees the "findings-panel-view" view
    And "mod-domain-b" sees the "findings-panel-view" view

  # ── API-layer guard backing the UI (fail-closed at the mod-bff) ────────────
  # These three form the ALLOW+DENY pair the wave requires for a privileged
  # feature: a real mod is admitted, a real plain-user session (no mod/admin
  # role) is rejected by the SAME filter-chain rule, and an anonymous caller is
  # rejected earlier still. All three fire the SAME GET — no id, no lookup, no
  # fabricated-resource oracle: the response code is decided entirely by the
  # caller's role.
  Scenario: the mod-bff admits a moderator to the findings queue (ALLOW)
    Given "mod-domain-a" is logged in
    When "mod-domain-a" GETs "/bff/mod/findings"
    Then the response status is 200

  Scenario: the mod-bff rejects a plain user from the findings queue (403, role gate)
    Given "plain-user" is logged in
    When "plain-user" GETs "/bff/mod/findings"
    Then the response status is 403

  Scenario: an unauthenticated client cannot read the findings queue (401)
    Given a clean session
    When the unauthenticated client GETs "/bff/mod/findings"
    Then the response status is 401

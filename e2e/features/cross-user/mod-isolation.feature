# CROSS-USER ISOLATION coverage — the moderation threat model. A mod is NOT a
# superset of admin and is tenant-scoped, so the server (and the UI mirroring it)
# must DENY a mod acting on:
#   - a PRIVILEGED target (an admin or another moderator),
#   - SELF,
#   - a CROSS-TENANT user/instance (a domain-A mod on a domain-B target).
#
# The display-layer rejection (the role=alert "refused — HTTP 403" / "not applied
# — HTTP 404" announcement, which names the privileged/self-target rule as the
# likely cause only when the API gave no reason of its own — and which the UI
# steps below match across BOTH statuses, because the API-layer scenarios in this
# same file assert "403 or 404") is backed by an API-layer DENY: the
# mod-bff re-enforces the privileged/self/tenant guard and returns 403/404
# (fail-closed) even if the UI were bypassed. Two identities coexist in one
# scenario (each in its own context) so the isolation is asserted with both users
# live, not by swapping a single session.
#
# @cluster — ships dark; config filters `not @cluster` so no live stack is
# needed. Compiles + discovers offline.
@cluster @mod-ui @cross-user
Feature: Moderation isolation — a mod cannot act on privileged, self, or cross-tenant targets
  As the moderation platform
  I must stop a moderator acting on an admin, another mod, themselves, or another tenant
  So a moderator role can never be escalated into admin-equivalent or cross-brand power

  # ── Mod-over-privileged DENY (UI-announced rejection) ──────────────────────
  Scenario: a moderator banning another moderator is rejected with an accessible alert
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "mod-target" on "matrix"
    Then "mod-domain-a" sees the ban rejected alert

  Scenario: a moderator banning an admin is rejected with an accessible alert
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "admin-domain-a" on "profile"
    Then "mod-domain-a" sees the ban rejected alert

  Scenario: a moderator domain-locking themselves is rejected with an accessible alert
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" domain-locks "mod-domain-a"
    Then "mod-domain-a" sees the domain-lock rejected alert

  # ── API-layer DENY backing the UI (fail-closed at the mod-bff) ─────────────
  Scenario: the mod-bff rejects a ban against a privileged target (403)
    Given "mod-domain-a" has a seeded session in their own context
    And "mod-target" has a seeded session in their own context
    When "mod-domain-a" POSTs "/bff/mod/ban" with body "{\"platform\":\"matrix\",\"target\":\"mod-target\"}"
    Then the response status is one of 403 or 404

  Scenario: the mod-bff rejects a domain-lock against a self target (403)
    Given "mod-domain-a" has a seeded session in their own context
    When "mod-domain-a" POSTs "/bff/mod/domain-lock/ROLE_MATRIX_DOMAINLOCKED/mod-domain-a" with body "{}"
    Then the response status is one of 403 or 404

  # ── Cross-tenant DENY: a domain-A mod cannot act on a domain-B target ──────
  Scenario: a domain-A mod cannot ban a domain-B user via the mod-bff (403/404)
    Given "mod-domain-a" has a seeded session in their own context
    And "mod-domain-b" has a seeded session in their own context
    When "mod-domain-a" POSTs "/bff/mod/ban" with body "{\"platform\":\"matrix\",\"target\":\"@user:domain-b.example\"}"
    Then the response status is one of 403 or 404

  Scenario: each tenant mod reaches only their own console (parallel ALLOW)
    Given "mod-domain-a" has a seeded session in their own context
    And "mod-domain-b" has a seeded session in their own context
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-b" navigates to "/mod/console"
    Then "mod-domain-a" sees the "moderation-console-view" view
    And "mod-domain-b" sees the "moderation-console-view" view

  # ── Unauthenticated floor ───────────────────────────────────────────────────
  Scenario: an unauthenticated client is rejected by the mod-bff (401)
    Given a clean session
    When the unauthenticated client GETs "/bff/mod/moderation"
    Then the response status is 401

  Scenario: an unauthenticated client cannot read the mod audit trail (401)
    Given a clean session
    When the unauthenticated client GETs "/bff/mod/audit"
    Then the response status is 401

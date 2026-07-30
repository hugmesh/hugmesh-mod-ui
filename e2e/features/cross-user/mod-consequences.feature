# CROSS-USER CONSEQUENCE coverage — the other half of the moderation story the
# existing suite never closed: after a mod acts, the TARGET must actually
# OBSERVE the consequence in their own browser context, and an escalation must
# actually ARRIVE where it claims to go. The baseURL is the shared front door,
# so the target personas visit the /social/matrix and /social/mastodon remotes
# in their own contexts while the mod drives /mod/console in theirs.
#
# Honesty design:
#   - Every persona is primed by the REAL login flow in its own context ("is
#     logged in in their own context"): only the login round-trip mints the
#     HttpOnly bff_ cookie, and every oracle below is an authenticated /bff
#     request — a seeded localStorage session would fire them all as anonymous
#     401s and no scenario could ever pass.
#   - Every mod-bff write is an honest async 202 (pending-reconcile) — so every
#     target-side observation POLLS the target's own authenticated oracle (the
#     ROLE_MATRIX-gated hsproxy whoami / the GET /bff/session server-truth
#     roles / the reloaded moderation queue) with an explicit budget; never a
#     fixed sleep, never an assumed instant effect.
#   - Ban/lock scenarios open by RESETTING the target to the un-acted state
#     through the same real controls (lift / remove lock) and PROVING the
#     pre-state (access works / composer offers federated reach) so the later
#     gated state is a genuine transition — and so a retry run stays green.
#   - Queue chains create their row with a per-scenario UNIQUE target and the
#     observing persona asserts THAT exact row (no fabricated ids, no
#     pre-existing seed rows as oracles).
#
# @cluster — needs the live stack (host shell + mod-bff + user-bff hsproxy +
# Casdoor reconcile loop). Ships dark; compiles + discovers offline.
@cluster @mod-ui @cross-user
Feature: Moderation consequences — the target observes the mod's action

  As the moderation platform
  I must make every accepted mod action land on the target's real session
  So a 202 "pending reconcile" is an honest promise, not a dropped write

  Scenario: a matrix ban gates the target's Matrix access, and the lift restores it
    Given "mod-domain-a" is logged in in their own context
    And "plain-user" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    # Reset + prove the pre-state through the same real controls (idempotent on retry).
    And "mod-domain-a" lifts the ban for "plain-user" on "matrix"
    And "mod-domain-a" sees the ban note containing "Lift accepted"
    And "plain-user" regains Matrix access within 90 seconds
    And "plain-user" can use the Matrix surface in their own context
    When "mod-domain-a" bans "plain-user" on "matrix"
    Then "mod-domain-a" sees the ban note containing "Ban accepted"
    And "plain-user" loses Matrix access within 90 seconds
    And "plain-user" sees the Matrix identity gated in their own context
    When "mod-domain-a" lifts the ban for "plain-user" on "matrix"
    Then "mod-domain-a" sees the ban note containing "Lift accepted"
    And "plain-user" regains Matrix access within 90 seconds

  Scenario: a mastodon domain-lock coerces the target's composer local-only
    Given "mod-domain-a" is logged in in their own context
    And "plain-user" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    # Reset + prove the pre-state: no marker on the server session, federated reach offered.
    And "mod-domain-a" removes the domain-lock for "plain-user" on the "mastodon" platform
    And "mod-domain-a" sees the domain-lock note containing "Domain-unlock accepted"
    And "plain-user" observes the "mastodon_domainlocked" session marker cleared within 90 seconds
    And "plain-user" refreshes their session roles from the server
    And "plain-user" sees the composer offering federated reach in their own context
    When "mod-domain-a" domain-locks "plain-user" on the "mastodon" platform
    Then "mod-domain-a" sees the domain-lock accepted note
    And "plain-user" observes the "mastodon_domainlocked" session marker within 90 seconds
    When "plain-user" refreshes their session roles from the server
    Then "plain-user" sees the composer coerced to local-only in their own context

  Scenario: lifting the mastodon domain-lock re-enables the target's federated reach
    Given "mod-domain-a" is logged in in their own context
    And "plain-user" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    # Establish the locked state first (idempotent: the write dedupes if already locked).
    And "mod-domain-a" domain-locks "plain-user" on the "mastodon" platform
    And "mod-domain-a" sees the domain-lock accepted note
    And "plain-user" observes the "mastodon_domainlocked" session marker within 90 seconds
    When "mod-domain-a" removes the domain-lock for "plain-user" on the "mastodon" platform
    Then "mod-domain-a" sees the domain-lock note containing "Domain-unlock accepted"
    And "plain-user" observes the "mastodon_domainlocked" session marker cleared within 90 seconds
    When "plain-user" refreshes their session roles from the server
    Then "plain-user" sees the composer offering federated reach in their own context

  Scenario: a matrix domain-lock coerces the target local-only (the domain-lock form's default platform)
    # Mirrors the mastodon domain-lock consequence for ROLE_MATRIX_DOMAINLOCKED —
    # the domain-lock form's DEFAULT selection, previously proven only as an
    # accepted-note (never observed target-side). The honest target-side oracle is
    # the server-truth 'matrix_domainlocked' session marker (GET /bff/session
    # roles); the matrix surface's own local-only mirror is left to the matrix-ui
    # suite (its markup is owned there) so this asserts only what it can verify.
    Given "mod-domain-a" is logged in in their own context
    And "plain-user" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    # Reset + prove the pre-state: no marker on the server session (idempotent on retry).
    And "mod-domain-a" removes the domain-lock for "plain-user" on the "matrix" platform
    And "mod-domain-a" sees the domain-lock note containing "Domain-unlock accepted"
    And "plain-user" observes the "matrix_domainlocked" session marker cleared within 90 seconds
    When "mod-domain-a" domain-locks "plain-user" on the "matrix" platform
    Then "mod-domain-a" sees the domain-lock accepted note
    And "plain-user" observes the "matrix_domainlocked" session marker within 90 seconds
    When "mod-domain-a" removes the domain-lock for "plain-user" on the "matrix" platform
    Then "mod-domain-a" sees the domain-lock note containing "Domain-unlock accepted"
    And "plain-user" observes the "matrix_domainlocked" session marker cleared within 90 seconds

  Scenario: a timed matrix ban auto-restores the target's access on TTL expiry (no lift)
    # The TTL oracle in mod-over-user only proves the request body carried
    # ttlSeconds; THIS proves the product promise in the ban helptext — "a
    # positive value auto-restores access after that many seconds" — target-side:
    # the target loses Matrix access, then regains it WITHOUT any lift, purely on
    # the reconcile loop honouring the expiry.
    Given "mod-domain-a" is logged in in their own context
    And "plain-user" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    # Reset + prove the pre-state through the real lift control (idempotent on retry).
    And "mod-domain-a" lifts the ban for "plain-user" on "matrix"
    And "mod-domain-a" sees the ban note containing "Lift accepted"
    And "plain-user" regains Matrix access within 90 seconds
    When "mod-domain-a" bans "plain-user" on "matrix" with a TTL of "30" seconds
    Then "mod-domain-a" sees the ban note containing "Ban accepted"
    And the submitted ban carried a TTL of 30 seconds
    And "plain-user" loses Matrix access within 90 seconds
    Then "plain-user" regains Matrix access within 120 seconds

  Scenario: a mod's refer arrives in an admin's view of the queue (the escalation chain closes)
    # The admin decide-proxy has no LIST endpoint (admin-bff exposes only
    # /moderation/{id}/decide), so the admin's read of a referred item is the
    # mod console queue their admin role also unlocks — asserted here from the
    # admin's own context against the exact row the mod created and referred.
    Given "mod-domain-a" is logged in in their own context
    And "admin-domain-a" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" recommends "user-removal" of a unique target
    And "mod-domain-a" sees the recommend success note
    And "mod-domain-a" refers the queue row for the unique target
    Then "mod-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" navigates to "/mod/console"
    Then "admin-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds

  Scenario: a user's recommend-instance-block submission appears in the mod queue
    # The USER→MOD half of the escalation chain: the user files through the
    # user-bff endpoint the user-ui block form POSTs, and the mod sees exactly
    # that row (unique instance) in the federation moderation queue.
    Given "plain-user" has submitted an instance-block recommendation for a unique instance in their own context
    And "mod-domain-a" is logged in in their own context
    When "mod-domain-a" navigates to "/mod/console"
    Then "mod-domain-a" sees the queue row for the unique target within 30 seconds

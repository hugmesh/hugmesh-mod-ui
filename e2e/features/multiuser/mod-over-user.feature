# MULTIUSER-SITUATIONAL coverage — a moderator acting OVER A USER through the
# whole (deliberately narrow) toolkit, and the escalation chain the role is built
# around: a mod RECOMMENDS / REFERS up to an admin; a mod never decides directly.
#
# Each write hits the live mod-bff and returns the honest 202 "pending reconcile"
# envelope (ban/lock) or a queue row (recommend) — surfaced as a polite
# role=status note, never a synthetic synchronous success.
#
# @cluster — ships dark; config filters `not @cluster` so no live stack is
# needed. Compiles + discovers offline.
@cluster @mod-ui @multiuser
Feature: A moderator acts over a user — recommend, refer, ban, lock, block
  As a moderator
  I want to triage and act on a user through my narrow toolkit
  So abuse is handled while removal decisions still escalate to an admin

  Scenario: a moderator recommends a user-removal up to an admin (mod recommends, admin decides)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" recommends "user-removal" of "@spammer:domain-a.example"
    Then "mod-domain-a" sees the recommend success note

  Scenario: a moderator recommends an instance-block up to an admin
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" recommends "instance-block" of "evil.example"
    Then "mod-domain-a" sees the recommend success note

  Scenario: a moderator refers an existing queue request up to an admin (the only removal path)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" refers queue request "1" up to an admin
    Then "mod-domain-a" sees the moderation queue table

  Scenario: a moderator bans a plain user from matrix access (pending reconcile)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    Then "mod-domain-a" sees the ban accepted note

  # ── Ban variants: timed vs permanent, and the lift (the restore half) ──────
  # Both variants surface the same "Ban accepted" note, so each scenario also
  # pins the request the console ACTUALLY submitted (captured around the real
  # click): ttlSeconds present = timed, ttlSeconds omitted = permanent. These
  # write scenarios log in for real — the accepted note only renders on a 2xx
  # from the mod-bff, which needs the HttpOnly bff_ cookie only login mints.
  Scenario: a moderator issues a TIMED ban via the real TTL control (pending reconcile)
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix" with a TTL of "3600" seconds
    Then "mod-domain-a" sees the ban note containing "Ban accepted"
    And the submitted ban carried a TTL of 3600 seconds

  Scenario: a moderator issues a PERMANENT ban (TTL left blank) and then lifts it
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix" with the TTL left blank
    Then "mod-domain-a" sees the ban note containing "Ban accepted"
    And the submitted ban carried no TTL and is permanent
    When "mod-domain-a" lifts the ban for "plain-user" on "matrix"
    Then "mod-domain-a" sees the ban note containing "Lift accepted"

  Scenario: a moderator bans a plain user from mastodon access (mastodon-platform ALLOW)
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "mastodon" with a TTL of "60" seconds
    Then "mod-domain-a" sees the ban note containing "Ban accepted"
    And the submitted ban carried a TTL of 60 seconds

  # ── Profile-platform ban ALLOW: the one banPlatforms variant with no accepted
  #    envelope anywhere (the only profile scenario elsewhere is a mod-bans-admin
  #    DENY). Bans the plain user's profile/account role, honest 202 accepted note.
  Scenario: a moderator bans a plain user's profile role (profile-platform ALLOW)
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "profile" with a TTL of "60" seconds
    Then "mod-domain-a" sees the ban note containing "Ban accepted"
    And the submitted ban carried a TTL of 60 seconds
    When "mod-domain-a" lifts the ban for "plain-user" on "profile"
    Then "mod-domain-a" sees the ban note containing "Lift accepted"

  # ── An ADMIN also performs the mod writes (mod OR admin ALLOW, not view-only) ──
  Scenario: an admin performs a ban and a lift through the console (admin write ALLOW)
    Given "admin-domain-a" is logged in
    When "admin-domain-a" navigates to "/mod/console"
    And "admin-domain-a" bans "plain-user" on "matrix" with a TTL of "60" seconds
    Then "admin-domain-a" sees the ban note containing "Ban accepted"
    When "admin-domain-a" lifts the ban for "plain-user" on "matrix"
    Then "admin-domain-a" sees the ban note containing "Lift accepted"

  Scenario: a moderator forces a plain user local-only via domain-lock (pending reconcile)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" domain-locks "plain-user"
    Then "mod-domain-a" sees the domain-lock accepted note

  Scenario: a moderator applies a server-wide user block (locally audited)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" blocks "@spammer:evil.example" at "user" scope
    Then "mod-domain-a" sees the block recorded note

  Scenario: the queue row exposes refer (wired) but not decide (admin-only) for the same request
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    Then the per-row refer control for request "1" is enabled
    And the per-row decide control for request "1" is disabled

  # Strengthened from a near-vacuous "the table stays visible" check to the
  # captured scoped-GET oracle the findings filter already has: selecting the
  # filter must fire GET /bff/mod/moderation?status=self-silence-appeal (the
  # outbound reload is observable regardless of the response, so a seeded session
  # suffices — it proves applyStatusFilter() re-queried the chosen scope).
  Scenario: narrowing the queue to self-silence appeals reloads the queue scoped to that status
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" filters the queue by "self-silence-appeal" capturing the reload
    Then the moderation queue reload was scoped to the "self-silence-appeal" status

  # ── Audit-trail 'mine' filter: the BFF-supported GET /bff/mod/audit?mine option
  #    the console now exposes as a checkbox (previously generated-but-dead). Same
  #    captured scoped-GET oracle as the queue/findings filters — the outbound GET
  #    is observable regardless of the response, so a seeded session suffices to
  #    prove applyAuditFilter() re-queried the mine-scoped trail.
  Scenario: toggling "only my own actions" reloads the audit trail scoped to mine
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" filters the audit trail to only their own actions capturing the reload
    Then the audit trail reload was scoped to only my own actions

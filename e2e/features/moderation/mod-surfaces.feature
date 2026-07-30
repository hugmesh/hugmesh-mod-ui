# USER-SITUATIONAL coverage — the moderation console surfaces, ALLOW + DENY +
# disabled+helptext. The load-bearing rule of this remote: a MOD acts OVER USERS
# (refer / recommend / ban / domain-lock / block) but is NOT a superset of ADMIN
# — the DECIDE / role-grant / external-client controls have NO mod-bff endpoint,
# so they are rendered aria-disabled with a WHY-helptext, never wired.
#
# The mod-ui mounts behind modGuard (mod.routes.ts via the host at /mod):
#   modGuard — admits a Casdoor MOD *or* ADMIN role; everyone else → /login.
# A guard ALLOW renders the *-view; a DENY returns router.parseUrl('/login').
#
# @cluster — wave 2b ships DARK. These need the host shell serving the federated
# remote + a live session/mod-bff, so they're tagged @cluster and the config
# filters them out (`tags: 'not @cluster'`) so the default run requires no live
# stack. They still COMPILE + DISCOVER (a no-filter bddgen + `playwright test
# --list` proves it) — unlike playwright-bdd's reserved @skip, which drops a
# scenario from generation entirely.
@cluster @mod-ui @user-situational
Feature: Moderation console surfaces — mod-over-user ALLOW, admin-only DENY
  As the mod-ui shell
  I must let a moderator act over users but never decide or grant
  So the moderator's deliberately narrow toolkit cannot escalate into admin power

  Scenario: a moderator reaches the moderator home (ALLOW)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod"
    Then "mod-domain-a" sees the "mod-home-view" view

  Scenario: a moderator reaches the moderation console (ALLOW)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    Then "mod-domain-a" sees the "moderation-console-view" view
    And "mod-domain-a" sees the moderation queue table

  Scenario: an admin is also admitted to the console (ALLOW — mod OR admin)
    Given "admin-domain-a" has a seeded session
    When "admin-domain-a" navigates to "/mod/console"
    Then "admin-domain-a" sees the "moderation-console-view" view

  Scenario: a plain user is bounced from the moderation console (DENY floor)
    Given "plain-user" has a seeded session
    When "plain-user" navigates to "/mod/console"
    Then "plain-user" is redirected to the login page

  Scenario: a plain user is bounced from the moderator home (DENY floor)
    Given "plain-user" has a seeded session
    When "plain-user" navigates to "/mod"
    Then "plain-user" is redirected to the login page

  Scenario: a signed-out visitor is bounced from the moderation console (anonymous floor)
    # Below even the plain-user floor: no hug.session was EVER written in this
    # context, so the guard's null-session branch is what bounces the navigation.
    Given a signed-out visitor
    When the signed-out visitor navigates to "/mod/console"
    Then the signed-out visitor is redirected to the login page

  # ── Superadmin: fold-into-admin per the ACTUAL SessionService in src ────────
  # mod-ui has NO superadmin flag (isMod() = 'mod' OR 'admin'; mod-bff-api is
  # hasAnyRole('MOD','ADMIN') with no role hierarchy), so a superadmin session
  # reaches this remote exclusively through the folded 'admin' role it carries
  # (SUPERADMIN > ADMIN in the cascade). This scenario asserts both halves:
  # the console renders AND a real write is accepted. The write half needs the
  # HttpOnly bff_ cookie, so this persona logs in for real.
  Scenario: a superadmin reaches the console through the folded admin role and can act
    Given "superadmin" is logged in
    When "superadmin" navigates to "/mod/console"
    Then "superadmin" sees the "moderation-console-view" view
    When "superadmin" recommends "instance-block" of a unique target
    Then "superadmin" sees the recommend success note

  # ── The boundary a mod can never cross: admin-only controls, disabled+help ──
  Scenario: the role grant/revoke control is disabled with a why-helptext (no mod endpoint)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    Then "mod-domain-a" sees the "mc-role-grant-disabled" control disabled with help text "mc-role-grant-help"

  Scenario: the external-client grant control is disabled with a why-helptext (admin action)
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    Then "mod-domain-a" sees the "mc-external-client-disabled" control disabled with help text "mc-external-client-help"

  # ── Even an ADMIN cannot GRANT roles here: role-grant has no endpoint for anyone ──
  # (An admin DOES get a real approve/deny decide control in this remote — that is
  # covered end-to-end in cross-user/admin-decide.feature. What NO role can reach
  # is the role-grant / external-client boundary, asserted disabled+helptext here.)
  Scenario: an admin still cannot grant roles in the mod remote (role-grant has no endpoint)
    Given "admin-domain-a" has a seeded session
    When "admin-domain-a" navigates to "/mod/console"
    Then "admin-domain-a" sees the "mc-role-grant-disabled" control disabled with help text "mc-role-grant-help"

  # ── Required-field validation surfaces in a role=alert region ──────────────
  Scenario: banning with an empty target is rejected with an accessible validation alert
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" submits the ban form with an empty target
    Then "mod-domain-a" sees a required-target validation alert on the ban form

  # ── API honest-envelope: a desired-state write NEVER claims synchronous success ──
  # Ban/lift are applied by the reconcile loop (202 pending-reconcile always);
  # the /bff/mod/block Matrix leg is STUBBED BY DESIGN (tuwunel has no REST
  # admin API) and the Mastodon (pleroma-admin) leg on this stack is degraded /
  # stubbed — so every one of these asserts the honest 202/pending envelope and
  # would FAIL if the server ever fabricated an "OK". The POSTs ride the
  # HttpOnly bff_ cookie, which only the real login flow mints (a seeded
  # localStorage session would fire them anonymously and see 401, never the
  # envelope) — so these personas log in for real.
  Scenario: a matrix-platform ban returns the honest 202 pending-reconcile envelope
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" POSTs "/bff/mod/ban" with body "{\"platform\":\"matrix\",\"target\":\"plain-user\",\"ttlSeconds\":60}"
    Then the response is the honest 202 pending-reconcile envelope

  Scenario: a mastodon-platform ban returns the honest 202 pending-reconcile envelope
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" POSTs "/bff/mod/ban" with body "{\"platform\":\"mastodon\",\"target\":\"plain-user\",\"ttlSeconds\":60}"
    Then the response is the honest 202 pending-reconcile envelope

  Scenario: a matrix-platform server-wide block reports the stubbed leg, never success
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" POSTs "/bff/mod/block" with body "{\"platform\":\"matrix\",\"scope\":\"user\",\"target\":\"@spammer:evil.example\",\"reason\":\"e2e honest envelope\"}"
    Then the response reports the Matrix block leg as stubbed and pending

  Scenario: a mastodon-platform server-wide block reports pending, never a fake OK
    Given "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" POSTs "/bff/mod/block" with body "{\"platform\":\"mastodon\",\"scope\":\"instance\",\"target\":\"evil.example\",\"reason\":\"e2e honest envelope\"}"
    Then the response reports the Mastodon block leg as pending and never ok

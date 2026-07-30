# CROSS-USER ADMIN DECIDE coverage — the final leg of the escalation chain the
# existing suite left untested. mod-consequences.feature proves a mod's refer
# ARRIVES in an admin's view of the queue; THIS file proves the admin then
# DECIDES it here, in this remote, through the real approve/deny controls the
# console wires for an admin (moderation-console.component.html isAdmin() branch
# → data-approve / data-deny → AdminBffService.decide →
# POST /bff/admin/moderation/{id}/decide?approve=<bool>), and that a failed
# decide surfaces the honest mc-decide-error WITHOUT ever rendering the row as
# decided.
#
# Honesty design (same as the rest of the cross-user suite):
#   - The row is CREATED with a per-scenario UNIQUE target (mod recommends +
#     refers), so every observation asserts THAT exact row — never a fabricated
#     id or a pre-existing seed row used as an oracle.
#   - Every persona logs in for real in their OWN context (only login mints the
#     HttpOnly bff_ cookie the /bff/admin decide write rides).
#   - The decide-FAILURE scenario injects a transport 500 on the decide POST (a
#     legitimate failure injection) and asserts the component's real honest-error
#     branch: mc-decide-error shows AND the row is left at 'referred' (the code's
#     "a failed decide is NEVER rendered as applied" contract).
#   - Two-admin contention asserts the row settles to ONE server-authoritative
#     terminal status (approved|denied), never two contradictory terminal states.
#
# @cluster — needs the live stack (host shell + mod-bff + admin-bff +
# federation-api decide→apply chain + reconcile loop). Ships dark; compiles +
# discovers offline.
@cluster @mod-ui @cross-user
Feature: Admin decide round-trip — approve/deny a referred request through the mod console

  As the moderation platform
  I must let an admin approve or deny a referred request in this console and surface a failure honestly
  So the escalation chain closes here (not only in the admin console) and a failed decide never fakes a decision

  Scenario: an admin approves a referred request and both the admin and the referring mod see it approved
    Given "mod-domain-a" is logged in in their own context
    And "admin-domain-a" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" recommends "user-removal" of a unique target
    And "mod-domain-a" sees the recommend success note
    And "mod-domain-a" refers the queue row for the unique target
    Then "mod-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" navigates to "/mod/console"
    Then "admin-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" approves the queue row for the unique target
    Then "admin-domain-a" sees the queue row for the unique target with status "approved" within 30 seconds
    And "mod-domain-a" sees the queue row for the unique target with status "approved" within 30 seconds

  Scenario: an admin denies a referred request and both admin and mod see it denied
    Given "mod-domain-a" is logged in in their own context
    And "admin-domain-a" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" recommends "user-removal" of a unique target
    And "mod-domain-a" sees the recommend success note
    And "mod-domain-a" refers the queue row for the unique target
    Then "mod-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" navigates to "/mod/console"
    Then "admin-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" denies the queue row for the unique target
    Then "admin-domain-a" sees the queue row for the unique target with status "denied" within 30 seconds
    And "mod-domain-a" sees the queue row for the unique target with status "denied" within 30 seconds

  Scenario: a failed decide surfaces the honest mc-decide-error and leaves the row untouched
    Given "mod-domain-a" is logged in in their own context
    And "admin-domain-a" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" recommends "user-removal" of a unique target
    And "mod-domain-a" sees the recommend success note
    And "mod-domain-a" refers the queue row for the unique target
    Then "mod-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" navigates to "/mod/console"
    Then "admin-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" will have their next decide call fail with a server error
    And "admin-domain-a" approves the queue row for the unique target
    Then "admin-domain-a" sees the decide error
    And "admin-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds

  Scenario: two admins double-decide the same referred row — it settles to one terminal status
    # admin-domain-a and the superadmin (folded admin, same domain-a) both hold
    # the same referred row on screen in their own contexts; one approves, the
    # other (stale view) denies. Whatever the server's re-decision semantics, the
    # row must settle to exactly ONE approved|denied terminal status — never two
    # contradictory terminals, never a phantom second row.
    Given "mod-domain-a" is logged in in their own context
    And "admin-domain-a" is logged in in their own context
    And "superadmin" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" recommends "user-removal" of a unique target
    And "mod-domain-a" sees the recommend success note
    And "mod-domain-a" refers the queue row for the unique target
    Then "mod-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" navigates to "/mod/console"
    And "superadmin" navigates to "/mod/console"
    Then "admin-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    And "superadmin" sees the queue row for the unique target with status "referred" within 30 seconds
    When "admin-domain-a" approves the queue row for the unique target
    Then "admin-domain-a" sees the queue row for the unique target with status "approved" within 30 seconds
    When "superadmin" denies the queue row for the unique target
    Then "superadmin" sees the queue row for the unique target settle to a single terminal decided status within 30 seconds

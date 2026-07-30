# CROSS-USER FINDINGS CONTENTION coverage — two same-tenant moderators contend
# over one held finding (the classic mod-A/mod-B double-decide for the AUTOMATED
# queue). findings-triage.feature covers confirm/dismiss happy paths and the
# role-gate DENYs, but never the resolveNote FAILURE branch ("rejected by the
# server (it may already be resolved...)") nor two mods racing one held row.
#
# victim-creates-first: mod-domain-a seeds a REAL held finding (test-seed →
# federation-api, self-only). Both domain-a mods (mod-domain-a + mod-target, the
# findings queue is domain-scoped) open /mod/findings while it is still held.
# mod A confirms it (actioned); mod B, on the STALE view, dismisses the same id —
# the server rejects the second resolve of an already-terminal finding, the UI
# announces that honestly, and a reload shows mod A's actioned state won (the
# server record, not mod B's later click).
#
# @cluster — needs the live stack (host shell + mod-bff + federation-api +
# APP_TEST_SEED_ENABLED). Ships dark; compiles + discovers offline.
@cluster @mod-ui @cross-user
Feature: Findings double-resolve — a second moderator cannot re-resolve an already-resolved finding

  As the moderation platform
  I must reject a second resolve of an already-resolved finding and announce it honestly
  So two moderators racing one held finding converge on one server-authoritative outcome

  Scenario: mod A confirms a held finding; mod B's stale dismiss is rejected and A's outcome stands
    Given "mod-domain-a" is logged in in their own context
    And "mod-domain-a" has seeded a held finding
    And "mod-target" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/findings"
    And "mod-target" navigates to "/mod/findings"
    When "mod-domain-a" confirms the first held finding
    Then the resolve request marked that finding actioned
    And the resolved finding is actually marked "actioned"
    And "mod-domain-a" sees the resolve note containing "confirmed"
    When "mod-target" dismisses the first held finding
    Then "mod-target" sees the resolve note containing "rejected"
    And "mod-target" sees the seeded finding resolved as "actioned"

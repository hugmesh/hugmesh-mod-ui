# CROSS-USER REFER CONTENTION coverage — the disabled-once-referred state proven
# ACROSS two moderators, not just single-user against a seed row. The existing
# suite only asserts refer's [disabled]="r.status === 'referred'" against the
# seeded row 1 (enabled), never that AFTER mod A refers a row, mod B's reloaded
# queue renders that same row's refer control disabled.
#
# Both mods are SAME-tenant (domain-a): the federation moderation queue is
# domain-scoped, so a domain-B mod would not see the row at all — the honest
# "second moderator" here is mod-target (a domain-a mod). Each persona logs in
# for real in their own context (the queue write + reload ride the bff_ cookie).
# The row is created with a per-scenario UNIQUE target, so mod B asserts THAT
# exact row — never a fabricated id.
#
# @cluster — needs the live stack (host shell + mod-bff + federation-api). Ships
# dark; compiles + discovers offline.
@cluster @mod-ui @cross-user
Feature: Refer contention — after mod A refers, mod B sees that row's refer control disabled

  As the moderation platform
  I must reflect a refer to every moderator viewing the shared queue
  So a second moderator cannot double-refer a row that is already escalated

  Scenario: mod B's reloaded queue shows the row mod A referred as referred with refer disabled
    Given "mod-domain-a" is logged in in their own context
    And "mod-target" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" recommends "user-removal" of a unique target
    And "mod-domain-a" sees the recommend success note
    And "mod-domain-a" refers the queue row for the unique target
    Then "mod-domain-a" sees the queue row for the unique target with status "referred" within 30 seconds
    When "mod-target" navigates to "/mod/console"
    Then "mod-target" sees the queue row for the unique target with status "referred" within 30 seconds
    And "mod-target" sees the refer control disabled on the queue row for the unique target

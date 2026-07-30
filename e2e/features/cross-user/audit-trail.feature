# AUDIT-TRAIL CONTENT + CROSS-MOD VISIBILITY coverage — the "always locally
# audited" guarantee, asserted for real. The existing suite only checks an
# anonymous 401 on GET /bff/mod/audit; no scenario proves a mod action actually
# produces a VISIBLE audit row, nor that a second moderator sees the first's
# action in the shared trail.
#
# The mod-action audit trail is DOMAIN-scoped server-side (ModController.auditTrail
# uses the validated issuer-derived DOMAIN_<x> as a WHERE predicate), so the
# second observer is a SAME-tenant mod (mod-target, domain-a) — a domain-B mod
# would correctly NOT see it (that boundary is its own concern, covered by the
# findings/ban cross-tenant DENYs). Honesty:
#   - mod-domain-a blocks a per-scenario UNIQUE @spammer target (server-wide user
#     block, always locally audited) — the unique target is the strong row oracle.
#   - The acting mod asserts the audit row (Target = the unique value) and its
#     Actor cell is captured.
#   - mod-target (own context, real login, same tenant) reloads the console and
#     sees the SAME row with the SAME Actor — proving the trail is a shared server
#     record, not a per-browser echo (a per-browser echo would be empty, or show
#     mod-target as the actor).
#
# @cluster — needs the live stack (host shell + mod-bff + the mod_action store).
# Ships dark; compiles + discovers offline.
@cluster @mod-ui @cross-user
Feature: Audit trail — a mod action is a visible, shared record across same-tenant moderators

  As the moderation platform
  I must record every mod action in a shared audit trail visible to every same-tenant moderator
  So "always locally audited" is a verifiable guarantee, not a per-browser illusion

  Scenario: a mod's block appears in the audit trail and a second same-tenant mod sees the same row
    Given "mod-domain-a" is logged in in their own context
    And "mod-target" is logged in in their own context
    And "mod-domain-a" navigates to "/mod/console"
    When "mod-domain-a" records a server-wide user block for a unique target
    Then "mod-domain-a" sees the block recorded note
    And "mod-domain-a" sees the audit row for the unique target with a recorded actor
    When "mod-target" navigates to "/mod/console"
    Then "mod-target" also sees the same audit row for the unique target within 30 seconds

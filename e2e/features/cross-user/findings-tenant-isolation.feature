# CROSS-TENANT FINDINGS ISOLATION coverage — the ACTUAL tenant boundary, against
# a REAL finding. findings-panel.feature / findings-triage.feature only DENY a
# plain-user (a ROLE gate, decided by the filter chain before any lookup). This
# file proves the DOMAIN boundary: a domain-B MOD — who PASSES the role gate —
# still cannot SEE or RESOLVE a domain-A finding that genuinely exists.
#
# victim-creates-first: mod-domain-a seeds a REAL held finding in their own
# context (test-seed → federation-api, self-only, issuer-domain-scoped). Then
# mod-domain-b (real login, own context, a legitimate MOD in a DIFFERENT tenant):
#   - LIST: GET /bff/mod/findings and assert the domain-A id is ABSENT from their
#     own domain-scoped queue (not merely that the list is empty).
#   - RESOLVE: POST .../{seededId}/resolve?actioned=true and assert 404 — the
#     cross-domain id is not found for a domain-B principal (federation-api 404s a
#     cross-domain resolve), proving the boundary against a resource that REALLY
#     exists, distinct from the plain-user 403 role gate.
#
# @cluster — needs the live stack (host shell + mod-bff + federation-api +
# APP_TEST_SEED_ENABLED + two seeded tenant domains). Ships dark; compiles +
# discovers offline.
@cluster @mod-ui @cross-user
Feature: Cross-tenant findings isolation — a domain-B mod cannot see or resolve a domain-A finding

  As the moderation platform
  I must scope the automated finding queue to the moderator's own brand
  So a moderator in one tenant can neither read nor resolve another tenant's findings

  Scenario: a domain-B mod's queue excludes a real domain-A finding and its resolve is 404
    Given "mod-domain-a" is logged in in their own context
    And "mod-domain-a" has seeded a held finding
    And "mod-domain-b" is logged in in their own context
    When "mod-domain-b" navigates to "/mod/findings"
    Then "mod-domain-b" does not see the seeded finding in their findings queue
    When "mod-domain-b" attempts to resolve the seeded finding as actioned "true"
    Then the response status is 404

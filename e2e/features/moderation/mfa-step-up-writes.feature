# hugmesh-mod-ui#1 — MFA step-up on sensitive moderation writes.
#
# RE-CHECKED against origin/main (f15a6ca) before writing this, because both
# halves the issue asked for landed since the survey ran:
#   - UI:      <hug-mfa-step-up-dialog> is wired under the ban / domain-lock /
#              block forms (PR #17, 8f0154b) — moderation-console.component.ts
#              offerStepUp()/stepUpSatisfied()/stepUpDismissed().
#   - mod-bff: now stamps X-Step-Up-Required (hugmesh-mod-bff-api#16, PR #18,
#              d5551c4c) instead of a bare 403.
# What still ships DARK by default: mod-bff-api's SecurityConfig defaults
# app.mfa.enforce-sensitive-writes=false, so ModStepUpGate.satisfied() returns
# true unconditionally and a default stack's ban/domain-lock/block still applies
# with no pause. The challenge leg is dark too: auth-core answers 503 while
# app.casdoor.mfa.enabled=false (its default). Each scenario starts with a
# Given step that skips with the reason unless MFA_STEPUP_ARMED=1 (see
# steps/moderation-steps.ts). The Then step asserts the armed-stack behaviour
# the issue asks for, not the silent apply of a default stack.
#
# No feature-level @fixme: playwright-bdd 9.2.0 drops a feature tagged @fixme
# or @skip from generation, so the scenarios would never be discovered and the
# MFA_STEPUP_ARMED gate could never run. @cluster keeps them out of the default
# run (playwright.config.ts).
#
# Completing the challenge (entering a real TOTP code and landing on the
# accepted note) is NOT scripted here: no seeded persona in tests/helpers/
# roles.ts carries a known TOTP secret, and there is no otplib-style helper in
# this suite to derive an RFC-6238 code from one (mirrors hugmesh-auth-core#2,
# which is open for the same reason on the platform side). Only the PAUSE —
# the dialog appearing instead of the write applying — is asserted.
@cluster @mod-ui @issue:mod-ui-1
Feature: Sensitive moderation writes challenge for MFA step-up before submitting

  Scenario: a ban on a plain user pauses on a step-up challenge before it is accepted
    Given the MFA step-up gate is armed on this stack
    And "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    Then "mod-domain-a" sees the step-up challenge dialog

  Scenario: a domain-lock write pauses on the same step-up challenge
    Given the MFA step-up gate is armed on this stack
    And "mod-domain-a" is logged in
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" domain-locks "plain-user" on the "mastodon" platform
    Then "mod-domain-a" sees the step-up challenge dialog

  Scenario: the server-wide block write pauses on the same step-up challenge
    Given the MFA step-up gate is armed on this stack
    And "admin-domain-a" is logged in
    When "admin-domain-a" navigates to "/mod/console"
    And "admin-domain-a" blocks "evil.example" at "instance" scope
    Then "admin-domain-a" sees the step-up challenge dialog

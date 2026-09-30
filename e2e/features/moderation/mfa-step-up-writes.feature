# hugmesh-mod-ui#1 — MFA step-up on sensitive moderation writes.
#
# RE-CHECKED against origin/main (f15a6ca) before writing this, because both
# halves the issue asked for landed since the survey ran:
#   - UI:      <hug-mfa-step-up-dialog> is wired under the ban / domain-lock /
#              block forms (PR #17, 8f0154b) — moderation-console.component.ts
#              offerStepUp()/stepUpSatisfied()/stepUpDismissed().
#   - mod-bff: now stamps X-Step-Up-Required (hugmesh-mod-bff-api#16, PR #18,
#              d5551c4c) instead of a bare 403.
# What still ships DARK by default: SecurityConfig.java:305 in mod-bff-api
# defaults app.mfa.enforce-sensitive-writes=false, and app.casdoor.mfa.enabled
# is off org-wide, so ModStepUpGate.satisfied() returns true unconditionally
# and a default stack's ban/domain-lock/block still applies with no pause.
# @fixme until an operator arms both flags together (MFA_STEPUP_ARMED=1, see
# steps/moderation-steps.ts) — the two Then-steps below assert the CORRECT,
# armed-stack behaviour the issue asks for, never today's silent-apply one.
#
# Completing the challenge (entering a real TOTP code and landing on the
# accepted note) is NOT scripted here: no seeded persona in tests/helpers/
# roles.ts carries a known TOTP secret, and there is no otplib-style helper in
# this suite to derive an RFC-6238 code from one (mirrors hugmesh-auth-core#2,
# which is open for the same reason on the platform side). Only the PAUSE —
# the dialog appearing instead of the write applying — is asserted.
@cluster @mod-ui @issue:mod-ui-1 @fixme
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

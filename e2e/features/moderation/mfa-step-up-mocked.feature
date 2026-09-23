# hugmesh-mod-ui#1 — the MFA step-up LOOP on the three sensitive writes, driven
# against a MOCKED mod-bff so it runs on a DEFAULT stack (MFA dark, gate unarmed).
#
# RE-CHECKED against origin/main before writing (2026-09-23):
#   - mod-ui f15a6ca: <hug-mfa-step-up-dialog> is wired under the ban / domain-lock
#     / block forms (PR #17). offerStepUp() stores the EXACT request snapshot,
#     stepUpSatisfied() re-issues it once, token-less; stepUpDismissed() says
#     plainly that nothing was changed (moderation-console.component.ts).
#   - mod-bff-api d5551c4 (PR #18, 2026-09-18; still on main at a036b55): an
#     ARMED ModStepUpGate refuses with 403 + `X-Step-Up-Required: X-Mod-StepUp`
#     + `{"error":"<verb> requires step-up re-authentication (present X-Mod-StepUp)"}`
#     (ModController.STEP_UP_SIGNAL_HEADER, ModStepUpGate.STEP_UP_HEADER,
#     ModStepUpAccessDeniedHandler). Both legs of mfa/step-up-error.ts now have
#     a real emitter.
#
# WHY A MOCK. app.mfa.enforce-sensitive-writes and app.casdoor.mfa.enabled both
# default false, so a real stack never emits the refusal — the armed-stack
# variant is mfa-step-up-writes.feature, skip-loudly gated on MFA_STEPUP_ARMED.
# Here page.route() answers the three write endpoints and /bff/mfa/challenge with
# the exact wire shapes the BFF documents, so the CLIENT half of the loop —
# recognise the signal, pause the write, retry the identical snapshot exactly
# once, report honestly when nothing was changed — is proven on the stack we
# have. A BARE 403 (the privileged-target / self / cross-tenant rule on these same
# endpoints) must NEVER pop the challenge; that negative is asserted, not assumed.
#
# Dialog locators accept BOTH the inline port's `mfa-stepup-*` testids and
# login-ui's federated `mfa-challenge-*` ones (login-ui d0c13c1, `./mfa-step-up`):
# issue #1's remaining box (generator#347 decisions 21/35) swaps the former for
# the latter, and these scenarios must stay true across that landing rather than
# go red on a rename. Completing a REAL challenge is not scripted (no persona
# carries a TOTP secret); the challenge endpoint is mocked to accept.
#
# @cluster: the host shell must serve this remote. A seeded session primes the
# modGuard; the writes and the MFA surface are mocked, so no bff_ cookie is
# needed and the console's own queue/audit reads may 401 harmlessly.
@cluster @mod-ui @issue:mod-ui-1
Feature: The step-up loop on sensitive moderation writes, against the documented wire contract
  As the moderation console
  I must pause a sensitive write on the platform's step-up refusal and re-issue it unchanged once confirmed
  So a moderator's ban, domain-lock or block is never silently dropped and never silently applied

  Scenario: a mod's ban is paused by the step-up signal, not applied
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "ban" write demanding a step-up
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    Then "mod-domain-a" is offered the MFA step-up challenge
    And the "ban" write has been sent exactly once so far
    And no ban accepted note is shown to "mod-domain-a"

  Scenario: an admin's server-wide block is paused the same way
    Given "admin-domain-a" has a seeded session
    And the mod-bff will refuse the next "block" write demanding a step-up
    When "admin-domain-a" navigates to "/mod/console"
    And "admin-domain-a" blocks "evil.example" at "instance" scope
    Then "admin-domain-a" is offered the MFA step-up challenge
    And the "block" write has been sent exactly once so far

  Scenario: a mod's domain-lock is paused the same way
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "domain-lock" write demanding a step-up
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" domain-locks "plain-user" on the "mastodon" platform
    Then "mod-domain-a" is offered the MFA step-up challenge
    And the "domain-lock" write has been sent exactly once so far

  Scenario: a bare 403 is an ordinary refusal and never pops the challenge
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "ban" write with a bare 403
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "mod-target" on "matrix"
    Then "mod-domain-a" sees the ban rejected alert
    And "mod-domain-a" is not offered any MFA step-up challenge
    And the "ban" write has been sent exactly once so far

  Scenario: a satisfied challenge re-issues the identical ban once and it is accepted
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "ban" write demanding a step-up
    And the MFA challenge endpoint will accept any code
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    And "mod-domain-a" confirms the step-up with the code "123456"
    Then the "ban" write was re-issued exactly once with the identical body
    And "mod-domain-a" sees the ban accepted note

  Scenario: declining the challenge leaves the write unapplied and says so
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "ban" write demanding a step-up
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    And "mod-domain-a" declines the step-up challenge
    Then the "ban" write has been sent exactly once so far
    And "mod-domain-a" sees the "ban" form report that nothing was changed

  Scenario: a dark MFA surface is reported honestly instead of a retry that cannot succeed
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "ban" write demanding a step-up
    And the MFA surface answers dark
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    And "mod-domain-a" confirms the step-up with the code "123456"
    Then "mod-domain-a" sees the step-up challenge report that MFA is not enabled here
    When "mod-domain-a" closes the dark step-up notice
    Then the "ban" write has been sent exactly once so far
    And "mod-domain-a" sees the "ban" form report that nothing was changed

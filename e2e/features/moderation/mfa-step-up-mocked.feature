# hugmesh-mod-ui#1 — the MFA step-up LOOP on the three sensitive writes, driven
# against a MOCKED mod-bff so it runs on a DEFAULT stack (MFA dark, gate unarmed).
#
# RE-CHECKED against origin/main before writing (2026-09-23; consumer 2026-11-04):
#   - mod-ui: <hug-mod-step-up> is wired under the ban / domain-lock / block
#     forms. It loads login-ui's federated `./mfa-step-up` in place from the
#     HARDCODED /login/remoteEntry.json (src/app/mfa/mfa-step-up.ts, decisions
#     21/35) and degrades to the /login/mfa/challenge?returnTo= link when that
#     load is rejected. offerStepUp() stores the EXACT request snapshot,
#     stepUpSatisfied() re-issues it once, token-less; stepUpDismissed() says
#     plainly that nothing was changed (moderation-console.component.ts).
#   - mod-bff-api d5551c4 (PR #18, 2026-09-18; still on main at a036b55): an
#     ARMED ModStepUpGate refuses with 403 + `X-Step-Up-Required: X-Mod-StepUp`
#     + `{"error":"<verb> requires step-up re-authentication (present X-Mod-StepUp)"}`
#     (ModController.STEP_UP_SIGNAL_HEADER, ModStepUpGate.STEP_UP_HEADER,
#     ModStepUpAccessDeniedHandler). Both legs of mfa/step-up-error.ts now have
#     a real emitter.
#
# WHY A MOCK. app.mfa.enforce-sensitive-writes and app.mfa.enabled both
# default false, so a real stack never emits the refusal. An ARMED-stack variant
# (a real mod-bff refusal, skip-loudly gated on MFA_STEPUP_ARMED) lives in
# mfa-step-up-writes.feature — this file does not depend on it. Here page.route() answers the three write endpoints and /bff/mfa/challenge with
# the exact wire shapes the BFF documents, so the CLIENT half of the loop —
# recognise the signal, pause the write, retry the identical snapshot exactly
# once, report honestly when nothing was changed — is proven on the stack we
# have. A BARE 403 (the privileged-target / self / cross-tenant rule on these same
# endpoints) must NEVER pop the challenge; that negative is asserted, not assumed.
#
# Dialog locators in the LOOP rows accept BOTH login-ui's federated
# `mfa-challenge-*` testids (login-ui PR #24, `./mfa-step-up`) and the console's
# own `mfa-stepup-*` wrapper states (the dark notice and its Close, the degraded
# link), so the loop contract reads the same whichever surface is on screen.
# The two rows at the end pin the consumer itself (generator#347 decisions 21/35,
# operator 2026-09-17): the console loads `./mfa-step-up` from the HARDCODED
# `/login/remoteEntry.json` in place — asserted with ONLY `mfa-challenge-*`
# testids, which only login-ui's component renders — and, when that load is
# rejected, degrades to a `/login/mfa/challenge?returnTo=` link. They were
# `@fixme` until the consumer landed; they run unmodified now. The federated
# component makes no /bff/mfa call on mount, so it renders even while MFA ships
# dark. Completing a REAL challenge is not scripted (no persona carries a TOTP
# secret); the challenge endpoint is mocked to accept.
#
# @cluster: the host shell must serve this remote AND the login remote (the
# federated challenge is fetched from /login/remoteEntry.json). A seeded session
# primes the modGuard; the writes and the MFA surface are mocked, so no bff_
# cookie is needed and the console's own queue/audit reads may 401 harmlessly.
# Proven 2026-11-04 on a scratch static gateway serving host-shell, mod-ui
# (--base-href=/mod/) and login-ui (--base-href=/login/) production builds, with
# /bff/** answering 401 and /api/** 404: 9 passed.
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

  Scenario: the step-up refusal loads login-ui's federated challenge in place
    Given "mod-domain-a" has a seeded session
    And the mod-bff will refuse the next "ban" write demanding a step-up
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    Then the console of "mod-domain-a" requested the login remote entry "/login/remoteEntry.json"
    And "mod-domain-a" sees the federated login-ui MFA challenge in place
    And the "ban" write has been sent exactly once so far

  Scenario: when the login remote entry cannot be fetched, the refusal degrades to the returnTo link
    Given "mod-domain-a" has a seeded session
    And the login remote entry cannot be fetched by "mod-domain-a"
    And the mod-bff will refuse the next "ban" write demanding a step-up
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" bans "plain-user" on "matrix"
    Then "mod-domain-a" is offered a link to the platform MFA challenge returning to "/mod/console"
    And the "ban" write has been sent exactly once so far

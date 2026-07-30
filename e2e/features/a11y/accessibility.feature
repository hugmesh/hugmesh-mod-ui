# Accessibility coverage — the org a11y standard the mod-ui carries: a skip link
# that moves focus to the main region, named ARIA landmarks, the
# focusable-but-disabled (aria-disabled, kept in the tab order) admin-only
# controls a screen reader can land on to hear WHY, labelled forms, assertive
# error live-regions, and focus restoration after a route change.
#
# Markup under test (mod-ui src):
#   app.component.html              — `<a class="skip" href="#main">` + `<main
#                                     id="main" tabindex="-1">`.
#   mod-home.component.html          — `<nav aria-label="Moderator sections">`.
#   moderation-console.component.html — `<section
#                                     data-testid="moderation-console-view"
#                                     aria-labelledby="mc-heading">`, per-row
#                                     `[data-decide]` button aria-disabled +
#                                     described-by a help span, five
#                                     aria-labelledby forms, role=alert errors.
#
# @cluster — ships dark; config filters `not @cluster` so no live stack is
# needed. Compiles + discovers offline.
@cluster @mod-ui @a11y
Feature: mod-ui accessibility — skip link, landmarks, focusable-disabled controls, focus restore
  As a keyboard / assistive-tech moderator
  I want the moderation console to honour the org a11y standard
  So I can reach, understand, and operate every surface without a mouse

  Scenario: the skip link is the first tab stop and moves focus to main
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod"
    Then "mod-domain-a" can tab to the skip link
    And activating the skip link moves focus to the main region

  Scenario: the moderator home menu is a named landmark
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod"
    Then the moderator sections menu has an accessible name
    And the "mod-home-view" view has an accessible name

  Scenario: the moderation console region and its forms are all accessibly named
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    Then the "moderation-console-view" view has an accessible name
    And each moderation form is labelled by its heading

  Scenario: the disabled role-grant control is keyboard-focusable and announces its reason
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" focuses the disabled "mc-role-grant-disabled" control
    Then the "mc-role-grant-disabled" control is focused and announces its reason

  Scenario: the disabled external-client control is keyboard-focusable and announces its reason
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" focuses the disabled "mc-external-client-disabled" control
    Then the "mc-external-client-disabled" control is focused and announces its reason

  Scenario: every console error region is an assertive alert
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    And "mod-domain-a" submits the ban form with an empty target
    Then every console error region is an assertive alert

  Scenario: focus returns to the main region after a guarded navigation
    Given "mod-domain-a" has a seeded session
    When "mod-domain-a" navigates to "/mod/console"
    Then "mod-domain-a" sees the "moderation-console-view" view
    And focus is restored to the main region after navigation

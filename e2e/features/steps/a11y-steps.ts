// Accessibility step definitions. The mod-ui carries the org a11y standard:
// a skip link that moves focus to the main region, named ARIA landmarks, the
// focusable-but-disabled (aria-disabled) admin-only controls a screen reader can
// still land on to hear WHY they are unavailable, and focus restoration after a
// route change. These steps assert those contracts against the real markup:
//   - app.component.html      — `<a class="skip" href="#main">` →
//                               `<main id="main" tabindex="-1">`.
//   - mod-home.component.html  — `<nav aria-label="Moderator sections">` with a
//                               `.card` link into the console.
//   - moderation-console      — `<section data-testid="moderation-console-view"
//                               aria-labelledby="mc-heading">`, per-row decide
//                               control with aria-disabled kept in the tab order.

import { expect } from '@playwright/test';
import { Then, When } from '../support/fixtures';
import { pageRegistry } from './_registry';

// Steps whose pattern names the persona ({string}) resolve their page via the
// registry; the anonymous single-persona assertions (no capture in the pattern)
// read the scenario's default `page` fixture — the same page the seeded-session
// Given used. (They previously declared a phantom `username` argument the
// pattern never captured, which playwright-bdd rejects at bddgen time:
// "Function has N arguments, but expected N-1".)
function pageOf(username: string) {
  const page = pageRegistry.get(username);
  if (!page) throw new Error(`No page registered for "${username}" — add a session step first.`);
  return page;
}

// ── Skip-link ────────────────────────────────────────────────────────────────

Then('{string} can tab to the skip link', async ({}, username: string) => {
  const page = pageOf(username);
  await page.keyboard.press('Tab');
  const skip = page.locator('a.skip');
  await expect(skip).toBeFocused();
  await expect(skip).toHaveAttribute('href', '#main');
});

Then('activating the skip link moves focus to the main region', async ({ page }) => {
  await page.locator('a.skip').press('Enter');
  const main = page.locator('main#main');
  await expect(main).toBeFocused();
  // The skip target must be programmatically focusable without being a tab stop.
  await expect(main).toHaveAttribute('tabindex', '-1');
});

// ── ARIA landmarks / labels ──────────────────────────────────────────────────

Then('the moderator sections menu has an accessible name', async ({ page }) => {
  await expect(page.locator('nav[aria-label="Moderator sections"]')).toBeVisible();
});

Then('the {string} view has an accessible name', async ({ page }, testid: string) => {
  const view = page.locator(`[data-testid="${testid}"]`);
  // The view is aria-labelledby a heading (or has an explicit aria-label) —
  // assert one of the two is present so assistive tech can name the region.
  const labelledby = await view.getAttribute('aria-labelledby');
  const ariaLabel = await view.getAttribute('aria-label');
  expect(Boolean(labelledby) || Boolean(ariaLabel)).toBe(true);
});

Then('each moderation form is labelled by its heading', async ({ page }) => {
  // The console's five write forms each carry aria-labelledby pointing at an
  // <h3 id>. Assert every <form aria-labelledby> resolves to a present element.
  const forms = page.locator('[data-testid="moderation-console-view"] form[aria-labelledby]');
  const count = await forms.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const id = await forms.nth(i).getAttribute('aria-labelledby');
    expect(id).toBeTruthy();
    await expect(page.locator(`#${id!.split(/\s+/)[0]}`)).toBeVisible();
  }
});

// ── Focusable-but-disabled admin-only control (roving / tab reachability) ────
// The DECIDE / role-grant / external-client controls are aria-disabled, NOT
// native-disabled, precisely so a keyboard/screen-reader user can still TAB onto
// them and hear the WHY-helptext. Assert the control is focusable.

When('{string} focuses the disabled {string} control', async ({}, username: string, testid: string) => {
  const page = pageOf(username);
  await page.locator(`[data-testid="${testid}"]`).focus();
});

Then('the {string} control is focused and announces its reason', async ({ page }, testid: string) => {
  const ctrl = page.locator(`[data-testid="${testid}"]`);
  await expect(ctrl).toBeFocused();
  // aria-disabled keeps it inert but in the tab order; aria-describedby names
  // the reason span so a screen reader reads the WHY on focus.
  await expect(ctrl).toHaveAttribute('aria-disabled', 'true');
  const describedby = await ctrl.getAttribute('aria-describedby');
  expect(describedby).toBeTruthy();
  await expect(page.locator(`#${describedby!.split(/\s+/)[0]}`)).toBeVisible();
});

// ── Focus restoration after a route change ───────────────────────────────────

Then('focus is restored to the main region after navigation', async ({ page }) => {
  await expect(page.locator('main#main')).toBeFocused();
});

// ── Live-region wiring (announcements) ───────────────────────────────────────

Then('every console error region is an assertive alert', async ({ page }) => {
  // Error spans are role=alert + aria-live=assertive; they are *ngIf-gated so
  // when none is shown the count is 0, which is also valid (nothing to announce).
  const alerts = page.locator('[data-testid="moderation-console-view"] .field-error');
  const count = await alerts.count();
  for (let i = 0; i < count; i++) {
    await expect(alerts.nth(i)).toHaveAttribute('role', 'alert');
    await expect(alerts.nth(i)).toHaveAttribute('aria-live', 'assertive');
  }
});

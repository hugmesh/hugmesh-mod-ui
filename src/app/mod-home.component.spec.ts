import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModHomeComponent } from './mod-home.component';

describe('ModHomeComponent', () => {
  let fixture: ComponentFixture<ModHomeComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ModHomeComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(ModHomeComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  it('creates the moderator landing', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('links into the moderation console', () => {
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="mod-home-console"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('console');
  });

  it('links into the system-findings panel', () => {
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="mod-home-findings"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toContain('findings');
    expect(link!.getAttribute('aria-describedby')).toBe('mod-home-findings-desc');
    expect(el.querySelector('#mod-home-findings-desc')!.textContent!.trim().length).toBeGreaterThan(0);
  });

  describe('accessibility', () => {
    it('labels the section via its heading', () => {
      const section = el.querySelector('[data-testid="mod-home-view"]')!;
      expect(section.getAttribute('aria-labelledby')).toBe('mod-home-heading');
      expect(el.querySelector('#mod-home-heading')).not.toBeNull();
    });

    it('wraps the section links in a labelled <nav> landmark', () => {
      const nav = el.querySelector('nav');
      expect(nav).not.toBeNull();
      expect(nav!.getAttribute('aria-label')!.length).toBeGreaterThan(0);
    });

    it('programmatically associates the console card with its visible description', () => {
      const link = el.querySelector<HTMLAnchorElement>('[data-testid="mod-home-console"]')!;
      const describedBy = link.getAttribute('aria-describedby');
      expect(describedBy).toBe('mod-home-console-desc');
      const desc = el.querySelector(`#${describedBy}`);
      expect(desc).withContext('console card description target').not.toBeNull();
      expect(desc!.textContent!.trim().length).toBeGreaterThan(0);
    });

    // ── Keyboard operability (WCAG 2.1.1 / 2.4.3) ─────────────────────
    // The only interactive element is the console card. It is a native routerLink
    // <a href> (NOT a div with a click handler), so it is keyboard-reachable via
    // Tab and activates on Enter for free. Assert that contract so a refactor to a
    // non-native "card" that drops keyboard activation fails CI.
    it('exposes the console card as a native, focusable <a href> link', () => {
      const link = el.querySelector<HTMLAnchorElement>('[data-testid="mod-home-console"]')!;
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBeTruthy();
      // An <a href> is in the tab order without an explicit tabindex.
      expect(link.tabIndex).toBeGreaterThanOrEqual(0);
    });

    it('uses no positive tabindex anywhere (focus order follows the DOM)', () => {
      const positive = Array.from(el.querySelectorAll<HTMLElement>('[tabindex]')).filter(
        (n) => Number(n.getAttribute('tabindex')) > 0,
      );
      expect(positive.length).toBe(0);
    });
  });
});

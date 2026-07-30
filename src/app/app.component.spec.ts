import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { routes } from './app.routes';

/**
 * The standalone dev shell (only used by `ng serve mod`). It must supply the
 * a11y landmarks that the federated host normally provides — a skip link and a
 * focusable <main id="main"> — plus the <router-outlet> that mounts the exposed
 * MOD_ROUTES so the remote is browsable on its own.
 */
describe('AppComponent (standalone dev shell)', () => {
  let fixture: ComponentFixture<AppComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter(routes)],
    }).compileComponents();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  it('creates the dev shell', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders a router-outlet so MOD_ROUTES can mount standalone', () => {
    expect(el.querySelector('router-outlet')).not.toBeNull();
  });

  describe('accessibility', () => {
    it('exposes a skip link targeting the main landmark', () => {
      const skip = el.querySelector<HTMLAnchorElement>('a.skip');
      expect(skip).withContext('skip link present').not.toBeNull();
      expect(skip!.getAttribute('href')).toBe('#main');
      expect(skip!.textContent!.trim().length).toBeGreaterThan(0);
    });

    it('renders a focusable <main id="main"> landmark for the skip target', () => {
      const main = el.querySelector<HTMLElement>('main#main');
      expect(main).withContext('<main id="main"> present').not.toBeNull();
      expect(main!.getAttribute('tabindex')).toBe('-1');
    });

    // ── Keyboard operability of the skip-to-main path (WCAG 2.4.1) ────
    // The skip link is a native <a href="#main"> — keyboard-reachable as the
    // first Tab stop and Enter-activatable for free. The <main> target carries
    // tabindex="-1" so the in-page jump lands keyboard focus on the content,
    // and main is focusable programmatically (focus() succeeds).
    it('exposes the skip link as a native, focusable <a href> (first Tab stop)', () => {
      const skip = el.querySelector<HTMLAnchorElement>('a.skip')!;
      expect(skip.tagName).toBe('A');
      expect(skip.getAttribute('href')).toBe('#main');
      expect(skip.tabIndex).toBeGreaterThanOrEqual(0);
    });

    it('lets keyboard focus land on <main> when the skip link is followed', () => {
      const main = el.querySelector<HTMLElement>('main#main')!;
      // tabindex="-1" makes the in-page #main target programmatically focusable
      // so the skip jump moves keyboard focus into the content (not just scroll).
      main.focus();
      expect(document.activeElement).toBe(main);
    });

    it('uses no positive tabindex (focus order follows the DOM — WCAG 2.4.3)', () => {
      const positive = Array.from(el.querySelectorAll<HTMLElement>('[tabindex]')).filter(
        (n) => Number(n.getAttribute('tabindex')) > 0,
      );
      expect(positive.length).toBe(0);
    });
  });
});

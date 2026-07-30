import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { FindingsPanelComponent } from './findings-panel.component';
import { ModBffService, SystemFinding } from './mod-bff.service';

const finding: SystemFinding = {
  id: 42,
  reporter: '@system',
  subject: 'user:alice',
  surface: 'profile-avatar',
  disposition: 'flagged',
  classification: 'nsfw',
  confidence: 0.93,
  policyHit: true,
  perceptualHash: 'ph:abc',
  status: 'held',
  reviewer: null,
  ts: '2026-06-06T00:00:00Z',
  domain: 'hugmesh.systems',
};

describe('FindingsPanelComponent', () => {
  let fixture: ComponentFixture<FindingsPanelComponent>;
  let component: FindingsPanelComponent;
  let bff: jasmine.SpyObj<ModBffService>;
  let findings$: BehaviorSubject<SystemFinding[]>;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    findings$ = new BehaviorSubject<SystemFinding[]>([finding]);
    bff = jasmine.createSpyObj<ModBffService>(
      'ModBffService',
      ['loadFindings', 'resolveFinding'],
      { findings: findings$.asObservable() },
    );
    bff.loadFindings.and.resolveTo([finding]);
    bff.resolveFinding.and.resolveTo({ ...finding, status: 'actioned', reviewer: 'mod:bob' });

    await TestBed.configureTestingModule({
      imports: [FindingsPanelComponent],
      providers: [{ provide: ModBffService, useValue: bff }],
    }).compileComponents();
    fixture = TestBed.createComponent(FindingsPanelComponent);
    component = fixture.componentInstance;
  }

  beforeEach(async () => {
    await setup();
  });

  it('loads the finding queue on init and renders a row per item', () => {
    fixture.detectChanges();
    expect(bff.loadFindings).toHaveBeenCalledTimes(1);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-finding-id="42"]')).not.toBeNull();
  });

  it('renders an empty-state row when the queue is empty', () => {
    findings$.next([]);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="fp-queue-empty"]')).not.toBeNull();
  });

  it('reflects a queue refresh pushed by the service subject', () => {
    fixture.detectChanges();
    findings$.next([{ ...finding, status: 'dismissed' }]);
    fixture.detectChanges();
    expect(component.findings()[0].status).toBe('dismissed');
  });

  it('renders the subject and reviewer (placeholder while held) in the row', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const row = el.querySelector('[data-finding-id="42"]')!;
    expect(row.textContent).toContain('user:alice');
    expect(row.textContent).toContain('profile-avatar');
    // A held finding has no reviewer yet — the cell shows the em-dash placeholder.
    expect(row.textContent).toContain('—');
  });

  // ── Status filter (WIRED: GET /bff/mod/findings?status=) ────────────
  describe('status filter', () => {
    it('reloads the queue with the selected status (blank => all/undefined)', async () => {
      fixture.detectChanges();
      bff.loadFindings.calls.reset();
      component.statusFilter = 'held';
      await component.applyStatusFilter();
      expect(bff.loadFindings).toHaveBeenCalledWith('held');

      component.statusFilter = '';
      await component.applyStatusFilter();
      expect(bff.loadFindings).toHaveBeenCalledWith(undefined);
    });

    it('offers held / actioned / dismissed filter options', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const opts = Array.from(el.querySelectorAll('#fp-status option')).map((o) => o.getAttribute('value'));
      expect(opts).toContain('held');
      expect(opts).toContain('actioned');
      expect(opts).toContain('dismissed');
    });
  });

  // ── Resolve (WIRED: POST /bff/mod/findings/{id}/resolve?actioned=) ──
  describe('resolve (confirm / dismiss)', () => {
    it('confirms a finding with actioned=true and announces the outcome', async () => {
      fixture.detectChanges();
      await component.confirm(42);
      expect(bff.resolveFinding).toHaveBeenCalledWith(42, true);
      expect(component.resolveNote()).toContain('actioned');
    });

    it('dismisses a finding with actioned=false and announces the outcome', async () => {
      fixture.detectChanges();
      await component.dismiss(42);
      expect(bff.resolveFinding).toHaveBeenCalledWith(42, false);
      expect(component.resolveNote()).toContain('dismissed');
    });

    it('surfaces a server rejection (e.g. cross-domain / already resolved)', async () => {
      bff.resolveFinding.and.resolveTo(null);
      fixture.detectChanges();
      await component.confirm(42);
      expect(component.resolveNote().toLowerCase()).toContain('rejected');
    });

    it('drives the BFF when a resolve button is activated by a keyboard-style click', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      el.querySelector<HTMLButtonElement>('[data-confirm="42"]')!.click();
      expect(bff.resolveFinding).toHaveBeenCalledWith(42, true);
    });

    it('disables both resolve actions once a finding is no longer held', () => {
      findings$.next([{ ...finding, status: 'actioned', reviewer: 'mod:bob' }]);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector<HTMLButtonElement>('[data-confirm="42"]')!.disabled).toBeTrue();
      expect(el.querySelector<HTMLButtonElement>('[data-dismiss="42"]')!.disabled).toBeTrue();
    });
  });

  // ── Accessibility ───────────────────────────────────────────────────
  describe('accessibility', () => {
    it('associates the status filter with a <label for> and a visible help hint', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('#fp-status')).not.toBeNull();
      expect(el.querySelector('label[for="fp-status"]')).not.toBeNull();
      const help = el.querySelector('[data-testid="fp-status-help"]')!;
      expect(help.textContent!.trim().length).toBeGreaterThan(0);
      expect(el.querySelector('#fp-status')!.getAttribute('aria-describedby')).toBe('fp-status-help');
    });

    it('uses a semantic thead with th[scope=col] for the queue table', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const headers = el.querySelectorAll('[data-testid="fp-queue"] thead th[scope="col"]');
      // id, surface, subject, status, created, reviewer (+ a visually-hidden actions col).
      expect(headers.length).toBeGreaterThanOrEqual(6);
    });

    it('gives each resolve button a descriptive aria-label and a help target', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const confirm = el.querySelector<HTMLButtonElement>('[data-confirm="42"]')!;
      const dismiss = el.querySelector<HTMLButtonElement>('[data-dismiss="42"]')!;
      expect(confirm.getAttribute('type')).toBe('button');
      expect(dismiss.getAttribute('type')).toBe('button');
      expect(confirm.getAttribute('aria-label')).toContain('user:alice');
      expect(dismiss.getAttribute('aria-label')).toContain('user:alice');
      expect(confirm.getAttribute('aria-describedby')).toBe('fp-confirm-help-42');
      expect(dismiss.getAttribute('aria-describedby')).toBe('fp-dismiss-help-42');
      expect(el.querySelector('[data-confirm-help="42"]')!.textContent!.trim().length).toBeGreaterThan(0);
      expect(el.querySelector('[data-dismiss-help="42"]')!.textContent!.trim().length).toBeGreaterThan(0);
    });

    it('announces the resolve outcome in a polite role=status live region', async () => {
      fixture.detectChanges();
      await component.confirm(42);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const note = el.querySelector('[data-testid="fp-resolve-note"]')!;
      expect(note.getAttribute('role')).toBe('status');
      expect(note.getAttribute('aria-live')).toBe('polite');
    });

    it('announces the ASCII screenReaderName in the resolve aria-labels when present', () => {
      findings$.next([
        { ...finding, subject: '山田太郎', screenReaderName: 'Yamada Taro' } as SystemFinding & { screenReaderName: string },
      ]);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const confirm = el.querySelector<HTMLButtonElement>('[data-confirm="42"]')!;
      expect(confirm.getAttribute('aria-label')).toContain('Yamada Taro');
      // The visible cell keeps the UTF-8 display name.
      expect(el.querySelector('[data-finding-id="42"]')!.textContent).toContain('山田太郎');
    });

    it('never uses a positive tabindex (focus order follows the DOM — WCAG 2.4.3)', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const positive = Array.from(el.querySelectorAll<HTMLElement>('[tabindex]')).filter(
        (n) => Number(n.getAttribute('tabindex')) > 0,
      );
      expect(positive.length).toBe(0);
    });
  });
});

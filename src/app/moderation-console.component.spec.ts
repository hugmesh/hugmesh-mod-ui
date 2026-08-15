import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ModerationConsoleComponent } from './moderation-console.component';
import { BlockResult, ModAction, ModBffService, ModerationRequest, SystemFinding } from './mod-bff.service';
import { AdminBffService } from './admin-bff.service';
import { SessionService } from './session.service';

const request: ModerationRequest = {
  id: 7,
  requester: 'user:alice',
  kind: 'instance-block',
  target: 'evil.example',
  reason: 'spam',
  status: 'recommended',
  modReferrer: null,
  adminDecider: null,
  ts: '2026-06-06T00:00:00Z',
};

const action: ModAction = {
  id: 'a-1',
  actor: 'mod:bob',
  action: 'matrix.block-user',
  platform: 'matrix',
  target: '@spam:evil.example',
  reason: 'abuse',
  result: 'stubbed',
  ts: '2026-06-06T00:00:00',
};

describe('ModerationConsoleComponent', () => {
  let fixture: ComponentFixture<ModerationConsoleComponent>;
  let component: ModerationConsoleComponent;
  let bff: jasmine.SpyObj<ModBffService>;
  let admin: jasmine.SpyObj<AdminBffService>;
  let moderation$: BehaviorSubject<ModerationRequest[]>;
  let audit$: BehaviorSubject<ModAction[]>;
  // The target pickers pull their suggestions from ModDirectoryService, which subscribes
  // all THREE caches — so the mock must expose findings too, not just the two this suite
  // originally asserted on.
  let findings$: BehaviorSubject<SystemFinding[]>;
  const isAdmin = signal(false);

  async function setup(asAdmin = false): Promise<void> {
    // Allow a test to re-configure with an admin session after the default
    // beforeEach already instantiated the module.
    TestBed.resetTestingModule();
    isAdmin.set(asAdmin);
    moderation$ = new BehaviorSubject<ModerationRequest[]>([request]);
    audit$ = new BehaviorSubject<ModAction[]>([action]);
    findings$ = new BehaviorSubject<SystemFinding[]>([]);
    bff = jasmine.createSpyObj<ModBffService>(
      'ModBffService',
      ['loadModeration', 'refer', 'recommend', 'block', 'ban', 'lift', 'domainLock', 'domainUnlock', 'loadAudit'],
      {
        moderation: moderation$.asObservable(),
        audit: audit$.asObservable(),
        findings: findings$.asObservable(),
      },
    );
    bff.loadModeration.and.resolveTo([request]);
    bff.loadAudit.and.resolveTo([action]);
    bff.refer.and.resolveTo({ ...request, status: 'referred' });
    bff.recommend.and.resolveTo(request);
    bff.ban.and.resolveTo({ state: 'pending-reconcile' });
    bff.lift.and.resolveTo({ state: 'restored' });
    bff.domainLock.and.resolveTo({ state: 'pending-reconcile' });
    bff.domainUnlock.and.resolveTo({ state: 'cleared' });

    admin = jasmine.createSpyObj<AdminBffService>('AdminBffService', ['decide']);
    admin.decide.and.resolveTo({ ...request, status: 'approved' });

    await TestBed.configureTestingModule({
      imports: [ModerationConsoleComponent],
      providers: [
        { provide: ModBffService, useValue: bff },
        { provide: AdminBffService, useValue: admin },
        { provide: SessionService, useValue: { isAdmin } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ModerationConsoleComponent);
    component = fixture.componentInstance;
  }

  beforeEach(async () => {
    await setup(false);
  });

  it('loads the queue and the audit trail on init and renders a row per item', () => {
    fixture.detectChanges();
    expect(bff.loadModeration).toHaveBeenCalledTimes(1);
    expect(bff.loadAudit).toHaveBeenCalledTimes(1);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-request-id="7"]')).not.toBeNull();
    expect(el.querySelector('[data-audit-id="a-1"]')).not.toBeNull();
  });

  it('renders an empty-state row when the queue is empty', () => {
    moderation$.next([]);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="mc-queue-empty"]')).not.toBeNull();
  });

  it('refers a queue item up to an admin through the BFF', async () => {
    fixture.detectChanges();
    await component.refer(7);
    expect(bff.refer).toHaveBeenCalledWith(7);
    expect(component.referError()).toBe('');
  });

  it('surfaces a rejected refer (null) honestly instead of silently doing nothing', async () => {
    bff.refer.and.resolveTo(null);
    fixture.detectChanges();
    await component.refer(7);
    fixture.detectChanges();
    expect(component.referError()).toContain('NOT escalated');
    const el: HTMLElement = fixture.nativeElement;
    const err = el.querySelector('[data-testid="mc-refer-error"]')!;
    expect(err).not.toBeNull();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.getAttribute('aria-live')).toBe('assertive');
  });

  it('reflects a queue refresh pushed by the service subject', () => {
    fixture.detectChanges();
    moderation$.next([{ ...request, status: 'referred' }]);
    fixture.detectChanges();
    expect(component.queue()[0].status).toBe('referred');
  });

  describe('server-wide block', () => {
    it('submits a trimmed block (platform/scope/target/reason) and clears the inputs', async () => {
      const result: BlockResult = { blocked: action, external: 'stubbed', note: 'STUBBED' };
      bff.block.and.resolveTo(result);
      fixture.detectChanges();

      component.platform = 'mastodon';
      component.scope = 'instance';
      component.target = '  evil.example  ';
      component.reason = '  spam  ';
      await component.block();

      expect(bff.block).toHaveBeenCalledWith({
        platform: 'mastodon', scope: 'instance', target: 'evil.example', reason: 'spam',
      });
      expect(component.target).toBe('');
      expect(component.reason).toBe('');
      expect(component.blockNote()).toContain('STUBBED');
    });

    it('omits reason when blank and surfaces the external result note', async () => {
      bff.block.and.resolveTo({ blocked: action, external: 'stubbed' });
      fixture.detectChanges();
      component.target = '@x:y';
      component.reason = '   ';
      await component.block();
      expect(bff.block).toHaveBeenCalledWith(
        jasmine.objectContaining({ target: '@x:y', reason: undefined }),
      );
      expect(component.blockNote()).toContain('stubbed');
    });

    it('does not call the BFF and announces an error when the target is blank', async () => {
      fixture.detectChanges();
      bff.block.calls.reset();
      component.target = '   ';
      await component.block();
      fixture.detectChanges();

      expect(bff.block).not.toHaveBeenCalled();
      const el: HTMLElement = fixture.nativeElement;
      const alert = el.querySelector('[data-testid="mc-block-error"]')!;
      expect(alert).not.toBeNull();
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.getAttribute('aria-live')).toBe('assertive');
    });

    it('surfaces a server rejection as an error', async () => {
      bff.block.and.resolveTo(null);
      fixture.detectChanges();
      component.target = '@x:y';
      await component.block();
      expect(component.blockError()).not.toBe('');
    });
  });

  describe('accessibility', () => {
    it('associates every block form control with a <label for>', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      for (const id of ['mc-platform', 'mc-scope', 'mc-target', 'mc-reason']) {
        expect(el.querySelector(`#${id}`)).withContext(`#${id}`).not.toBeNull();
        expect(el.querySelector(`label[for="${id}"]`)).withContext(`label for #${id}`).not.toBeNull();
      }
    });

    it('gives each refer button a descriptive aria-label', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      expect(btn.getAttribute('type')).toBe('button');
      expect(btn.getAttribute('aria-label')).toContain('evil.example');
    });

    it('disables the refer button once an item is already referred', () => {
      moderation$.next([{ ...request, status: 'referred' }]);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      expect(btn.disabled).toBeTrue();
    });

    it('uses semantic theads with th[scope=col] for both tables', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelectorAll('[data-testid="mc-queue"] thead th[scope="col"]').length).toBeGreaterThanOrEqual(5);
      expect(el.querySelectorAll('[data-testid="mc-audit"] thead th[scope="col"]').length).toBeGreaterThanOrEqual(5);
    });

    it('announces the block outcome in a polite role=status live region', async () => {
      bff.block.and.resolveTo({ blocked: action, external: 'stubbed', note: 'STUBBED' });
      fixture.detectChanges();
      component.target = '@x:y';
      await component.block();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const note = el.querySelector('[data-testid="mc-block-note"]')!;
      expect(note.getAttribute('role')).toBe('status');
      expect(note.getAttribute('aria-live')).toBe('polite');
    });
  });

  describe('target pickers (typeahead, sourced from the mod\'s own scoped queues)', () => {
    it('renders every target field as a combobox, not a bare text input', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      for (const id of ['mc-rec-target', 'mc-ban-target', 'mc-dl-user', 'mc-target']) {
        const field = el.querySelector<HTMLInputElement>(`#${id}`)!;
        expect(field).withContext(id).not.toBeNull();
        expect(field.getAttribute('role')).withContext(id).toBe('combobox');
        expect(field.getAttribute('aria-controls')).withContext(id).toBe(`${id}-listbox`);
        // The label association the previous plain input had must survive the swap.
        expect(el.querySelector(`label[for="${id}"]`)).withContext(`label for ${id}`).not.toBeNull();
      }
    });

    it('keeps free text: typing an unsuggested remote target still binds to the model', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const field = el.querySelector<HTMLInputElement>('#mc-ban-target')!;
      field.value = '@stranger:elsewhere.example';
      field.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      // A moderator must be able to act on an account that has never appeared in their
      // queues — the picker suggests, it never constrains.
      expect(component.banTarget).toBe('@stranger:elsewhere.example');
    });
  });

  // ── Help text for sighted + low/no-sight users (UI standard 2026-06-12) ──
  // Every meaningful control carries a VISIBLE hint that is PROGRAMMATICALLY
  // ASSOCIATED via aria-describedby so a screen reader announces it WITH the
  // control. These assert both halves: the control points at a help id, and a
  // visible (non-empty) .field-help element with that id actually exists.
  describe('help text wiring (aria-describedby → visible help)', () => {
    /** A control's aria-describedby resolves to a non-empty visible help node. */
    function expectDescribedByHelp(controlSelector: string) {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const control = el.querySelector<HTMLElement>(controlSelector)!;
      expect(control).withContext(controlSelector).not.toBeNull();
      const describedBy = control.getAttribute('aria-describedby');
      expect(describedBy).withContext(`${controlSelector} aria-describedby`).toBeTruthy();
      // Each id token must resolve to an element with real text content.
      for (const id of describedBy!.split(/\s+/).filter(Boolean)) {
        const help = el.querySelector(`#${id}`);
        expect(help).withContext(`#${id} help target for ${controlSelector}`).not.toBeNull();
        expect(help!.textContent!.trim().length)
          .withContext(`#${id} help text non-empty`)
          .toBeGreaterThan(0);
      }
    }

    it('describes the queue status filter (what it does + that it reloads)', () => {
      expectDescribedByHelp('[data-testid="mc-status"]');
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="mc-status-help"]')!.textContent!.toLowerCase())
        .toContain('queue');
    });

    it('describes the refer-to-admin action on each queue row', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      expect(btn.getAttribute('aria-describedby')).toBe('mc-refer-help-7');
      expect(el.querySelector('[data-refer-help="7"]')!.textContent!.toLowerCase())
        .toContain('administrator');
    });

    it('describes every recommend-form control', () => {
      expectDescribedByHelp('[data-testid="mc-rec-kind"]');
      expectDescribedByHelp('[data-testid="mc-rec-reason"]');
      // target points at help while valid (it switches to the error id on error).
      expectDescribedByHelp('[data-testid="mc-rec-target"]');
    });

    it('associates the recommend form with its visible intro', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const form = el.querySelector('form[aria-labelledby="mc-recommend-heading"]')!;
      expect(form.getAttribute('aria-describedby')).toBe('mc-rec-intro');
      expect(el.querySelector('#mc-rec-intro')!.textContent!.trim().length).toBeGreaterThan(0);
    });

    it('describes every ban-form control and the action buttons', () => {
      expectDescribedByHelp('[data-testid="mc-ban-platform"]');
      expectDescribedByHelp('[data-testid="mc-ban-target"]');
      expectDescribedByHelp('[data-testid="mc-ban-ttl"]');
      expectDescribedByHelp('[data-testid="mc-ban-reason"]');
      expectDescribedByHelp('[data-testid="mc-ban-submit"]');
      expectDescribedByHelp('[data-testid="mc-ban-lift"]');
    });

    it('describes every domain-lock control and the action buttons', () => {
      expectDescribedByHelp('[data-testid="mc-dl-role"]');
      expectDescribedByHelp('[data-testid="mc-dl-user"]');
      expectDescribedByHelp('[data-testid="mc-dl-reason"]');
      expectDescribedByHelp('[data-testid="mc-dl-lock"]');
      expectDescribedByHelp('[data-testid="mc-dl-unlock"]');
    });

    it('describes every server-wide block control (incl. the user/instance scope)', () => {
      expectDescribedByHelp('[data-testid="mc-platform"]');
      expectDescribedByHelp('[data-testid="mc-scope"]');
      expectDescribedByHelp('[data-testid="mc-target"]');
      expectDescribedByHelp('[data-testid="mc-reason"]');
      const el: HTMLElement = fixture.nativeElement;
      const scopeHelp = el.querySelector('[data-testid="mc-scope-help"]')!.textContent!.toLowerCase();
      expect(scopeHelp).toContain('instance');
      expect(scopeHelp).toContain('user');
    });

    it('keeps every help target inside the live DOM (so AT can resolve it)', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const help = el.querySelectorAll('.field-help');
      // The console exposes many distinct help hints; guard against a regression
      // that drops them all.
      expect(help.length).toBeGreaterThanOrEqual(12);
    });
  });

  // ── Queue status filter (WIRED: GET /bff/mod/moderation?status=) ─────
  describe('queue status filter', () => {
    it('reloads the queue with the selected status (blank => all/undefined)', async () => {
      fixture.detectChanges();
      bff.loadModeration.calls.reset();
      component.statusFilter = 'self-silence-appeal';
      await component.applyStatusFilter();
      expect(bff.loadModeration).toHaveBeenCalledWith('self-silence-appeal');

      component.statusFilter = '';
      await component.applyStatusFilter();
      expect(bff.loadModeration).toHaveBeenCalledWith(undefined);
    });

    it('offers a self-silence-appeal option so user appeal rows can be triaged', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const opts = Array.from(el.querySelectorAll('#mc-status option')).map((o) => o.getAttribute('value'));
      expect(opts).toContain('self-silence-appeal');
    });
  });

  // ── Audit-trail 'mine' filter (WIRED: GET /bff/mod/audit?mine) ───────
  // The BFF/ModBffService already support the ?mine option; this exposes it.
  describe('audit trail mine filter', () => {
    it('reloads the audit trail scoped to my own actions when toggled, and back to all', async () => {
      fixture.detectChanges();
      bff.loadAudit.calls.reset();
      component.auditMine = true;
      await component.applyAuditFilter();
      expect(bff.loadAudit).toHaveBeenCalledWith(true);

      component.auditMine = false;
      await component.applyAuditFilter();
      expect(bff.loadAudit).toHaveBeenCalledWith(false);
    });

    it('exposes a labelled checkbox wired to the mine filter with help text', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const cb = el.querySelector<HTMLInputElement>('[data-testid="mc-audit-mine"]')!;
      expect(cb).withContext('mine checkbox').not.toBeNull();
      expect(cb.getAttribute('type')).toBe('checkbox');
      expect(el.querySelector('label[for="mc-audit-mine"]')).withContext('label for the checkbox').not.toBeNull();
      expect(cb.getAttribute('aria-describedby')).toBe('mc-audit-mine-help');
      expect(el.querySelector('[data-testid="mc-audit-mine-help"]')!.textContent!.trim().length).toBeGreaterThan(0);
    });
  });

  // ── Recommend (WIRED: POST /bff/mod/moderation) ─────────────────────
  describe('recommend (mod→admin escalation)', () => {
    it('submits a trimmed recommendation and clears the inputs', async () => {
      fixture.detectChanges();
      component.recommendKind = 'user-removal';
      component.recommendTarget = '  bad-user  ';
      component.recommendReason = '  abuse  ';
      await component.recommend();
      expect(bff.recommend).toHaveBeenCalledWith({ kind: 'user-removal', target: 'bad-user', reason: 'abuse' });
      expect(component.recommendTarget).toBe('');
      expect(component.recommendNote()).toContain('federation queue');
    });

    it('blocks an empty target and announces an error without calling the BFF', async () => {
      fixture.detectChanges();
      component.recommendTarget = '   ';
      await component.recommend();
      expect(bff.recommend).not.toHaveBeenCalled();
      expect(component.recommendError()).not.toBe('');
    });

    it('surfaces a server rejection', async () => {
      bff.recommend.and.resolveTo(null);
      fixture.detectChanges();
      component.recommendTarget = 'x';
      await component.recommend();
      expect(component.recommendError()).not.toBe('');
    });
  });

  // ── Ban / lift (WIRED: POST/DELETE /bff/mod/ban) ────────────────────
  describe('ban / lift', () => {
    it('bans with a positive ttlSeconds parsed from the string field', async () => {
      fixture.detectChanges();
      component.banPlatform = 'matrix';
      component.banTarget = '@bad:evil.example';
      component.banTtlSeconds = '3600';
      component.banReason = 'abuse';
      await component.ban();
      expect(bff.ban).toHaveBeenCalledWith({
        platform: 'matrix', target: '@bad:evil.example', ttlSeconds: 3600, reason: 'abuse',
      });
      expect(component.banNote()).toContain('pending reconcile');
    });

    it('treats a blank TTL as a permanent ban (ttlSeconds undefined)', async () => {
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      component.banTtlSeconds = '';
      await component.ban();
      expect(bff.ban).toHaveBeenCalledWith(
        jasmine.objectContaining({ target: 'bad-user', ttlSeconds: undefined }),
      );
    });

    it('drops a non-positive / non-numeric TTL to undefined (permanent)', async () => {
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      component.banTtlSeconds = '-5';
      await component.ban();
      expect(bff.ban).toHaveBeenCalledWith(jasmine.objectContaining({ ttlSeconds: undefined }));
    });

    it('lifts with the same body shape (DELETE)', async () => {
      fixture.detectChanges();
      component.banPlatform = 'profile';
      component.banTarget = 'bad-user';
      await component.lift();
      expect(bff.lift).toHaveBeenCalledWith(jasmine.objectContaining({ platform: 'profile', target: 'bad-user' }));
      expect(component.banNote()).toContain('pending reconcile');
    });

    it('requires a target and announces an error otherwise', async () => {
      fixture.detectChanges();
      component.banTarget = '  ';
      await component.ban();
      expect(bff.ban).not.toHaveBeenCalled();
      expect(component.banError()).not.toBe('');
    });

    it('mirrors the server guard (403) as a "cannot ban a mod/admin/self" error', async () => {
      bff.ban.and.resolveTo(null);
      fixture.detectChanges();
      component.banTarget = 'an-admin';
      await component.ban();
      expect(component.banError()).toContain('moderator/administrator');
    });

    it('surfaces the degraded note when the admin-bff breaker is open', async () => {
      bff.ban.and.resolveTo({ state: 'pending-reconcile', degraded: 'breaker-open' });
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.banNote()).toContain('breaker-open');
    });

    it('clears a prior success note when a later ban is rejected (no contradictory note beside the error)', async () => {
      fixture.detectChanges();
      // First: a successful ban leaves an accepted note.
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.banNote()).not.toBe('');
      // Then: a rejected ban must surface an error AND drop the stale note.
      bff.ban.and.resolveTo(null);
      component.banTarget = 'an-admin';
      await component.ban();
      expect(component.banError()).not.toBe('');
      expect(component.banNote()).toBe('');
    });
  });

  // ── Domain-lock (WIRED: POST/DELETE /bff/mod/domain-lock/{role}/{user}) ──
  describe('domain-lock add / remove', () => {
    it('locks with the role + user and an optional reason body', async () => {
      fixture.detectChanges();
      component.domainLockRole = 'ROLE_MATRIX_DOMAINLOCKED';
      component.domainLockUser = '@bad:evil.example';
      component.domainLockReason = 'evasion';
      await component.domainLock();
      expect(bff.domainLock).toHaveBeenCalledWith('ROLE_MATRIX_DOMAINLOCKED', '@bad:evil.example', { reason: 'evasion' });
      expect(component.domainLockNote()).toContain('pending reconcile');
    });

    it('unlocks without a body', async () => {
      fixture.detectChanges();
      component.domainLockRole = 'ROLE_MASTODON_DOMAINLOCKED';
      component.domainLockUser = 'bad-user';
      await component.domainUnlock();
      expect(bff.domainUnlock).toHaveBeenCalledWith('ROLE_MASTODON_DOMAINLOCKED', 'bad-user');
    });

    it('requires a target', async () => {
      fixture.detectChanges();
      component.domainLockUser = '';
      await component.domainLock();
      expect(bff.domainLock).not.toHaveBeenCalled();
      expect(component.domainLockError()).not.toBe('');
    });

    it('mirrors the server guard (403) on a rejected lock', async () => {
      bff.domainLock.and.resolveTo(null);
      fixture.detectChanges();
      component.domainLockUser = 'a-mod';
      await component.domainLock();
      expect(component.domainLockError()).toContain('moderator/administrator');
    });
  });

  // ── DISABLED + helptext (V7: no mod-bff endpoint) ───────────────────
  describe('admin-only / no-endpoint controls render disabled + helptext', () => {
    function expectDisabledWithHelp(testid: string, helpId: string) {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!;
      expect(btn).withContext(testid).not.toBeNull();
      // aria-disabled (NOT native disabled) keeps it focusable so AT reads the help.
      expect(btn.getAttribute('aria-disabled')).withContext(`${testid} aria-disabled`).toBe('true');
      expect(btn.hasAttribute('disabled')).withContext(`${testid} not native-disabled`).toBeFalse();
      expect(btn.getAttribute('aria-describedby')).toBe(helpId);
      expect(el.querySelector(`#${helpId}`)).withContext(`${helpId} help span`).not.toBeNull();
    }

    it('renders appeals DECIDE disabled with admin-only helptext on every queue row', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const decide = el.querySelector<HTMLButtonElement>('[data-decide="7"]')!;
      expect(decide.getAttribute('aria-disabled')).toBe('true');
      expect(decide.hasAttribute('disabled')).toBeFalse();
      expect(decide.getAttribute('aria-describedby')).toBe('mc-decide-help-7');
      const help = el.querySelector('[data-decide-help="7"]')!;
      expect(help.textContent).toContain('administrator');
    });

    it('renders general role grant/revoke disabled with helptext (no endpoint)', () => {
      expectDisabledWithHelp('mc-role-grant-disabled', 'mc-role-grant-help');
    });

    it('renders external-client grant disabled with helptext (no endpoint)', () => {
      expectDisabledWithHelp('mc-external-client-disabled', 'mc-external-client-help');
    });

    it('an admin sees real, ENABLED approve/deny controls instead of the disabled decide button', async () => {
      await setup(true); // admin
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(component.isAdmin()).toBeTrue();
      expect(el.querySelector('[data-decide="7"]')).withContext('no disabled decide for an admin').toBeNull();
      const approve = el.querySelector<HTMLButtonElement>('[data-approve="7"]')!;
      const deny = el.querySelector<HTMLButtonElement>('[data-deny="7"]')!;
      expect(approve).withContext('approve control').not.toBeNull();
      expect(deny).withContext('deny control').not.toBeNull();
      expect(approve.hasAttribute('disabled')).toBeFalse();
      expect(deny.hasAttribute('disabled')).toBeFalse();
    });
  });

  // ── ADMIN decide→apply chain (real BFF wiring) ───────────────────────
  describe('admin decide (approve/deny)', () => {
    beforeEach(async () => {
      await setup(true); // admin
    });

    it('approve calls AdminBffService.decide(id, true) and clears any prior error', async () => {
      fixture.detectChanges();
      await component.decide(7, true);
      expect(admin.decide).toHaveBeenCalledWith(7, true);
      expect(component.decideError()).toBe('');
    });

    it('deny calls AdminBffService.decide(id, false)', async () => {
      fixture.detectChanges();
      await component.decide(7, false);
      expect(admin.decide).toHaveBeenCalledWith(7, false);
    });

    it('a failed/degraded decide (null) surfaces an honest error and is NEVER treated as applied', async () => {
      admin.decide.and.resolveTo(null);
      fixture.detectChanges();
      await component.decide(7, true);
      fixture.detectChanges();
      expect(component.decideError()).toContain('NOT applied');
      const el: HTMLElement = fixture.nativeElement;
      const err = el.querySelector('[data-testid="mc-decide-error"]');
      expect(err).withContext('decide error live region').not.toBeNull();
      expect(err?.getAttribute('role')).toBe('alert');
    });

    it('marks the row mid-flight (buttons disabled) while a decide call is outstanding', async () => {
      let resolve!: (v: ModerationRequest | null) => void;
      admin.decide.and.returnValue(new Promise((r) => (resolve = r)));
      fixture.detectChanges();
      const promise = component.decide(7, true);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector<HTMLButtonElement>('[data-approve="7"]')!.disabled).toBeTrue();
      resolve({ ...request, status: 'approved' });
      await promise;
      fixture.detectChanges();
      expect(el.querySelector<HTMLButtonElement>('[data-approve="7"]')!.disabled).toBeFalse();
    });
  });

  // ── accessibleName on the queue target aria-label ───────────────────
  describe('accessibleName usage', () => {
    it('announces the ASCII screenReaderName in the refer aria-label when present', () => {
      moderation$.next([
        { ...request, target: '山田太郎', screenReaderName: 'Yamada Taro' } as ModerationRequest & { screenReaderName: string },
      ]);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      expect(btn.getAttribute('aria-label')).toContain('Yamada Taro');
      // The visible cell keeps the UTF-8 display name.
      expect(el.querySelector('[data-request-id="7"]')!.textContent).toContain('山田太郎');
    });

    it('falls back to the plain target when no screen-reader name exists', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      expect(btn.getAttribute('aria-label')).toContain('evil.example');
    });
  });

  // ── Keyboard operability (WCAG 2.1.1 / 2.1.2 / 2.4.3) ───────────────
  // The console is built entirely from native form controls, so every action
  // is keyboard-actuatable for free (a native <button> fires (click) on Enter
  // AND Space; a native <select>/<input> is arrow/type-operable). These tests
  // LOCK IN that contract so a future refactor to a div/span "button" — which
  // would silently drop keyboard activation — fails CI:
  //  - every actionable control is a focusable native <button> with an explicit
  //    type (so it never accidentally submits its form on Enter);
  //  - the aria-disabled (admin-only/no-endpoint) controls stay IN the tab order
  //    (NOT native-disabled, no negative tabindex) so AT lands on them;
  //  - there is no positive tabindex anywhere (focus order follows the DOM);
  //  - activating a button via a real keyboard-style click drives the BFF.
  describe('keyboard operability', () => {
    /** All controls a moderator actuates — each must be a native, focusable button. */
    const actionButtons = [
      'mc-status-apply',
      'mc-rec-submit',
      'mc-ban-submit',
      'mc-ban-lift',
      'mc-dl-lock',
      'mc-dl-unlock',
      'mc-block',
    ];

    it('renders every action as a native, focusable <button> with an explicit type', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      for (const id of actionButtons) {
        const btn = el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
        expect(btn).withContext(id).not.toBeNull();
        expect(btn.tagName).withContext(`${id} is a native button`).toBe('BUTTON');
        // An explicit type is required: a typeless <button> in a <form> defaults
        // to submit, which would hijack Enter from other controls.
        expect(['submit', 'button']).withContext(`${id} has explicit type`).toContain(btn.type);
        // Native buttons are focusable; nothing pushes them out of the tab order.
        expect(btn.hasAttribute('disabled')).withContext(`${id} not native-disabled`).toBeFalse();
        expect(btn.tabIndex).withContext(`${id} tabbable`).toBeGreaterThanOrEqual(0);
      }
    });

    it('renders the per-row refer control as a native button (Enter/Space activate it)', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.type).toBe('button');
    });

    it('keeps the aria-disabled admin-only controls IN the tab order so AT reads the help', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      for (const id of ['mc-decide', 'mc-role-grant-disabled', 'mc-external-client-disabled']) {
        const btn =
          el.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`) ??
          el.querySelector<HTMLButtonElement>(`[data-decide="7"]`)!;
        expect(btn).withContext(id).not.toBeNull();
        expect(btn.getAttribute('aria-disabled')).withContext(`${id} aria-disabled`).toBe('true');
        // aria-disabled (NOT the native disabled attr) keeps it keyboard-focusable.
        expect(btn.hasAttribute('disabled')).withContext(`${id} not native-disabled`).toBeFalse();
        expect(btn.tabIndex).withContext(`${id} still tabbable`).toBeGreaterThanOrEqual(0);
      }
    });

    it('never uses a positive tabindex (focus order follows the DOM — WCAG 2.4.3)', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const positive = Array.from(el.querySelectorAll<HTMLElement>('[tabindex]')).filter(
        (n) => Number(n.getAttribute('tabindex')) > 0,
      );
      expect(positive.length).withContext('no positive tabindex').toBe(0);
    });

    it('activates the refer button via a keyboard-style click and drives the BFF', () => {
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-refer="7"]')!;
      // A native button dispatches a click for Enter/Space; click() is the DOM
      // equivalent the browser fires, so this proves keyboard activation is wired.
      btn.click();
      expect(bff.refer).toHaveBeenCalledWith(7);
    });

    it('activates the lift and remove-lock buttons via a keyboard-style click', () => {
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      component.domainLockUser = 'bad-user';
      const el: HTMLElement = fixture.nativeElement;
      el.querySelector<HTMLButtonElement>('[data-testid="mc-ban-lift"]')!.click();
      el.querySelector<HTMLButtonElement>('[data-testid="mc-dl-unlock"]')!.click();
      expect(bff.lift).toHaveBeenCalled();
      expect(bff.domainUnlock).toHaveBeenCalled();
    });
  });
});

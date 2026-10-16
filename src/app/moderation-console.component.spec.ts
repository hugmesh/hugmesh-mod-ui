import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideLocationMocks } from '@angular/common/testing';
import { BehaviorSubject } from 'rxjs';
import { ModerationConsoleComponent } from './moderation-console.component';
import {
  BlockFederation,
  BlockResult,
  ModAction,
  ModBffService,
  ModerationRequest,
  PendingReconcile,
  SystemFinding,
} from './mod-bff.service';
import { ModWriteError, ModWriteResult } from './mod-write-error';
import { AdminBffService } from './admin-bff.service';
import { SessionService } from './session.service';
import { MfaService } from './mfa/mfa.service';

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

/** A successful write, in the shape ModBffService now resolves to. */
function ok<T>(value: T): ModWriteResult<T> {
  return { ok: true, value };
}

/**
 * A FAILED write carrying real wire facts. The point of #14: these tests can now
 * distinguish a 403 from a 502 from a dropped connection, exactly as the console
 * must — the old spec could only say `null`.
 */
function failed<T>(
  status: number,
  statusText: string,
  serverMessage: string | null = null,
  stepUpSignal: string | null = null,
): ModWriteResult<T> {
  const body = serverMessage === null ? null : { error: serverMessage };
  return {
    ok: false,
    error: new ModWriteError(
      serverMessage ?? `Http failure response: ${status} ${statusText}`,
      status,
      statusText,
      body,
      serverMessage,
      stepUpSignal,
    ),
  };
}

describe('ModerationConsoleComponent', () => {
  let fixture: ComponentFixture<ModerationConsoleComponent>;
  let component: ModerationConsoleComponent;
  let bff: jasmine.SpyObj<ModBffService>;
  let admin: jasmine.SpyObj<AdminBffService>;
  // The step-up dialog is a child of this component, so its MfaService must be
  // resolvable even in the tests that never open it (hugmesh-mod-ui#1).
  let mfa: jasmine.SpyObj<MfaService>;
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
    bff.refer.and.resolveTo(ok({ ...request, status: 'referred' }));
    bff.recommend.and.resolveTo(ok(request));
    bff.ban.and.resolveTo(ok({ state: 'pending-reconcile' }));
    bff.lift.and.resolveTo(ok({ state: 'restored' }));
    bff.domainLock.and.resolveTo(ok({ state: 'pending-reconcile' }));
    bff.domainUnlock.and.resolveTo(ok({ state: 'cleared' }));

    admin = jasmine.createSpyObj<AdminBffService>('AdminBffService', ['decide']);
    admin.decide.and.resolveTo({ ...request, status: 'approved' });

    mfa = jasmine.createSpyObj<MfaService>('MfaService', ['challenge', 'assertWebauthnOptions']);
    mfa.challenge.and.resolveTo({ ok: true, dark: false, status: 200, data: { mfaSatisfied: true } });

    await TestBed.configureTestingModule({
      imports: [ModerationConsoleComponent],
      providers: [
        { provide: ModBffService, useValue: bff },
        { provide: AdminBffService, useValue: admin },
        { provide: SessionService, useValue: { isAdmin } },
        { provide: MfaService, useValue: mfa },
        // The block result links to its moderation request with a RELATIVE RouterLink
        // (decision 84d), so the console now needs a router in scope.
        provideRouter([]),
        // Following that link must not pushState the real karma page.
        provideLocationMocks(),
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

  it('surfaces a rejected refer honestly, with the status, instead of silently doing nothing', async () => {
    bff.refer.and.resolveTo(failed(409, 'Conflict', 'request 7 is already referred'));
    fixture.detectChanges();
    await component.refer(7);
    fixture.detectChanges();
    expect(component.referError()).toContain('HTTP 409');
    expect(component.referError()).toContain('already referred');
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
      bff.block.and.resolveTo(ok(result));
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
      bff.block.and.resolveTo(ok({ blocked: action, external: 'stubbed' }));
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

    it('surfaces a server rejection as an error carrying the status', async () => {
      bff.block.and.resolveTo(failed(502, 'Bad Gateway'));
      fixture.detectChanges();
      component.target = '@x:y';
      await component.block();
      expect(component.blockError()).toContain('HTTP 502');
    });

    // Decision 84d = A (operator, 2026-09-23, hugmesh-federation-api#7): mod-bff's block
    // body carries a dedicated moderationRequestId (null when no row exists) and, on a
    // Matrix INSTANCE block, a federation {status, moderationRequestId, requestStatus,
    // httpStatus?} object (hugmesh-mod-bff-api#25, merged 8b32057). The console must
    // LINK to that request in the queue and say the federation status plainly, never
    // make the moderator dig the id out of the prose note.
    describe('federation moderation request link + status (decision 84d)', () => {
      const q = <T extends Element = HTMLElement>(sel: string): T | null =>
        (fixture.nativeElement as HTMLElement).querySelector<T>(sel);
      const filed: BlockResult = {
        state: 'pending-reconcile',
        external: 'requested:no-tuwunel-verb',
        blocked: action,
        moderationRequestId: 42,
        federation: { status: 'filed', moderationRequestId: 42, requestStatus: 'referred' },
        note: 'Matrix has no instance-block verb. Filed federation moderation request #42 and referred it.',
      };

      async function blockWith(result: BlockResult | ModWriteResult<BlockResult>): Promise<void> {
        bff.block.and.resolveTo('ok' in result ? result : ok(result));
        fixture.detectChanges();
        component.platform = 'matrix';
        component.scope = 'instance';
        component.target = 'evil.example';
        await component.block();
        fixture.detectChanges();
      }

      it('links a filed request to its row in the moderation queue', async () => {
        await blockWith(filed);
        const link = q<HTMLAnchorElement>('[data-testid="mc-block-request-link"]');
        expect(link).withContext('a link to the filed request').not.toBeNull();
        expect(link!.tagName).toBe('A');
        expect(link!.getAttribute('href')).toContain('#mc-request-42');
        expect(link!.textContent).toContain('#42');
      });

      it('shows the federation status and the request status plainly', async () => {
        await blockWith(filed);
        const fed = q('[data-testid="mc-block-federation"]');
        expect(fed).not.toBeNull();
        expect(fed!.textContent).toContain('filed');
        expect(fed!.textContent).toContain('referred');
        expect(fed!.getAttribute('role')).toBe('status');
      });

      it('reloads the moderation queue so the linked row is actually there', async () => {
        fixture.detectChanges();
        bff.loadModeration.calls.reset();
        component.statusFilter = 'referred';
        await blockWith(filed);
        expect(bff.loadModeration).toHaveBeenCalledOnceWith('referred');
      });

      it('gives every queue row an anchor id the link can land on', () => {
        moderation$.next([{ ...request, id: 42, status: 'referred' }]);
        fixture.detectChanges();
        const row = q('#mc-request-42');
        expect(row).not.toBeNull();
        expect(row!.getAttribute('data-request-id')).toBe('42');
        expect(row!.getAttribute('tabindex')).toBe('-1');
      });

      it('following the link focuses and highlights that queue row', async () => {
        await blockWith(filed);
        moderation$.next([request, { ...request, id: 42, status: 'referred' }]);
        fixture.detectChanges();
        q<HTMLAnchorElement>('[data-testid="mc-block-request-link"]')!.click();
        await fixture.whenStable();
        fixture.detectChanges();
        const row = q('#mc-request-42')!;
        expect(document.activeElement).toBe(row);
        expect(row.classList).toContain('mc-row-highlight');
        expect(q('#mc-request-7')!.classList).not.toContain('mc-row-highlight');
      });

      it('widens the queue filter to "all" when the linked row is filtered out', async () => {
        await blockWith(filed);
        // The current filter shows only 'approved' rows: the referred request is not rendered.
        component.statusFilter = 'approved';
        moderation$.next([{ ...request, status: 'approved' }]);
        bff.loadModeration.calls.reset();
        bff.loadModeration.and.callFake(async () => {
          const rows = [{ ...request, id: 42, status: 'referred' }];
          moderation$.next(rows);
          return rows;
        });
        fixture.detectChanges();
        await component.revealRequest(42);
        // Checked BEFORE the fixture re-renders: the reloaded row only exists (and can
        // only have been focused) because revealRequest() rendered it itself.
        expect(document.activeElement)
          .withContext('focus lands on the row the widened reload just rendered')
          .toBe(q('#mc-request-42'));
        fixture.detectChanges();
        expect(component.statusFilter).toBe('');
        expect(bff.loadModeration).toHaveBeenCalledOnceWith(undefined);
        expect(q('#mc-request-42')).not.toBeNull();
      });

      it('says plainly when the request is still not in this moderator\'s queue', async () => {
        await blockWith(filed);
        moderation$.next([]);
        bff.loadModeration.and.resolveTo([]);
        await component.revealRequest(42);
        fixture.detectChanges();
        expect(q('[data-testid="mc-block-request-missing"]')?.textContent).toContain('#42');
      });

      it('announces an UNAUTHORIZED federation leg as an alert, with no link when nothing was filed', async () => {
        await blockWith({
          ...filed,
          moderationRequestId: null,
          federation: { status: 'unauthorized', moderationRequestId: null, requestStatus: null, httpStatus: 401 },
          note: 'The federation moderation request was NOT filed: federation-api rejected your sign-in token (401).',
        });
        const fed = q('[data-testid="mc-block-federation"]');
        expect(fed).not.toBeNull();
        expect(fed!.textContent).toContain('unauthorized');
        expect(fed!.textContent).toContain('NOT filed');
        expect(fed!.getAttribute('role')).toBe('alert');
        expect(q('[data-testid="mc-block-request-link"]')).toBeNull();
      });

      it('still links a request that was created before an unauthorized refer', async () => {
        await blockWith({
          ...filed,
          moderationRequestId: 43,
          federation: { status: 'unauthorized', moderationRequestId: 43, requestStatus: 'recommended', httpStatus: 401 },
        });
        expect(q('[data-testid="mc-block-federation"]')!.textContent).toContain('unauthorized');
        expect(q('[data-testid="mc-block-request-link"]')!.getAttribute('href')).toContain('#mc-request-43');
      });

      it('renders neither the link nor a federation line for a block with no federation leg', async () => {
        fixture.detectChanges();
        bff.loadModeration.calls.reset();
        await blockWith({ state: 'pending-reconcile', blocked: action, external: 'stubbed', moderationRequestId: null });
        expect(q('[data-testid="mc-block-request-link"]')).toBeNull();
        expect(q('[data-testid="mc-block-federation"]')).toBeNull();
        expect(bff.loadModeration).not.toHaveBeenCalled();
      });

      it('clears the previous link and federation line when the next block FAILS', async () => {
        await blockWith(filed);
        expect(q('[data-testid="mc-block-request-link"]')).not.toBeNull();
        await blockWith(failed<BlockResult>(502, 'Bad Gateway'));
        expect(q('[data-testid="mc-block-request-link"]')).toBeNull();
        expect(q('[data-testid="mc-block-federation"]')).toBeNull();
      });

      it('clears the previous link when the next block files nothing', async () => {
        await blockWith(filed);
        expect(q('[data-testid="mc-block-request-link"]')).not.toBeNull();
        await blockWith({ blocked: action, external: 'stubbed', moderationRequestId: null });
        expect(q('[data-testid="mc-block-request-link"]')).toBeNull();
      });

      // Every status mod-bff's FederationFiling can send gets its own plain sentence, and
      // every leg that did NOT reach administrators is an alert — not only 'unauthorized'.
      const legs: Array<{ fed: BlockFederation; alert: boolean; says: string[] }> = [
        {
          fed: { status: 'filed', moderationRequestId: 42, requestStatus: 'referred' },
          alert: false,
          says: ['request #42 was filed and referred to administrators for a decision.'],
        },
        {
          fed: { status: 'referred-existing', moderationRequestId: 42, requestStatus: 'referred' },
          alert: false,
          says: ['an open recommendation for this domain already existed (#42); it has now been referred'],
        },
        {
          fed: { status: 'existing', moderationRequestId: 42, requestStatus: 'referred' },
          alert: false,
          says: ['request #42 for this domain was already referred to administrators; nothing new was filed.'],
        },
        {
          fed: { status: 'unauthorized', moderationRequestId: 43, requestStatus: 'recommended', httpStatus: 401 },
          alert: true,
          says: ['request #43 was created but NOT referred to administrators', 'refused your sign-in (HTTP 401)'],
        },
        {
          fed: { status: 'error', moderationRequestId: null, requestStatus: null, httpStatus: 502 },
          alert: true,
          says: ['could not be completed (HTTP 502); nothing was filed.', 'still recorded in the audit trail'],
        },
        {
          fed: { status: 'error', moderationRequestId: null, requestStatus: null },
          alert: true,
          says: ['could not be completed (federation-api unreachable or timed out); nothing was filed.'],
        },
        {
          fed: { status: 'error', moderationRequestId: 44, requestStatus: 'recommended', httpStatus: 500 },
          alert: true,
          says: ['request #44 exists but was NOT referred.'],
        },
        {
          fed: { status: 'not-configured', moderationRequestId: null, requestStatus: null },
          alert: true,
          says: ['NOT filed — this deployment has no federation-api client configured for moderation.'],
        },
        {
          fed: { status: 'something-new', moderationRequestId: null, requestStatus: null },
          alert: false,
          says: ['this console does not recognise that status'],
        },
      ];
      for (const { fed, alert, says } of legs) {
        const label = `${fed.status}${fed.moderationRequestId === null ? '' : ' #' + fed.moderationRequestId}`;
        it(`says what a '${label}' federation leg means, as ${alert ? 'an alert' : 'a status'}`, async () => {
          await blockWith({ ...filed, moderationRequestId: fed.moderationRequestId, federation: fed });
          const line = q('[data-testid="mc-block-federation"]');
          expect(line).withContext('the federation status line').not.toBeNull();
          expect(line!.querySelector('strong')?.textContent).toBe(fed.status);
          for (const phrase of says) expect(line!.textContent).toContain(phrase);
          expect(line!.getAttribute('role')).toBe(alert ? 'alert' : 'status');
          expect(line!.getAttribute('aria-live')).toBe(alert ? 'assertive' : 'polite');
          expect(q('[data-testid="mc-block-request-link"]') !== null).toBe(fed.moderationRequestId !== null);
        });
      }

      it('scrolls the linked row into view when the link is followed', async () => {
        const scroll = spyOn(HTMLElement.prototype, 'scrollIntoView');
        await blockWith(filed);
        moderation$.next([request, { ...request, id: 42, status: 'referred' }]);
        fixture.detectChanges();
        q<HTMLAnchorElement>('[data-testid="mc-block-request-link"]')!.click();
        await fixture.whenStable();
        expect(scroll).toHaveBeenCalledOnceWith({ block: 'center' });
        expect(scroll.calls.mostRecent().object as unknown).toBe(q('#mc-request-42'));
      });

      describe('a request that is not in the queue view', () => {
        const rows = () => [request, { ...request, id: 42, status: 'referred' }];
        beforeEach(async () => {
          await blockWith(filed);
          moderation$.next(rows());
          bff.loadModeration.and.callFake(async () => {
            moderation$.next(rows());
            return rows();
          });
          fixture.detectChanges();
        });
        const missing = () => q('[data-testid="mc-block-request-missing"]');

        it('drops the previous highlight instead of leaving the wrong row marked', async () => {
          await component.revealRequest(42);
          fixture.detectChanges();
          expect(q('#mc-request-42')!.classList).toContain('mc-row-highlight');
          await component.revealRequest(99);
          fixture.detectChanges();
          expect(missing()?.textContent).toContain('#99');
          expect(component.highlightedRequestId()).toBeNull();
          expect(fixture.nativeElement.querySelectorAll('.mc-row-highlight').length).toBe(0);
        });

        it('clears the "not in your queue" message when the next block is submitted', async () => {
          await component.revealRequest(99);
          fixture.detectChanges();
          expect(missing()).withContext('precondition: the message is shown').not.toBeNull();
          await blockWith(filed);
          expect(missing()).toBeNull();
        });

        it('clears the "not in your queue" message when a later link DOES land', async () => {
          await component.revealRequest(99);
          fixture.detectChanges();
          expect(missing()).withContext('precondition: the message is shown').not.toBeNull();
          await component.revealRequest(42);
          fixture.detectChanges();
          expect(missing()).toBeNull();
          expect(q('#mc-request-42')!.classList).toContain('mc-row-highlight');
        });
      });
    });

    // Decisions 50/51 (2026-09-18): the static pre-submit copy must not read as
    // offering an immediate effect for either Matrix scope — see moderation-console
    // .component.html's mc-matrix-user-help / mc-matrix-instance-help.
    describe('Matrix-specific pre-submit wording (decisions 50/51)', () => {
      const help = (testId: string): string | null =>
        (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

      it('explains the reversible local-only lock for platform=matrix scope=user', () => {
        component.platform = 'matrix';
        component.scope = 'user';
        fixture.detectChanges();
        const text = help('mc-matrix-user-help');
        expect(text).not.toBeNull();
        expect(text).toContain('REVERSIBLE');
        expect(help('mc-matrix-instance-help')).toBeNull();
      });

      it('explains the recorded request for platform=matrix scope=instance', () => {
        component.platform = 'matrix';
        component.scope = 'instance';
        fixture.detectChanges();
        const text = help('mc-matrix-instance-help');
        expect(text).not.toBeNull();
        expect(text).toContain('REQUEST');
        expect(text).toContain('administrator');
        expect(help('mc-matrix-user-help')).toBeNull();
      });

      it('shows neither Matrix-specific note for platform=mastodon', () => {
        component.platform = 'mastodon';
        component.scope = 'user';
        fixture.detectChanges();
        expect(help('mc-matrix-user-help')).toBeNull();
        expect(help('mc-matrix-instance-help')).toBeNull();
      });
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
      bff.block.and.resolveTo(ok({ blocked: action, external: 'stubbed', note: 'STUBBED' }));
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

    it('surfaces a server rejection with the status and the server\u2019s own message', async () => {
      bff.recommend.and.resolveTo(failed(400, 'Bad Request', 'kind is not in the closed vocabulary'));
      fixture.detectChanges();
      component.recommendTarget = 'x';
      await component.recommend();
      expect(component.recommendError()).toContain('HTTP 400');
      expect(component.recommendError()).toContain('closed vocabulary');
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

    it('reports a bodyless 403 as a refusal and OFFERS the privileged/self rule as a possibility', async () => {
      bff.ban.and.resolveTo(failed(403, 'Forbidden'));
      fixture.detectChanges();
      component.banTarget = 'an-admin';
      await component.ban();
      expect(component.banError()).toContain('HTTP 403');
      expect(component.banError()).toContain('gave no reason');
      expect(component.banError()).toContain('privileged or self target');
    });

    // The fixture message is deliberately NOT a step-up one: since
    // hugmesh-mod-ui#1 a recognised step-up refusal opens the challenge dialog
    // instead of rendering a sentence, so a step-up fixture would no longer be
    // testing what this case is about.
    it('prefers the server\u2019s OWN reason over the privileged/self guess', async () => {
      bff.ban.and.resolveTo(failed(403, 'Forbidden', 'that user is already banned on matrix'));
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.banError()).toContain('that user is already banned on matrix');
      expect(component.banError()).not.toContain('gave no reason');
    });

    // Superseded by hugmesh-mod-ui#1: the console USED to render
    // "cannot complete a step-up yet" for this exact refusal. It now recognises it
    // and offers the inline challenge instead. The step-up wiring has its own
    // describe block below; this keeps the assertion where the ban tests live.
    it('offers the step-up challenge for a signalled refusal rather than a sentence', async () => {
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, 'X-ModBan-StepUp'));
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.pendingStepUp()?.form).toBe('ban');
      expect(component.banError()).toBe('');
    });

    // ...but a step-up signal on a 401 is NOT offered: the session is gone, so a
    // challenge cannot succeed, and "sign in again" is the only correct answer.
    it('does not offer a challenge for a step-up signal on a 401', async () => {
      bff.ban.and.resolveTo(failed(401, 'Unauthorized', null, 'X-ModBan-StepUp'));
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.pendingStepUp()).toBeNull();
      expect(component.banError()).toContain('Sign in again');
      expect(component.banError()).toContain('X-Step-Up-Required: X-ModBan-StepUp');
    });

    // The regression this whole change exists to prevent (#14): a 5xx and a
    // dropped connection must NEVER be explained as a privileged/self target.
    it('does NOT accuse the target when the failure was a server error', async () => {
      bff.ban.and.resolveTo(failed(500, 'Server Error'));
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.banError()).toContain('HTTP 500');
      expect(component.banError()).not.toContain('privileged or self target');
      expect(component.banError()).toContain('check the audit trail');
    });

    it('reports an UNKNOWN fate (not a rejection) when no response arrived', async () => {
      bff.ban.and.resolveTo(failed(0, ''));
      fixture.detectChanges();
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.banError()).toContain('NO response');
      expect(component.banError()).toContain('may or may not have been applied');
      expect(component.banError()).not.toContain('privileged or self target');
    });

    it('surfaces the degraded note when the admin-bff breaker is open', async () => {
      bff.ban.and.resolveTo(ok({ state: 'pending-reconcile', degraded: 'breaker-open' }));
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
      bff.ban.and.resolveTo(failed(403, 'Forbidden'));
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

    it('reports a rejected lock with its status, offering the privileged/self rule as a possibility', async () => {
      bff.domainLock.and.resolveTo(failed(403, 'Forbidden'));
      fixture.detectChanges();
      component.domainLockUser = 'a-mod';
      await component.domainLock();
      expect(component.domainLockError()).toContain('HTTP 403');
      expect(component.domainLockError()).toContain('privileged or self target');
    });

    it('does NOT accuse the target when a domain-lock fails for an expired session', async () => {
      bff.domainLock.and.resolveTo(failed(401, 'Unauthorized'));
      fixture.detectChanges();
      component.domainLockUser = 'bad-user';
      await component.domainLock();
      expect(component.domainLockError()).toContain('HTTP 401');
      expect(component.domainLockError()).toContain('Sign in again');
      expect(component.domainLockError()).not.toContain('privileged or self target');
    });
  });

  // ── DISABLED + helptext (V7: no mod-bff endpoint) ───────────────────
  /**
   * The cross-user DENY steps in `e2e/features/steps/moderation-steps.ts`
   * (`expectDeniedAtDenyStatus`) assert a REGEX against the announced text — and
   * they can be checked nowhere else: those scenarios are `@cluster`, ship dark,
   * and neither this host nor CI has Playwright installed. So the regex is
   * mirrored here and run against the REAL component output.
   *
   * <p>The invariant is the one `e2e/features/cross-user/mod-isolation.feature`
   * documents for itself: the mod-bff "returns 403/404 (fail-closed)", and its own
   * API-layer scenarios assert `403 or 404` for exactly these targets. An earlier
   * revision of the step pinned 403 alone, which would have failed the whole
   * scenario on the 404 branch of the contract.
   *
   * <p>If you change the sentence `describeWriteFailure` renders, change BOTH —
   * this block is the only thing that will tell you.
   */
  describe('e2e cross-user DENY step regex (mirrored: nothing else can run it)', () => {
    const deniedAt = (action: string) =>
      new RegExp(`the ${action} was (refused|not applied) \u2014 http (403|404)\\b`);
    const OLD_ACCUSATION = /was rejected \u2014 you cannot/;

    it('matches a 403 and a 404 ban refusal, with and without a server reason', async () => {
      fixture.detectChanges();
      for (const result of [
        failed<PendingReconcile>(403, 'Forbidden'),
        failed<PendingReconcile>(404, 'Not Found'),
        failed<PendingReconcile>(403, 'Forbidden', 'target is a moderator'),
        failed<PendingReconcile>(404, 'Not Found', 'no such user'),
        // What an HTTP/2 deployment actually delivers: no reason phrase on the
        // wire, so Angular's XHR backend substitutes 'OK' on the error too.
        failed<PendingReconcile>(403, 'OK'),
      ]) {
        bff.ban.and.resolveTo(result);
        component.banTarget = 'an-admin';
        await component.ban();
        const text = component.banError().toLowerCase();
        expect(text).withContext(text).toMatch(deniedAt('ban'));
        expect(text).withContext(text).not.toMatch(OLD_ACCUSATION);
      }
    });

    it('matches a 403 and a 404 domain-lock refusal', async () => {
      fixture.detectChanges();
      for (const result of [
        failed<PendingReconcile>(403, 'Forbidden'),
        failed<PendingReconcile>(404, 'Not Found'),
        failed<PendingReconcile>(403, 'OK'),
      ]) {
        bff.domainLock.and.resolveTo(result);
        component.domainLockUser = 'a-mod';
        await component.domainLock();
        const text = component.domainLockError().toLowerCase();
        expect(text).withContext(text).toMatch(deniedAt('domain-lock'));
        expect(text).withContext(text).not.toMatch(OLD_ACCUSATION);
      }
    });

    it('renders the alert in the role=alert region the step locates', async () => {
      bff.ban.and.resolveTo(failed<PendingReconcile>(403, 'Forbidden'));
      fixture.detectChanges();
      component.banTarget = 'an-admin';
      await component.ban();
      fixture.detectChanges();
      // The region is @if-gated on banError(), so it only exists once a write
      // has actually failed — which is the state the e2e step observes.
      const alert: HTMLElement | null = fixture.nativeElement.querySelector('[data-testid="mc-ban-error"]');
      expect(alert).withContext('mc-ban-error must be rendered for the e2e locator').not.toBeNull();
      expect(alert!.getAttribute('role')).toBe('alert');
      expect(alert!.getAttribute('aria-live')).toBe('assertive');
      expect((alert!.textContent ?? '').toLowerCase()).toMatch(deniedAt('ban'));
    });
  });

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
  /**
   * hugmesh-mod-ui#1 — the inline MFA step-up, wired but INERT.
   *
   * The INERT half is pinned first and deliberately: against the denial
   * hugmesh-mod-bff-api actually sends today (a bare @PreAuthorize 403 with no
   * body and no X-Step-Up-Required header) nothing here may open a dialog. The
   * rest of the suite then exercises the wiring against the signal the platform
   * WILL send, so the UI half is reviewable before the server half exists.
   */
  describe('MFA step-up (hugmesh-mod-ui#1)', () => {
    /** The signal admin-bff stamps; mod-bff sends none of this yet. */
    const SIGNAL = 'X-ImageGen-StepUp';

    function dialogs(): NodeListOf<HTMLElement> {
      return fixture.nativeElement.querySelectorAll('[data-testid="mfa-stepup-dialog"]');
    }

    it('does NOT open the dialog for the bare 403 mod-bff sends today', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden'));
      component.banTarget = 'bad-user';
      await component.ban();
      fixture.detectChanges();
      expect(component.pendingStepUp()).toBeNull();
      expect(dialogs().length).toBe(0);
      // ...and the ordinary honest sentence is still what the moderator sees.
      expect(component.banError()).toContain('HTTP 403');
    });

    it('does NOT open the dialog for the privileged/self-target refusal', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', 'you cannot ban a moderator or administrator'));
      component.banTarget = 'a-mod';
      await component.ban();
      expect(component.pendingStepUp()).toBeNull();
      expect(component.banError()).toContain('you cannot ban a moderator');
    });

    it('opens the dialog under the BAN form only, once the denial carries the signal', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.ban();
      fixture.detectChanges();
      expect(component.pendingStepUp()?.form).toBe('ban');
      expect(dialogs().length).toBe(1);
      // The refusal sentence is replaced by the dialog, not stacked under it.
      expect(component.banError()).toBe('');
    });

    it('retries the SAME snapshot after a step-up, even if the form was edited meanwhile', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = '@bad:evil.example';
      component.banReason = 'abuse';
      await component.ban();
      expect(component.pendingStepUp()).not.toBeNull();

      // The moderator retypes the field while hunting for their authenticator.
      component.banTarget = 'someone-else';
      bff.ban.calls.reset();
      bff.ban.and.resolveTo(ok({ state: 'pending-reconcile' }));
      await component.stepUpSatisfied();

      expect(bff.ban).toHaveBeenCalledWith(
        jasmine.objectContaining({ target: '@bad:evil.example', reason: 'abuse' }),
      );
      expect(component.pendingStepUp()).toBeNull();
      expect(component.banNote()).toContain('pending reconcile');
    });

    it('retries a LIFT as a lift, not as a ban', async () => {
      fixture.detectChanges();
      bff.lift.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.lift();
      bff.lift.and.resolveTo(ok({ state: 'restored' }));
      await component.stepUpSatisfied();
      expect(bff.lift).toHaveBeenCalledTimes(2);
      expect(bff.ban).not.toHaveBeenCalled();
    });

    it('says plainly that NOTHING was applied when the moderator cancels', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.ban();
      bff.ban.calls.reset();
      component.stepUpDismissed();
      fixture.detectChanges();
      expect(bff.ban).not.toHaveBeenCalled();
      expect(component.pendingStepUp()).toBeNull();
      expect(component.banError()).toContain('NOT performed');
      expect(component.banError()).toContain('Nothing was changed');
      expect(dialogs().length).toBe(0);
    });

    it('opens under the DOMAIN-LOCK form and retries that role/user pair', async () => {
      fixture.detectChanges();
      bff.domainLock.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.domainLockRole = 'ROLE_MASTODON_DOMAINLOCKED';
      component.domainLockUser = 'bad-user';
      component.domainLockReason = 'evasion';
      await component.domainLock();
      expect(component.pendingStepUp()?.form).toBe('domainLock');

      bff.domainLock.calls.reset();
      bff.domainLock.and.resolveTo(ok({ state: 'pending-reconcile' }));
      await component.stepUpSatisfied();
      expect(bff.domainLock).toHaveBeenCalledWith('ROLE_MASTODON_DOMAINLOCKED', 'bad-user', {
        reason: 'evasion',
      });
    });

    it('retries a domain-UNLOCK as an unlock', async () => {
      fixture.detectChanges();
      bff.domainUnlock.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.domainLockUser = 'bad-user';
      await component.domainUnlock();
      bff.domainUnlock.and.resolveTo(ok({ state: 'cleared' }));
      await component.stepUpSatisfied();
      expect(bff.domainUnlock).toHaveBeenCalledTimes(2);
      expect(bff.domainLock).not.toHaveBeenCalled();
    });

    it('opens under the BLOCK form and retries the same block snapshot', async () => {
      fixture.detectChanges();
      bff.block.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.platform = 'mastodon';
      component.scope = 'instance';
      component.target = 'evil.example';
      await component.block();
      expect(component.pendingStepUp()?.form).toBe('block');

      bff.block.calls.reset();
      const blocked: BlockResult = { blocked: action, external: 'ok', note: 'Recorded.' };
      bff.block.and.resolveTo(ok(blocked));
      await component.stepUpSatisfied();
      expect(bff.block).toHaveBeenCalledWith({
        platform: 'mastodon', scope: 'instance', target: 'evil.example', reason: undefined,
      });
      expect(component.blockNote()).toContain('Recorded.');
    });

    it('recognises the legacy phrase leg too, so an unsignalled body still works', async () => {
      fixture.detectChanges();
      bff.block.and.resolveTo(failed(403, 'Forbidden', 'block requires step-up re-authentication'));
      component.target = 'evil.example';
      await component.block();
      expect(component.pendingStepUp()?.form).toBe('block');
    });

    it('surfaces a step-up refusal that repeats after the challenge, instead of looping', async () => {
      fixture.detectChanges();
      bff.block.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.target = 'evil.example';
      await component.block();
      await component.stepUpSatisfied();
      // The write was refused again for the same reason: the dialog re-opens rather
      // than the console claiming success. One re-open per attempt, never a spin.
      expect(component.pendingStepUp()?.form).toBe('block');
      expect(bff.block).toHaveBeenCalledTimes(2);
    });

    it('does nothing when satisfied/dismissed fire with no pending write', async () => {
      fixture.detectChanges();
      await component.stepUpSatisfied();
      component.stepUpDismissed();
      expect(component.blockError()).toBe('');
      expect(component.banError()).toBe('');
      expect(component.domainLockError()).toBe('');
    });

    /*
     * A SECOND stalled write must never silently displace the first. The dialog is
     * inline, not modal, so every other form on the console stays live while one is
     * stalled -- before this, offerStepUp() overwrote pendingStepUp unconditionally
     * and the first write's retry was lost with nothing on screen saying so.
     */
    it('refuses a second challenge instead of dropping the first, and names the open one', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.ban();
      expect(component.pendingStepUp()?.form).toBe('ban');

      bff.block.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.target = 'evil.example';
      await component.block();
      fixture.detectChanges();

      // The BAN keeps the dialog -- it is not torn out from under a live ceremony.
      expect(component.pendingStepUp()?.form).toBe('ban');
      expect(dialogs().length).toBe(1);
      // ...and the BLOCK form says so in words, naming what to finish first.
      expect(component.blockError()).toContain('NOT performed');
      expect(component.blockError()).toContain('already open');
      expect(component.blockError()).toContain('ban');
      expect(component.blockNote()).toBe('');
    });

    it('still retries the FIRST write after a refused second challenge', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.ban();
      bff.block.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.target = 'evil.example';
      await component.block();

      bff.ban.calls.reset();
      bff.ban.and.resolveTo(ok({ state: 'pending-reconcile' }));
      await component.stepUpSatisfied();

      // The retry that survived is the BAN's -- the block never took its place.
      expect(bff.ban).toHaveBeenCalledTimes(1);
      expect(bff.ban).toHaveBeenCalledWith(jasmine.objectContaining({ target: 'bad-user' }));
      expect(bff.block).toHaveBeenCalledTimes(1);
      expect(component.pendingStepUp()).toBeNull();
    });

    /*
     * When the dialog closed because every /bff/mfa/* call answered 503, the
     * deployment has MFA off and NO retry from this console can ever succeed --
     * so the moderator must be told to escalate, not to try again.
     */
    it('tells the moderator to escalate, not retry, when the dialog closed dark', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.ban();
      component.stepUpDismissed(true);
      expect(component.banError()).toContain('NOT performed');
      expect(component.banError()).toContain('not enabled on this deployment');
      expect(component.banError()).toContain('ask an administrator');
      expect(component.banError()).not.toContain('retry when you can confirm');
    });

    it('still says "retry when you can confirm" on a plain cancel', async () => {
      fixture.detectChanges();
      bff.ban.and.resolveTo(failed(403, 'Forbidden', null, SIGNAL));
      component.banTarget = 'bad-user';
      await component.ban();
      component.stepUpDismissed(false);
      expect(component.banError()).toContain('retry when you can confirm');
      expect(component.banError()).not.toContain('not enabled on this deployment');
    });
  });
});

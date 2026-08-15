import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { ModDirectoryService } from './mod-directory.service';
import { ModAction, ModBffService, ModerationRequest, SystemFinding } from './mod-bff.service';

/**
 * ModDirectoryService — the moderator console's suggestion pool.
 *
 * The behaviour worth pinning: candidates come from the three ALREADY domain-scoped
 * mod-bff caches, they are deduped with findings taking precedence (the most likely next
 * target), and they track the caches live so a queue refresh updates the pickers.
 */
describe('ModDirectoryService', () => {
  let moderation$: BehaviorSubject<ModerationRequest[]>;
  let audit$: BehaviorSubject<ModAction[]>;
  let findings$: BehaviorSubject<SystemFinding[]>;
  let service: ModDirectoryService;

  const finding = (subject: string): SystemFinding => ({
    id: 1, reporter: '@system', subject, surface: 'profile-avatar', disposition: 'flagged',
    classification: null, confidence: null, policyHit: null, perceptualHash: null,
    status: 'held', reviewer: null, ts: '2026-06-06T00:00:00Z', domain: 'default',
  });
  const request = (target: string): ModerationRequest => ({
    id: 7, requester: 'user:alice', kind: 'user-removal', target, reason: null,
    status: 'recommended', modReferrer: null, adminDecider: null, ts: '2026-06-06T00:00:00Z',
  });
  const action = (target: string): ModAction => ({
    id: 'a1', actor: 'mod:bob', action: 'ban', platform: 'matrix', target, reason: null,
    result: 'ok', ts: '2026-06-06T00:00:00Z',
  });

  beforeEach(() => {
    moderation$ = new BehaviorSubject<ModerationRequest[]>([]);
    audit$ = new BehaviorSubject<ModAction[]>([]);
    findings$ = new BehaviorSubject<SystemFinding[]>([]);

    TestBed.configureTestingModule({
      providers: [{
        provide: ModBffService,
        useValue: {
          moderation: moderation$.asObservable(),
          audit: audit$.asObservable(),
          findings: findings$.asObservable(),
        },
      }],
    });
    service = TestBed.inject(ModDirectoryService);
  });

  it('returns nothing for a blank query', () => {
    findings$.next([finding('@carol:brandx.example')]);
    expect(service.search('', 8)).toEqual([]);
    expect(service.search('   ', 8)).toEqual([]);
  });

  it('suggests subjects from the finding queue', () => {
    findings$.next([finding('@carol:brandx.example')]);
    expect(service.search('car', 8)).toEqual([
      { target: '@carol:brandx.example', source: 'system finding' },
    ]);
  });

  it('suggests targets from the moderation queue and the audit trail', () => {
    moderation$.next([request('@dave:brandx.example')]);
    audit$.next([action('@erin:brandx.example')]);
    expect(service.search('dave', 8).map(s => s.source)).toEqual(['moderation queue']);
    expect(service.search('erin', 8).map(s => s.source)).toEqual(['audit trail']);
  });

  it('dedupes across sources, with the finding queue winning', () => {
    findings$.next([finding('@carol:brandx.example')]);
    audit$.next([action('@carol:brandx.example')]);
    const hits = service.search('carol', 8);
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe('system finding');
  });

  it('skips the @system pseudo-reporter — it is not a moderatable account', () => {
    audit$.next([action('@system')]);
    expect(service.search('system', 8)).toEqual([]);
  });

  it('matches case-insensitively and ranks prefix hits first', () => {
    audit$.next([action('@notal:x.example'), action('@alice:x.example')]);
    expect(service.search('@AL', 8).map(s => s.target)).toEqual(['@alice:x.example']);
    expect(service.search('al', 8).map(s => s.target))
      .toEqual(['@alice:x.example', '@notal:x.example']);
  });

  it('caps the returned rows', () => {
    audit$.next(Array.from({ length: 20 }, (_, i) => action(`@user${i}:x.example`)));
    expect(service.search('user', 3).length).toBe(3);
  });

  it('tracks a cache refresh live, so a reloaded queue updates the pickers', () => {
    expect(service.search('frank', 8)).toEqual([]);
    audit$.next([action('@frank:x.example')]);
    expect(service.search('frank', 8).length).toBe(1);
  });
});

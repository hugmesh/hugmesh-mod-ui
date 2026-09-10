import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ModBffService, SystemFinding } from './mod-bff.service';
import { describeWriteFailure } from './mod-write-error';
import { accessibleName } from './accessible-name';

/**
 * System-findings panel (ROLE_MOD / ROLE_ADMIN only, route-guarded). The companion
 * AUTOMATED queue to the human moderation console: it lists the edge-AI
 * avatar/image moderation findings filed by user-bff's pre-publish vision check
 * (user-bff → federation-api → mod-bff) and lets a moderator RESOLVE each held row.
 *
 *  WIRED (mod-bff endpoints, PR #54 — MOD/ADMIN-gated):
 *  - the finding QUEUE (GET /bff/mod/findings), with a status filter
 *    (held | dismissed | actioned, or all) — issuer-domain-scoped server-side, so
 *    a per-brand mod sees only their own brand's findings;
 *  - a per-row RESOLVE action pair (POST /bff/mod/findings/{id}/resolve?actioned=<bool>):
 *    "Confirm" (actioned=true — the mod confirmed it bad / took action) and
 *    "Dismiss" (actioned=false — the mod cleared it). The reviewer is recorded
 *    server-side from the forwarded JWT subject; a cross-domain id is 404'd
 *    server-side (the cross-tenant boundary is enforced by the API, the source of
 *    truth — this UI only mirrors it).
 *
 * All data access goes through {@link ModBffService}, whose {@code findings$}
 * BehaviorSubject is the one source of truth; this component subscribes it into a
 * signal. Resolving a row optimistically refreshes the queue (poll-on-action: there
 * is NO mod-facing SSE on the platform), so a row that was held flips to its new
 * disposition (or drops out of a held-only filter) without a manual reload. The
 * resolve buttons disable once a row is no longer {@code held}.
 */
@Component({
  selector: 'hug-findings-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './findings-panel.component.html',
  styleUrl: './findings-panel.component.scss',
})
export class FindingsPanelComponent implements OnInit {
  private readonly bff = inject(ModBffService);
  private readonly destroyRef = inject(DestroyRef);

  readonly findings = signal<SystemFinding[]>([]);

  // ── Finding status filter (the closed federation status vocab) ─────
  readonly statusFilters: { value: string; label: string }[] = [
    { value: '', label: 'all' },
    { value: 'held', label: 'held (awaiting review)' },
    { value: 'actioned', label: 'actioned' },
    { value: 'dismissed', label: 'dismissed' },
  ];
  statusFilter = '';

  /** Outcome of the last resolve, announced politely. Empty = nothing to say. */
  readonly resolveNote = signal('');

  ngOnInit(): void {
    // Bridge the root-provided BehaviorSubject into a signal, and unsubscribe on
    // destroy — repeated navigation into this routed remote would otherwise
    // accumulate subscriptions that keep set()-ing a destroyed component's
    // signal (matches ModerationConsoleComponent's takeUntilDestroyed bridge).
    this.bff.findings.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((f) => this.findings.set(f));
    void this.bff.loadFindings();
  }

  /** Reload the queue with the selected status filter (blank = all). */
  async applyStatusFilter(): Promise<void> {
    await this.bff.loadFindings(this.statusFilter || undefined);
  }

  /**
   * The accessible (aria-label) name for a finding's subject — announces an ASCII
   * screenReaderName when present (the subject may render a non-ASCII display
   * name). accessibleName degrades to the plain subject when none is available.
   */
  subjectName(f: SystemFinding): string {
    return accessibleName(f.subject, (f as { screenReaderName?: string | null }).screenReaderName);
  }

  /** Only a HELD finding can be resolved; once actioned/dismissed it is terminal. */
  isHeld(f: SystemFinding): boolean {
    return f.status === 'held';
  }

  /** Confirm a finding as bad (actioned=true) — the mod took action. */
  async confirm(id: number): Promise<void> {
    await this.resolve(id, true, 'Finding confirmed (actioned)');
  }

  /** Dismiss / clear a finding (actioned=false) — the mod cleared it. */
  async dismiss(id: number): Promise<void> {
    await this.resolve(id, false, 'Finding dismissed (cleared)');
  }

  /**
   * Resolve one finding and report the outcome honestly. The failure branch used
   * to assert one reason ("it may already be resolved, or belong to another
   * domain") for EVERY failure, because {@code resolveFinding} collapsed them all
   * to {@code null}; that reason is now the 404/403 HINT, offered only when the
   * server gave none of its own. See hugmesh-mod-ui#14.
   */
  private async resolve(id: number, actioned: boolean, okMessage: string): Promise<void> {
    const result = await this.bff.resolveFinding(id, actioned);
    this.resolveNote.set(
      result.ok
        ? `${okMessage}. The queue has been refreshed.`
        : describeWriteFailure(
            result.error,
            `resolve of finding #${id}`,
            'it may already be resolved, or belong to another domain.',
          ),
    );
  }
}

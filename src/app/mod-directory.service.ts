import { Injectable, inject } from '@angular/core';
import { ModBffService } from './mod-bff.service';

/** One typeahead row: the identifier a target field will submit, plus where it came from. */
export interface ModTargetSuggestion {
  /** The exact string written into the field on commit (a username or a full @user:host). */
  target: string;
  /** Human label for WHERE this candidate was seen — "system finding", "audit trail", … */
  source: string;
}

/**
 * The moderator console's user-suggestion source.
 *
 * <h3>Why this is not a directory search</h3>
 * admin-ui's picker calls {@code GET /bff/admin/users/search}. A MOD cannot: the admin-bff
 * security chain gates the WHOLE {@code /bff/admin/**} prefix on
 * {@code hasAnyRole("ADMIN","SUPERADMIN")} (hugmesh-admin-bff-api
 * {@code config/SecurityConfig.java}, the {@code /bff/admin/**} rule), so a moderator's
 * token is rejected at the path gate before any controller runs. mod-bff-api exposes no
 * user-directory endpoint of its own (see its {@code ModController} — moderation queue,
 * ban/lift, domain-lock, block, findings, audit; no user list).
 *
 * <p>So the suggestions here are drawn from what mod-bff ALREADY returns to this moderator:
 * the system-finding queue, the federation moderation queue, and the local audit trail.
 * That is not a consolation prize — it is the set a moderator actually acts on. A mod reads
 * a finding about someone and then bans them; the identifier they need is on screen already,
 * and retyping a full {@code @user:instance.example} by hand is exactly the friction being
 * removed.
 *
 * <h3>Why filtering here is not an enumeration hole</h3>
 * The distinction matters, because the admin-side rule is the opposite. There, filtering a
 * full directory in the browser would be a hole — the server would have shipped rows the
 * caller should never see. Here there is no larger set: every list this service reads was
 * ALREADY domain-scoped server-side before it was sent —
 * {@code GET /bff/mod/audit} applies a {@code WHERE domain} predicate from the validated
 * {@code DOMAIN_<x>} authority, and {@code GET /bff/mod/findings} is domain-scoped by
 * federation-api from the forwarded JWT issuer. This only re-orders and narrows rows the
 * moderator has already been given.
 */
@Injectable({ providedIn: 'root' })
export class ModDirectoryService {
  private readonly bff = inject(ModBffService);

  /** Every candidate currently known, newest-source-first, deduped by target string. */
  private candidates: ModTargetSuggestion[] = [];

  constructor() {
    // Each cache is a BehaviorSubject, so these fire immediately with whatever is loaded and
    // again on every refresh — the suggestion pool tracks the console without its own polling.
    this.bff.findings.subscribe(() => this.rebuild());
    this.bff.moderation.subscribe(() => this.rebuild());
    this.bff.audit.subscribe(() => this.rebuild());
  }

  /**
   * Candidates matching `q`, best-match first, capped.
   *
   * @param q - the typed fragment; blank returns `[]` (the "keep typing" state).
   * @param limit - maximum rows to return.
   */
  search(q: string, limit: number): ModTargetSuggestion[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return this.candidates
      .filter(c => c.target.toLowerCase().includes(needle))
      // Prefix hits first (almost always what was meant), then alphabetical so the list is
      // stable between keystrokes rather than reshuffling under the user's cursor.
      .sort((a, b) => {
        const ap = a.target.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.target.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp || a.target.localeCompare(b.target);
      })
      .slice(0, limit);
  }

  /** Recompute the deduped candidate pool from the three cached, domain-scoped surfaces. */
  private rebuild(): void {
    const seen = new Map<string, ModTargetSuggestion>();
    const add = (raw: string | null | undefined, source: string) => {
      const target = (raw ?? '').trim();
      // Skip blanks and the '@system' pseudo-reporter — neither is a moderatable account.
      if (!target || target === '@system') return;
      // First source wins, so the order of the three loops below is the precedence order.
      if (!seen.has(target)) seen.set(target, { target, source });
    };

    // Findings first: the subject of a held finding is the single most likely next target.
    for (const f of this.snapshot(this.bff.findings)) add(f.subject, 'system finding');
    // Then queue rows (a recommendation names the account someone already flagged).
    for (const r of this.snapshot(this.bff.moderation)) add(r.target, 'moderation queue');
    // Then the audit trail — anyone previously acted on in this domain.
    for (const a of this.snapshot(this.bff.audit)) add(a.target, 'audit trail');

    this.candidates = [...seen.values()];
  }

  /**
   * Read the current value out of a BehaviorSubject-backed Observable. The service exposes
   * them as plain `Observable` (deliberately — callers must not push onto them), so the only
   * way to read the current value is a synchronous subscribe, which a BehaviorSubject
   * satisfies immediately.
   */
  private snapshot<T>(source: { subscribe: (fn: (v: T[]) => void) => { unsubscribe(): void } }): T[] {
    let out: T[] = [];
    source.subscribe(v => { out = v ?? []; }).unsubscribe();
    return out;
  }
}

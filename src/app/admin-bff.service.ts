import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ModBffService, ModerationRequest } from './mod-bff.service';

/**
 * Talks to hugmesh-admin-bff-api's {@code POST
 * /bff/admin/moderation/{id}/decide?approve=<bool>} — the ADMIN-only decide
 * action for a referred moderation request. Shown only to callers for whom
 * {@code SessionService.isAdmin} is true (the moderation console is MOD/ADMIN
 * route-guarded, and a mod never decides — see {@code ModerationConsoleComponent}).
 *
 * <p>admin-bff-api is a DIFFERENT service than hugmesh-mod-bff-api, so unlike
 * {@link ModBffService} (which delegates to the generated ng-openapi-gen client
 * built from the mod-bff-api spec) this is a hand-rolled {@link HttpClient} call
 * to the same-origin {@code /bff/admin/**} path — mirroring the convention the
 * Matrix/Mastodon social remotes use for their own admin-bff decide wiring. The
 * global {@code authInterceptor} (wired in {@code bootstrap.ts}) attaches the
 * HttpOnly {@code bff_} session cookie to every outgoing {@link HttpClient}
 * request regardless of path, so no extra auth wiring is needed here; the
 * gateway's {@code BffCookieToBearerWebFilter} turns it into the caller's own
 * bearer server-side, so admin-bff-api (and the federation-api it proxies to)
 * authorise + domain-scope the decision as the ORIGINAL admin, never a service
 * identity.
 *
 * <p>Mirrors the {@link ModBffService} contract: a failed decide resolves to
 * {@code null} (never throws, never fakes success) so the console can render an
 * honest error and leave the row's rendered status untouched. A successful
 * decide refreshes the (mod-tier shared) moderation queue so the new status
 * renders everywhere the row is shown.
 */
@Injectable({ providedIn: 'root' })
export class AdminBffService {
  private readonly http = inject(HttpClient);
  private readonly modBff = inject(ModBffService);

  /**
   * POST /bff/admin/moderation/{id}/decide?approve=<bool>. An approved
   * {@code user-removal} is auto-applied downstream (federation-api) as an
   * active kill-switch override; a denied re-decision rearms it.
   */
  async decide(id: number, approve: boolean): Promise<ModerationRequest | null> {
    const decided = await firstValueFrom(
      this.http.post<ModerationRequest>(`/bff/admin/moderation/${id}/decide?approve=${approve}`, {}),
    ).catch(() => null as ModerationRequest | null);
    if (!decided) return null;
    await this.modBff.loadModeration();
    return decided;
  }
}

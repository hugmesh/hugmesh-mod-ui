import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ChallengeFactor, MfaResult, WebAuthnOptions } from './mfa.types';

/**
 * The STEP-UP half of the shared {@code /bff/mfa/*} contract — the two calls the
 * moderation console's inline challenge dialog needs, and nothing else.
 *
 * <h2>Why this remote may call {@code /bff/mfa/**} at all</h2>
 * This is the surprising part, so it is written down with the evidence.
 * hugmesh-mod-bff-api does NOT serve {@code /bff/mfa/**}: it depends on
 * {@code hugmesh-commons} only (its {@code pom.xml} has no
 * {@code hugmesh-auth-core}), and auth-core is where
 * {@code MfaChallengeController} ({@code @RequestMapping("/bff/mfa/challenge")})
 * and {@code MfaEnrollmentController} ({@code @RequestMapping("/bff/mfa")}) live.
 * The calls below still work, same-origin, because of two measured facts:
 *
 * <ol>
 *   <li><b>Routing.</b> The fe-gateway route table
 *       (hugmesh-generator {@code specs/cluster/apps/20-gateway-fe.yaml}) declares
 *       the specific prefixes first — {@code /bff/mod/**}, {@code /bff/user/**},
 *       {@code /bff/forum/**}, {@code /bff/wiki/**}, {@code /bff/mesh/**}, … —
 *       and ends with a {@code /bff/**} catch-all pointing at
 *       {@code hugmesh-admin-bff-api} (:434-436). There is NO
 *       {@code /bff/mfa/**} row, so a {@code /bff/mfa/challenge} lands on that
 *       catch-all and reaches admin-bff, which DOES carry auth-core.</li>
 *   <li><b>Access.</b> {@code gateway_route_access}
 *       ({@code specs/cluster/manifests/route-access/initdb/20-schema.sql}) has no
 *       {@code /bff/mfa} row either, so
 *       {@code GatewayRouteAccessService.decide()} returns {@code NO_RULE}
 *       (":185 — ungoverned path"), and {@code GatewayRouteAccessFilter} FORWARDS
 *       a {@code NO_RULE} on the gateway's coarse {@code authenticated()} floor
 *       (its class doc, :68). A plain ROLE_MOD therefore reaches the challenge —
 *       it does not need the ADMIN/SUPERADMIN bypass that lets admin-ui through.
 *       Nor does auth-core add a role gate: {@code MfaChallengeController} is
 *       {@code authenticated()} only.</li>
 * </ol>
 *
 * <p>Both facts are CONFIGURATION of another repo, not a contract this remote
 * owns, so they are stated here to be re-checked rather than assumed. If a
 * {@code /bff/mfa/**} route-access row is ever added without ROLE_MOD, this
 * dialog stops working for exactly the role it exists for — and the failure is a
 * gateway 403, which the dialog reports as "that did not verify", not as a
 * routing problem.
 *
 * <h2>Transport</h2>
 * Hand-rolled {@link HttpClient} against a same-origin path, exactly like
 * {@code AdminBffService} — this remote's existing precedent for calling a BFF
 * other than mod-bff (the generated ng-openapi-gen client under
 * {@code src/app/api} is built from the mod-bff spec and cannot express these
 * paths). The global {@code authInterceptor} sets {@code withCredentials} on
 * every HttpClient request, so the HttpOnly {@code bff_} cookie rides along and
 * the gateway's {@code BffCookieToBearerWebFilter} turns it into the caller's own
 * bearer server-side. The browser never holds a bearer, and this service never
 * sends a subject — the owner is always the authenticated session.
 *
 * <h2>Ships dark</h2>
 * Every {@code /bff/mfa/*} endpoint answers 503 while
 * {@code app.casdoor.mfa.enabled=false} (today's default). Each method maps that
 * to {@code dark} so the dialog can say "not enabled yet" instead of showing an
 * error. Nothing here ever throws.
 */
@Injectable({ providedIn: 'root' })
export class MfaService {
  private readonly http = inject(HttpClient);

  /** The status every {@code /bff/mfa/*} endpoint returns while the feature is dark. */
  private static readonly DARK_STATUS = 503;

  /**
   * Request a WebAuthn assertion challenge for step-up — feed the options to
   * {@code navigator.credentials.get()} and submit the result via {@link challenge}.
   */
  assertWebauthnOptions(): Promise<MfaResult<WebAuthnOptions>> {
    return this.post<WebAuthnOptions>('/bff/mfa/assert/webauthn/options');
  }

  /**
   * Satisfy an MFA step-up with a TOTP code, a recovery code, or a WebAuthn
   * assertion. {@code credential} is the 6-digit code, the recovery code, or the
   * {@code navigator.credentials.get()} response JSON string.
   *
   * <p>On success admin-bff stamps the caller's own {@code bff_} session as
   * {@code mfa_satisfied}. That is the SAME signal mod-bff's {@code ModStepUpGate}
   * consumes — mod-bff's {@code BffCookieAuthenticationWebFilter} adds the
   * {@code MFA_SATISFIED} authority whenever admin-bff's introspect response
   * reports {@code mfaSatisfied} — which is why a BLIND retry of the original mod
   * write is the correct follow-up and no step-up token is plumbed back.
   */
  challenge(factor: ChallengeFactor, credential: string): Promise<MfaResult<{ mfaSatisfied: boolean }>> {
    return this.post<{ mfaSatisfied: boolean }>('/bff/mfa/challenge', { factor, credential });
  }

  /** The shared transport: JSON in/out, 503-is-dark, and never throwing. */
  private async post<T>(path: string, body: unknown = {}): Promise<MfaResult<T>> {
    try {
      const data = await firstValueFrom(this.http.post<T>(path, body));
      return { ok: true, dark: false, status: 200, data };
    } catch (e) {
      return MfaService.failure<T>(e);
    }
  }

  /**
   * Turn a thrown HTTP failure into an {@link MfaResult}. A 503 is DARK (the
   * feature is not launched), not an error; a response that never arrived is
   * status 0, so the caller does not report a server verdict it never got.
   */
  private static failure<T>(e: unknown): MfaResult<T> {
    if (e instanceof HttpErrorResponse) {
      if (e.status === MfaService.DARK_STATUS) {
        return { ok: false, dark: true, status: e.status };
      }
      return { ok: false, dark: false, status: e.status, error: MfaService.messageOf(e) };
    }
    return { ok: false, dark: false, status: 0, error: 'the request failed' };
  }

  /** The server's own sentence when it sent one — admin-bff's error envelope is
   *  {@code {"error": "<sentence>"}}; Spring's default is {@code {message}}. */
  private static messageOf(e: HttpErrorResponse): string | undefined {
    const body = e.error;
    if (typeof body === 'string' && body.trim() && !body.trim().startsWith('<')) return body.trim();
    if (body && typeof body === 'object') {
      for (const key of ['error', 'message'] as const) {
        const value = (body as Record<string, unknown>)[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return undefined;
  }
}

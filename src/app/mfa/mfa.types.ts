/**
 * The MFA contract types this remote needs — the STEP-UP half only.
 *
 * <h2>Why this is a trimmed copy, not admin-ui's file</h2>
 * hugmesh-admin-ui's {@code src/app/mfa/mfa.types.ts} also models FACTOR
 * ENROLLMENT ({@code MfaFactor}, {@code TotpEnrollStart}) because admin-ui hosts
 * the self-service "Security" surface. This remote hosts no such surface and
 * never enrolls anything: a moderator enrolls in admin-ui or login-ui, and the
 * moderation console only ever needs to SATISFY an existing factor. Copying the
 * enrollment types here would advertise a capability this remote does not have.
 *
 * Every shape below mirrors the shared hugmesh-auth-core
 * {@code MfaChallengeController} / {@code MfaEnrollmentController} contract
 * exactly — the UI never invents a shape the server does not return. NO SECRET is
 * ever persisted client-side.
 */

/** WebAuthn ceremony options returned by {@code POST /bff/mfa/assert/webauthn/options}.
 *  The challenge is base64url and is bound to the caller's session (pending, 5-minute TTL). */
export interface WebAuthnOptions {
  challenge: string;
  rpId: string;
  rpName: string;
}

/** The factor kinds accepted by {@code POST /bff/mfa/challenge}. */
export type ChallengeFactor = 'totp' | 'webauthn' | 'recovery';

/**
 * The DARK-aware outcome wrapper. Every {@code /bff/mfa/*} call answers 503 while
 * {@code app.casdoor.mfa.enabled=false} ("ships dark"); the UI treats that as
 * "MFA is not enabled on this deployment" and offers only a Close affordance
 * rather than an error. {@code dark} is set ONLY on a 503; {@code ok=false} with
 * {@code dark=false} is a real failure.
 */
export interface MfaResult<T> {
  ok: boolean;
  /** True when the server answered 503 (the feature ships dark / is not launched). */
  dark: boolean;
  /** HTTP status, or 0 when no response reached the browser. */
  status: number;
  /** The decoded JSON payload on success. */
  data?: T;
  /** A human error message on a non-OK, non-dark response. */
  error?: string;
}

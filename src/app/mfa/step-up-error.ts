import { ModWriteError, STEP_UP_SIGNAL_HEADER } from '../mod-write-error';

export { STEP_UP_SIGNAL_HEADER };

/**
 * Recognises the platform's "this write needs a fresh MFA step-up" refusal, so the
 * moderation console can offer the inline challenge dialog instead of printing a
 * bare refusal.
 *
 * <h2>READ THIS FIRST: nothing can make this predicate fire today</h2>
 * hugmesh-mod-bff-api {@code origin/main} (86de22e, measured 2026-09-17) emits
 * NEITHER leg below. Its {@code ModStepUpGate} is a {@code @PreAuthorize}
 * conjunct — {@code "hasAnyRole('MOD','ADMIN') and
 * @modStepUpGate.satisfied(authentication)"} on the five sensitive endpoints
 * ({@code ModController.java} :200, :242, :264, :298, :329) — so a denial is a
 * bare Spring {@code AccessDeniedException} 403 with no body and no header.
 * Measured: {@code grep -rain 'Step-Up-Required|STEP_UP_REQUIRED|stepUpRequired'}
 * over that repo returns ZERO hits, and it has no {@code accessDeniedHandler}.
 * The gate also ships DARK ({@code app.mfa.enforce-sensitive-writes:false},
 * {@code SecurityConfig.java}:305), so today it returns true unconditionally and
 * denies nothing at all.
 *
 * <p>So this module, the {@code MfaService} beside it and the dialog they feed are
 * deliberately INERT: correct, tested, and unreachable until the server half
 * signals. That is the same shape hugmesh-superadmin-service-catalog-ui#11 landed
 * for its own gates. What UNBLOCKS it is one cross-repo change in
 * hugmesh-mod-bff-api — make the denial carry a signal, e.g. lift the step-up
 * conjunct out of {@code @PreAuthorize} into an explicit check throwing
 * {@code ApiException.forbidden("… requires step-up …")}, which the legacy leg
 * below already matches with NO release of this remote. See hugmesh-mod-ui#1.
 *
 * <h2>The two legs</h2>
 * <ol>
 *   <li><b>Structured.</b> The {@code X-Step-Up-Required} response header, whose
 *       value is the NAME of the request header a step-up token would ride on —
 *       admin-bff's {@code web/StepUpRequiredException} is the reference emitter.
 *       {@code ModWriteError.stepUpSignal} already carries it out of the service
 *       (hugmesh-mod-ui#15), which is what made this module writable at all.</li>
 *   <li><b>Legacy phrase.</b> The literal {@code "requires step-up"} in the error
 *       body. admin-bff retains it verbatim in every gate message precisely so a
 *       client with no structured leg still works.</li>
 * </ol>
 *
 * <h2>Two deliberate divergences from admin-ui's {@code mfa/step-up-error.ts}</h2>
 * <ul>
 *   <li><b>Both legs are status-scoped here; admin-ui's phrase leg is not.</b>
 *       admin-ui kept its phrase leg status-agnostic to stay byte-compatible with
 *       its own PRE-SIGNAL behaviour during a rolling deploy. mod-bff has never
 *       sent either signal on any status, so there is no prior behaviour to
 *       preserve — and a status-agnostic substring match would let an unrelated
 *       5xx whose body happened to quote the phrase pop an MFA prompt.</li>
 *   <li><b>428 is accepted as well as 403.</b> Every platform gate today denies
 *       with 403 (admin-bff's {@code StepUpRequiredException} hard-codes
 *       {@code HttpStatus.FORBIDDEN} and says so), but this repo's own
 *       {@code mod-write-error.ts} already names 428 "the conventional step-up
 *       status" and renders a step-up clause on it. Recognising both keeps those
 *       two files from disagreeing.</li>
 * </ul>
 * A step-up denial on any OTHER status is NOT recognised. In particular 401 is
 * excluded on purpose: it means the session is gone, and a challenge issued
 * against a dead session cannot succeed — offering the dialog there would replace
 * the correct "sign in again" with a prompt that can only fail. THIS IS THE ONE
 * ASSUMPTION TO RE-CHECK when the mod-bff half lands.
 */

/** The statuses a step-up refusal is recognised on. See the class doc. */
const STEP_UP_STATUSES: readonly number[] = [403, 428];

/**
 * The pre-signal contract, kept as the leg an unsignalled BFF can satisfy with no
 * release of this remote. Intentionally narrow so it cannot false-positive on the
 * OTHER bare-403 rule these endpoints have (the privileged/self-target guard,
 * whose message never contains this phrase).
 */
export const LEGACY_STEP_UP_PATTERN = /requires step-up/i;

/**
 * The shape a signal value must have to be trusted: one of the gates'
 * {@code X-<flavour>-StepUp} constants. Byte-identical to the server-side
 * {@code SAFE_HEADER_NAME} in admin-bff's {@code StepUpRequiredException}.
 *
 * <p>Not paranoia for its own sake — the value is server-controlled text that a
 * caller could hand to {@code fetch} as a request-header NAME, so an unvalidated
 * value from a rogue proxy would be a header-injection vector. Anything else is
 * ignored and detection falls through to the phrase leg.
 *
 * <p>Note {@code ModWriteError.from} caps the header value at 60 characters and
 * appends an ellipsis when it truncates, so an over-long value fails this test and
 * is ignored. That is the safe direction, and no real gate constant is close
 * ({@code X-ImageGen-StepUp} is 17 characters).
 */
const SAFE_RETRY_HEADER = /^X-[A-Za-z0-9-]{1,60}-StepUp$/;

/** How a step-up requirement was recognised. Useful for diagnostics once the
 *  server half rolls out — the two legs will not arrive at the same time. */
export type StepUpDetection = 'signal' | 'legacy-phrase';

/** A recognised step-up requirement. */
export interface StepUpRequirement {
  /**
   * The request-header name a step-up TOKEN would ride on, e.g.
   * {@code X-ImageGen-StepUp}; null when only the phrase leg fired.
   *
   * <p>Nothing in this remote plumbs it. mod-bff's gate has no token leg at all —
   * {@code ModStepUpGate.satisfied()} is {@code Roles.isMfaSatisfied(auth)} and
   * nothing else — so the correct follow-up is a BLIND retry of the same write
   * once the dialog has stamped the caller's session. It is carried only so the
   * flavour the server advertises is observable rather than discarded.
   */
  readonly retryHeader: string | null;
  /** Which leg fired. */
  readonly via: StepUpDetection;
}

/**
 * The single detection seam: prefers the structured signal, falls back to the
 * phrase. Returns null when {@code error} is not a step-up refusal — notably for
 * an ORDINARY 403, since the privileged/self-target guard on these same five
 * endpoints must never pop an MFA prompt.
 */
export function stepUpRequirementOf(error: ModWriteError | null | undefined): StepUpRequirement | null {
  if (!error || !STEP_UP_STATUSES.includes(error.status)) return null;
  const signal = error.stepUpSignal;
  if (signal && SAFE_RETRY_HEADER.test(signal)) {
    return { retryHeader: signal, via: 'signal' };
  }
  if (LEGACY_STEP_UP_PATTERN.test(textOf(error))) {
    return { retryHeader: null, via: 'legacy-phrase' };
  }
  return null;
}

/** True when {@code error} is a step-up refusal. */
export function isStepUpRequiredError(error: ModWriteError | null | undefined): boolean {
  return stepUpRequirementOf(error) !== null;
}

/**
 * Everything of the refusal the phrase could be hiding in: the sentence
 * {@code ModWriteError} dug out of the body, and — because a future mod-bff might
 * put the phrase somewhere {@code serverMessageOf} does not look — the raw body
 * rendered as text. {@code message} is NOT consulted separately: it is either the
 * server sentence (already covered) or Angular's own transport text.
 */
function textOf(error: ModWriteError): string {
  const parts: string[] = [];
  if (error.serverMessage) parts.push(error.serverMessage);
  const body = error.body;
  if (typeof body === 'string') {
    parts.push(body);
  } else if (body && typeof body === 'object') {
    try {
      parts.push(JSON.stringify(body));
    } catch {
      // A body with a cycle or a BigInt cannot be stringified; the serverMessage
      // leg above is then the only text there is, which is the pre-existing
      // behaviour and not a regression.
    }
  }
  return parts.join(' ');
}

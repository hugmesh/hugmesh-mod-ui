import { ModWriteError } from '../mod-write-error';
import {
  LEGACY_STEP_UP_PATTERN,
  STEP_UP_SIGNAL_HEADER,
  isStepUpRequiredError,
  stepUpRequirementOf,
} from './step-up-error';

/** A refusal in the shape ModWriteError.from produces for an HttpErrorResponse. */
function refusal(
  status: number,
  body: unknown,
  serverMessage: string | null = null,
  stepUpSignal: string | null = null,
): ModWriteError {
  return new ModWriteError(
    serverMessage ?? `Http failure response: ${status}`,
    status,
    '',
    body,
    serverMessage,
    stepUpSignal,
  );
}

describe('step-up detection', () => {
  it('names the header it detects, so the constant cannot drift from mod-write-error', () => {
    expect(STEP_UP_SIGNAL_HEADER).toBe('X-Step-Up-Required');
  });

  describe('structured signal leg', () => {
    it('recognises a 403 carrying a well-formed gate constant', () => {
      const r = stepUpRequirementOf(refusal(403, null, null, 'X-ImageGen-StepUp'));
      expect(r).toEqual({ retryHeader: 'X-ImageGen-StepUp', via: 'signal' });
    });

    it('recognises the same signal on 428, the conventional step-up status', () => {
      const r = stepUpRequirementOf(refusal(428, null, null, 'X-ServiceStore-StepUp'));
      expect(r?.via).toBe('signal');
    });

    it('IGNORES a signal on 401 — the session is gone, so a challenge cannot succeed', () => {
      expect(stepUpRequirementOf(refusal(401, null, null, 'X-ImageGen-StepUp'))).toBeNull();
    });

    it('ignores a signal on a 500 (a stray header must not pop an MFA prompt)', () => {
      expect(stepUpRequirementOf(refusal(500, null, null, 'X-ImageGen-StepUp'))).toBeNull();
    });

    it('ignores a value that is not a gate constant — it would be a header-injection vector', () => {
      for (const bad of ['yes', 'true', 'X-Bad Header-StepUp', 'X-Foo-StepUp\r\nX-Evil: 1', 'StepUp']) {
        expect(stepUpRequirementOf(refusal(403, null, null, bad)))
          .withContext(bad)
          .toBeNull();
      }
    });

    it('ignores a truncated over-long value (ModWriteError caps at 60 and adds an ellipsis)', () => {
      const truncated = `X-${'a'.repeat(56)}…`;
      expect(stepUpRequirementOf(refusal(403, null, null, truncated))).toBeNull();
    });
  });

  describe('legacy phrase leg', () => {
    it('recognises the phrase in the server message on a 403', () => {
      const r = stepUpRequirementOf(
        refusal(403, { error: 'ban requires step-up re-authentication' }, 'ban requires step-up re-authentication'),
      );
      expect(r).toEqual({ retryHeader: null, via: 'legacy-phrase' });
    });

    it('matches case-insensitively, as the platform pattern always has', () => {
      expect(LEGACY_STEP_UP_PATTERN.test('This REQUIRES STEP-UP now')).toBeTrue();
    });

    it('finds the phrase in a raw body even where serverMessageOf did not dig one out', () => {
      // A future mod-bff could put it somewhere the message extractor does not look.
      const r = stepUpRequirementOf(refusal(403, { detail: { note: 'requires step-up' } }));
      expect(r?.via).toBe('legacy-phrase');
    });

    it('finds the phrase in a plain-text body', () => {
      expect(isStepUpRequiredError(refusal(403, 'block requires step-up'))).toBeTrue();
    });

    it('survives a body that cannot be stringified instead of throwing', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      expect(() => stepUpRequirementOf(refusal(403, cyclic))).not.toThrow();
      expect(stepUpRequirementOf(refusal(403, cyclic))).toBeNull();
    });
  });

  describe('everything else is NOT a step-up', () => {
    it('leaves an ordinary bare 403 alone — the privileged/self-target guard uses one too', () => {
      expect(isStepUpRequiredError(refusal(403, null))).toBeFalse();
    });

    it('leaves the privileged-target refusal alone', () => {
      const message = 'you cannot ban a moderator or administrator';
      expect(isStepUpRequiredError(refusal(403, { error: message }, message))).toBeFalse();
    });

    it('leaves a dropped connection (status 0) alone', () => {
      expect(isStepUpRequiredError(refusal(0, null))).toBeFalse();
    });

    it('tolerates null/undefined', () => {
      expect(isStepUpRequiredError(null)).toBeFalse();
      expect(isStepUpRequiredError(undefined)).toBeFalse();
    });
  });

  /**
   * The point of the whole slice: against TODAY's mod-bff nothing fires. If this
   * test ever fails, the server half has started signalling and the dialog has
   * gone live — which is the intended outcome, not a regression, but it must be a
   * DELIBERATE, noticed event rather than a silent one.
   */
  it('cannot fire against the denial hugmesh-mod-bff-api actually sends today', () => {
    // ModStepUpGate denies through @PreAuthorize => bare Spring AccessDeniedException:
    // 403, empty body, no X-Step-Up-Required header. Measured on mod-bff origin/main
    // 86de22e, 2026-09-17 (0 occurrences of the header, no accessDeniedHandler).
    expect(isStepUpRequiredError(refusal(403, null, null, null))).toBeFalse();
    // ...and the same denial as Spring's default JSON envelope, whose `error` field
    // is the reason phrase rather than a message.
    const envelope = { timestamp: '2026-09-17T00:00:00Z', status: 403, error: 'Forbidden', path: '/bff/mod/ban' };
    expect(isStepUpRequiredError(refusal(403, envelope, 'Forbidden'))).toBeFalse();
  });
});

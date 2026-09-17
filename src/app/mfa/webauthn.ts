/**
 * WebAuthn browser-API plumbing for the step-up challenge.
 *
 * <p>Ported from hugmesh-admin-ui {@code src/app/mfa/webauthn.ts}, with the
 * REGISTRATION half ({@code createPasskey}) deliberately left behind: this remote
 * never enrolls a factor (see {@code mfa.types.ts}), it only ASSERTS an existing
 * one. The admin-bff runs its own WebAuthn ceremony, so the UI only has to
 * (1) turn the BFF's base64url challenge into the options the browser wants,
 * (2) call {@code navigator.credentials.get()}, and (3) serialize the result back
 * to the JSON string the BFF verifies. Kept as pure functions plus one thin
 * wrapper so the encode/decode logic is unit-testable without an authenticator.
 */

import { WebAuthnOptions } from './mfa.types';

/** Decode a base64url (no padding) string to bytes. Backed by a fresh
 *  ArrayBuffer (not SharedArrayBuffer) so the result satisfies BufferSource. */
export function base64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes to base64url (no padding) — the form the BFF expects back. */
export function bytesToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Whether this browser exposes the WebAuthn API at all, so the dialog can disable
 * the passkey method and say why instead of throwing.
 *
 * <p>The probe is {@code credentials.get} — NOT {@code credentials.create} as the
 * admin-ui original probes. This remote only ever calls {@code get()}
 * ({@link getAssertion}); probing the method we never call would be a test of the
 * wrong capability.
 */
export function webauthnSupported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as { credentials?: { get?: unknown } }).credentials?.get;
}

/**
 * Serialize a PublicKeyCredential from {@code get()} into the JSON string the BFF
 * verifies — every ArrayBuffer becomes base64url. The attestation branch is kept
 * from the original so a shared BFF-side verifier sees a byte-identical shape
 * whichever remote produced it.
 */
export function credentialToJson(credential: PublicKeyCredential): string {
  const response = credential.response as AuthenticatorAttestationResponse &
    AuthenticatorAssertionResponse;
  const out: Record<string, unknown> = {
    id: credential.id,
    rawId: bytesToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64url(response.clientDataJSON),
    },
  };
  const resp = out['response'] as Record<string, unknown>;
  if (response.attestationObject) {
    resp['attestationObject'] = bytesToBase64url(response.attestationObject);
  }
  if (response.authenticatorData) {
    resp['authenticatorData'] = bytesToBase64url(response.authenticatorData);
    resp['signature'] = bytesToBase64url(response.signature);
    if (response.userHandle) resp['userHandle'] = bytesToBase64url(response.userHandle);
  }
  return JSON.stringify(out);
}

/**
 * Run a WebAuthn ASSERTION ceremony from the BFF's options and return the
 * {@code get()} response JSON string for {@code POST /bff/mfa/challenge}.
 */
export async function getAssertion(opts: WebAuthnOptions): Promise<string> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64urlToBytes(opts.challenge),
    rpId: opts.rpId,
    userVerification: 'preferred',
    timeout: 60_000,
  };
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey verification was cancelled.');
  return credentialToJson(credential);
}

/**
 * spectral.js — ed25519 sign/verify helpers
 * Hive Spectral signing layer — pairs with USPTO #19
 * Brand gold #C08D23
 */

import { createHash } from 'crypto';
import { subtle } from 'crypto';

// ── key management ────────────────────────────────────────────────────────────

/**
 * Generate a new ed25519 keypair. Returns { privateKeyB64, publicKeyB64 }.
 * Used at deploy time to seed SPECTRAL_PRIVKEY_B64 / SPECTRAL_PUBKEY_B64.
 */
export async function generateKeypair() {
  const keypair = await subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify']
  );
  const privRaw = await subtle.exportKey('pkcs8', keypair.privateKey);
  const pubRaw  = await subtle.exportKey('spki',  keypair.publicKey);
  return {
    privateKeyB64: Buffer.from(privRaw).toString('base64'),
    publicKeyB64:  Buffer.from(pubRaw).toString('base64'),
  };
}

/**
 * Load the signing key from env. Returns a CryptoKey.
 * Accepts PKCS#8 DER encoded private key, base64.
 */
export async function loadSigningKey(privKeyB64) {
  const der = Buffer.from(privKeyB64, 'base64');
  return subtle.importKey(
    'pkcs8',
    der,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
}

/**
 * Load a verify key from SPKI DER base64.
 */
export async function loadVerifyKey(pubKeyB64) {
  const der = Buffer.from(pubKeyB64, 'base64');
  return subtle.importKey(
    'spki',
    der,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
}

// ── canonical payload ─────────────────────────────────────────────────────────

/**
 * Build the canonical JSON string that gets signed.
 * Field order is deterministic — do NOT change without bumping schema_version.
 */
export function buildCanonicalPayload(fields) {
  const canonical = {
    merchant:           fields.merchant,
    period:             fields.period,
    period_start_ts:    fields.period_start_ts,
    period_end_ts:      fields.period_end_ts,
    agentic_volume_usd: fields.agentic_volume_usd,
    settlement_count:   fields.settlement_count,
    chain_breakdown:    fields.chain_breakdown,
    generated_at:       fields.generated_at,
  };
  return JSON.stringify(canonical);
}

/**
 * SHA-256 hex of a string.
 */
export function sha256hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// ── sign ──────────────────────────────────────────────────────────────────────

/**
 * Sign fields. Returns { signature_hex, signed_payload_sha256, public_key }.
 */
export async function signAttestation(fields, signingKey, publicKeyB64) {
  const canonical = buildCanonicalPayload(fields);
  const sig = await subtle.sign(
    { name: 'Ed25519' },
    signingKey,
    Buffer.from(canonical, 'utf8')
  );
  return {
    signature_hex:         Buffer.from(sig).toString('hex'),
    signed_payload_sha256: sha256hex(canonical),
    public_key:            publicKeyB64,
    signature_algo:        'ed25519',
  };
}

// ── verify ────────────────────────────────────────────────────────────────────

/**
 * Re-verify a stored attestation envelope.
 * Returns { signature_valid: boolean, recomputed_sha256, claimed_sha256 }.
 */
export async function verifyAttestation(envelope) {
  const {
    merchant, period, period_start_ts, period_end_ts,
    agentic_volume_usd, settlement_count, chain_breakdown,
    generated_at, public_key,
    signed_payload_sha256,
  } = envelope;
  // Accept both `signature` (envelope field) and `signature_hex` (internal)
  const signature_hex = envelope.signature_hex ?? envelope.signature;

  const canonical = buildCanonicalPayload({
    merchant, period, period_start_ts, period_end_ts,
    agentic_volume_usd, settlement_count, chain_breakdown, generated_at,
  });

  const recomputed_sha256 = sha256hex(canonical);

  let verifyKey;
  try {
    verifyKey = await loadVerifyKey(public_key);
  } catch {
    return { signature_valid: false, error: 'invalid_public_key', recomputed_sha256, claimed_sha256: signed_payload_sha256 };
  }

  let valid = false;
  try {
    valid = await subtle.verify(
      { name: 'Ed25519' },
      verifyKey,
      Buffer.from(signature_hex, 'hex'),
      Buffer.from(canonical, 'utf8')
    );
  } catch {
    valid = false;
  }

  return {
    signature_valid:    valid,
    recomputed_sha256,
    claimed_sha256:     signed_payload_sha256,
    sha256_match:       recomputed_sha256 === signed_payload_sha256,
  };
}

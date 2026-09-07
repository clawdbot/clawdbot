/**
 * Direct-DM pre-crypto guard policy.
 *
 * Defines conservative shape, size, timestamp, and rate limits before decryption work starts.
 */
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

/** Runtime limits applied before direct-DM encrypted payloads are decrypted. */
export type DirectDmPreCryptoGuardPolicy = {
  /** Accepted encrypted event kinds before decryption, e.g. Nostr kind 4. */
  allowedKinds: readonly number[];
  /** Maximum sender timestamp skew allowed into the future. */
  maxFutureSkewSec: number;
  /** Maximum encrypted payload bytes accepted before decrypt work starts. */
  maxCiphertextBytes: number;
  /** Maximum decrypted plaintext bytes accepted after decrypt succeeds. */
  maxPlaintextBytes: number;
  /** Per-sender and global throttles for encrypted DM ingress. */
  rateLimit: {
    /** Fixed rate-limit window size. */
    windowMs: number;
    /** Maximum messages per sender key inside one window. */
    maxPerSenderPerWindow: number;
    /** Maximum messages across all sender keys inside one window. */
    maxGlobalPerWindow: number;
    /** Maximum sender keys retained by the in-memory limiter. */
    maxTrackedSenderKeys: number;
  };
};

/** Partial overrides for channel plugins that need stricter pre-crypto limits. */
export type DirectDmPreCryptoGuardPolicyOverrides = Partial<
  Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">
> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};

/** Builds the shared policy object for DM-style pre-crypto guardrails. */
export function createDirectDmPreCryptoGuardPolicy(
  overrides: DirectDmPreCryptoGuardPolicyOverrides = {},
): DirectDmPreCryptoGuardPolicy {
  // Defaults must be conservative before decrypt: cheap shape/size/rate checks
  // happen before channel plugins spend CPU or allocate plaintext buffers.
  const defaultMaxFutureSkewSec = 120;
  const defaultMaxCiphertextBytes = 16 * 1024;
  const defaultMaxPlaintextBytes = 8 * 1024;
  const defaultWindowMs = 60_000;
  const defaultMaxPerSenderPerWindow = 20;
  const defaultMaxGlobalPerWindow = 200;
  const defaultMaxTrackedSenderKeys = 4096;
  return {
    allowedKinds: overrides.allowedKinds ?? [4],
    maxFutureSkewSec: resolveIntegerOption(overrides.maxFutureSkewSec, defaultMaxFutureSkewSec, {
      min: 0,
    }),
    maxCiphertextBytes: resolveIntegerOption(
      overrides.maxCiphertextBytes,
      defaultMaxCiphertextBytes,
      { min: 1 },
    ),
    maxPlaintextBytes: resolveIntegerOption(overrides.maxPlaintextBytes, defaultMaxPlaintextBytes, {
      min: 1,
    }),
    rateLimit: {
      windowMs: resolveIntegerOption(overrides.rateLimit?.windowMs, defaultWindowMs, { min: 1 }),
      maxPerSenderPerWindow: resolveIntegerOption(
        overrides.rateLimit?.maxPerSenderPerWindow,
        defaultMaxPerSenderPerWindow,
        { min: 1 },
      ),
      maxGlobalPerWindow: resolveIntegerOption(
        overrides.rateLimit?.maxGlobalPerWindow,
        defaultMaxGlobalPerWindow,
        { min: 1 },
      ),
      maxTrackedSenderKeys: resolveIntegerOption(
        overrides.rateLimit?.maxTrackedSenderKeys,
        defaultMaxTrackedSenderKeys,
        { min: 1 },
      ),
    },
  };
}

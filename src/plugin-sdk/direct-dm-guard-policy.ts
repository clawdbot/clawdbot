export type DirectDmPreCryptoGuardPolicy = {
  allowedKinds: readonly number[];
  maxFutureSkewSec: number;
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
  rateLimit: {
    windowMs: number;
    maxPerSenderPerWindow: number;
    maxGlobalPerWindow: number;
    maxTrackedSenderKeys: number;
  };
};

export type DirectDmPreCryptoGuardPolicyOverrides = Partial<
  Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">
> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};

/** Shared policy object for DM-style pre-crypto guardrails. */
export function createDirectDmPreCryptoGuardPolicy(
  overrides: DirectDmPreCryptoGuardPolicyOverrides = {},
): DirectDmPreCryptoGuardPolicy {
  return {
    allowedKinds: overrides.allowedKinds ?? [4],
    maxFutureSkewSec: overrides.maxFutureSkewSec ?? 120,
    maxCiphertextBytes: overrides.maxCiphertextBytes ?? 16 * 1024,
    maxPlaintextBytes: overrides.maxPlaintextBytes ?? 8 * 1024,
    rateLimit: {
      windowMs: overrides.rateLimit?.windowMs ?? 60_000,
      maxPerSenderPerWindow: overrides.rateLimit?.maxPerSenderPerWindow ?? 20,
      maxGlobalPerWindow: overrides.rateLimit?.maxGlobalPerWindow ?? 200,
      maxTrackedSenderKeys: overrides.rateLimit?.maxTrackedSenderKeys ?? 4096,
    },
  };
}

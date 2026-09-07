import type { PairingChannel } from "../../pairing/pairing-store.types.js";

/**
 * Read pairing-store allowlist entries when a direct-message policy permits
 * store fallback.
 */
export async function readChannelIngressStoreAllowFromForDmPolicy(params: {
  provider: PairingChannel;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (
    params.shouldRead === false ||
    params.dmPolicy === "allowlist" ||
    params.dmPolicy === "open"
  ) {
    return [];
  }
  const readStore =
    params.readStore ??
    (async (provider: PairingChannel, accountId: string) =>
      await readChannelIngressDefaultPairingStore({ provider, accountId }));
  return await readStore(params.provider, params.accountId).catch(() => []);
}

/**
 * Read the default pairing store for channel ingress, preserving a read
 * failure instead of resolving to an empty list.
 *
 * This is the ingress owner's reader, not a plugin-SDK export: the resolver in
 * `runtime.ts` classifies the rejection as an unavailable store. Plugins keep
 * using the best-effort reader above.
 */
export async function readChannelIngressDefaultPairingStore(params: {
  provider: PairingChannel;
  accountId: string;
}): Promise<string[]> {
  // Pairing store loads channel adapters for legacy normalization; keep that
  // registry edge lazy so pure ingress policy imports stay acyclic.
  const { readChannelAllowFromStore } = await import("../../pairing/pairing-store.js");
  return await readChannelAllowFromStore(params.provider, process.env, params.accountId);
}

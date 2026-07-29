// Pairing access helpers resolve channel/device pairing visibility for plugin callers.
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { normalizeAccountId } from "../routing/session-key.js";

type PairingApi = PluginRuntime["channel"]["pairing"];
type ScopedUpsertInput = Omit<
  Parameters<PairingApi["upsertPairingRequest"]>[0],
  "channel" | "accountId"
>;

/** Scope pairing store operations to one channel/account pair for plugin-facing helpers. */
export function createScopedPairingAccess(params: {
  /** Plugin runtime that owns the channel pairing store API. */
  core: PluginRuntime;
  /** Channel id permanently attached to store reads and writes from this helper. */
  channel: ChannelId;
  /** Channel account id normalized once before store operations. */
  accountId: string;
}) {
  const resolvedAccountId = normalizeAccountId(params.accountId);
  return {
    /** Normalized account id used by every channel-scoped pairing store operation. */
    accountId: resolvedAccountId,
    /** Read allow-list entries for the scoped channel/account pair. */
    readAllowFromStore: () =>
      params.core.channel.pairing.readAllowFromStore({
        channel: params.channel,
        accountId: resolvedAccountId,
      }),
    /** Delete one approval after the owning channel durably consumes it. */
    removeAllowFromStoreEntry: (entry: string | number) =>
      params.core.channel.pairing.removeAllowFromStoreEntry({
        channel: params.channel,
        accountId: resolvedAccountId,
        entry,
      }),
    /** Read another channel/account allow-list for DM policy cross-checks. */
    readStoreForDmPolicy: (provider: ChannelId, accountId: string) =>
      params.core.channel.pairing.readAllowFromStore({
        channel: provider,
        accountId: normalizeAccountId(accountId),
      }),
    /** Upsert a pairing request with the scoped channel/account injected. */
    upsertPairingRequest: (input: ScopedUpsertInput) =>
      params.core.channel.pairing.upsertPairingRequest({
        channel: params.channel,
        accountId: resolvedAccountId,
        ...input,
      }),
  };
}

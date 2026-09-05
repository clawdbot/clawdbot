import type { BufferedMediaGroupEntry } from "./bot-handlers.inbound-media.types.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

type TelegramMediaGroupRegistryDependencies = Pick<
  TelegramMessagePipeline,
  "releaseDispatchDedupeClaims" | "removeMessageFromReplyChain" | "settleSpooledReplayParticipants"
> &
  Pick<RegisterTelegramHandlerParams, "removeMessageFromGroupHistory">;

export function createTelegramMediaGroupRegistry({
  timeoutMs,
  releaseDispatchDedupeClaims,
  removeMessageFromGroupHistory,
  removeMessageFromReplyChain,
  settleSpooledReplayParticipants,
}: TelegramMediaGroupRegistryDependencies & { timeoutMs: number }) {
  const activeEntriesByIdentity = new Map<string, Set<BufferedMediaGroupEntry>>();
  const cancelledIdentityTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const readActiveEntries = (identityKey: string): BufferedMediaGroupEntry[] => [
    ...(activeEntriesByIdentity.get(identityKey) ?? []),
  ];

  const registerEntry = (entry: BufferedMediaGroupEntry) => {
    const entries = activeEntriesByIdentity.get(entry.identityKey) ?? new Set();
    entries.add(entry);
    activeEntriesByIdentity.set(entry.identityKey, entries);
  };

  const markCancelledIdentity = (identityKey: string) => {
    const previousTimer = cancelledIdentityTimers.get(identityKey);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    const timer = setTimeout(() => {
      if (cancelledIdentityTimers.get(identityKey) === timer) {
        cancelledIdentityTimers.delete(identityKey);
      }
    }, timeoutMs);
    cancelledIdentityTimers.set(identityKey, timer);
  };

  const finalizeEntry = (entry: BufferedMediaGroupEntry) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const entries = activeEntriesByIdentity.get(entry.identityKey);
    entries?.delete(entry);
    if (entries?.size === 0) {
      activeEntriesByIdentity.delete(entry.identityKey);
    }
  };

  const settleSkipped = (entry: BufferedMediaGroupEntry) => {
    if (entry.settled) {
      return;
    }
    entry.settled = true;
    releaseDispatchDedupeClaims(entry.dispatchDedupeClaims);
    settleSpooledReplayParticipants(entry.spooledReplayParticipants, { kind: "skipped" });
  };

  const purgeEntry = async (entry: BufferedMediaGroupEntry) => {
    for (const { msg } of entry.messages) {
      removeMessageFromGroupHistory(msg, entry.threadSpec);
      await removeMessageFromReplyChain(msg);
    }
  };

  const stopCancelledEntry = async (entry: BufferedMediaGroupEntry): Promise<boolean> => {
    if (!entry.cancelled) {
      return false;
    }
    settleSkipped(entry);
    await purgeEntry(entry);
    return true;
  };

  return {
    finalizeEntry,
    hasCancelledIdentity: (identityKey: string) => cancelledIdentityTimers.has(identityKey),
    markCancelledIdentity,
    purgeEntry,
    readActiveEntries,
    registerEntry,
    settleSkipped,
    stopCancelledEntry,
  };
}

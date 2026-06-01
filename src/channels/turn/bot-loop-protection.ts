import {
  createPairLoopGuard,
  resolvePairLoopGuardSettings,
  type PairLoopGuardConfig,
  type PairLoopGuardResult,
  type PairLoopGuardSnapshotEntry,
} from "../../plugin-sdk/pair-loop-guard-runtime.js";

/** Facts used to detect repeated bot-to-bot channel reply loops. */
export type ChannelBotLoopProtectionFacts = {
  scopeId: string;
  conversationId: string;
  senderId: string;
  receiverId: string;
  config?: PairLoopGuardConfig;
  defaultsConfig?: PairLoopGuardConfig;
  defaultEnabled: boolean;
  nowMs?: number;
};

const channelBotPairLoopGuard = createPairLoopGuard({ pruneIntervalMs: 60_000 });

/** Records a bot pair interaction and returns whether the loop guard should suppress it. */
export function recordChannelBotPairLoopAndCheckSuppression(
  params: ChannelBotLoopProtectionFacts,
): PairLoopGuardResult {
  return channelBotPairLoopGuard.recordAndCheck({
    scopeId: params.scopeId,
    conversationId: params.conversationId,
    senderId: params.senderId,
    receiverId: params.receiverId,
    settings: resolvePairLoopGuardSettings({
      config: params.config,
      defaultsConfig: params.defaultsConfig,
      defaultEnabled: params.defaultEnabled,
    }),
    nowMs: params.nowMs,
  });
}

/** Clears channel bot-loop state for isolated tests. */
export function clearChannelBotPairLoopGuardForTests(): void {
  channelBotPairLoopGuard.clear();
}

/** Lists tracked bot-loop pairs for isolated tests. */
export function listTrackedChannelBotPairsForTests(): PairLoopGuardSnapshotEntry[] {
  return channelBotPairLoopGuard.snapshot();
}

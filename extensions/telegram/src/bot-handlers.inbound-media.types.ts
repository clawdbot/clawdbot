import type { Message } from "grammy/types";
import type {
  OpenClawConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { NormalizedAllowFrom } from "./bot-access.js";
import type {
  TelegramAmbientTranscriptWatermark,
  TelegramChannelIngressResolver,
} from "./bot-message-context.types.js";
import type { TelegramSpooledReplayDeferredParticipant } from "./bot-processing-outcome.js";
import type { MediaGroupEntry } from "./bot-updates.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramMessageDispatchReplayClaim } from "./message-dispatch-dedupe.js";

export type MediaAuthorization = {
  authorizationCfg: OpenClawConfig;
  chatId: number;
  isGroup: boolean;
  isForum: boolean;
  threadSpec: TelegramThreadSpec;
  senderId: string;
  effectiveGroupAllow: NormalizedAllowFrom;
  effectiveDmAllow: NormalizedAllowFrom;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
};

export type TelegramMediaGroupInput = MediaAuthorization & {
  ctx: TelegramContext;
  msg: Message;
  ignoreEnabled: boolean;
  storeAllowFrom: string[];
  promptContextMinTimestampMs?: number;
  promptContextAmbientWatermark?: TelegramAmbientTranscriptWatermark;
  dispatchDedupeClaims: TelegramMessageDispatchReplayClaim[];
  channelIngressResolvers: readonly TelegramChannelIngressResolver[];
};

export type BufferedMediaGroupEntry = Omit<MediaGroupEntry, "timer"> &
  Omit<TelegramMediaGroupInput, "ctx" | "msg"> & {
    key: string;
    identityKey: string;
    timer?: ReturnType<typeof setTimeout>;
    flushDueAt: number;
    retentionDueAt?: number;
    phase: "buffered" | "queued" | "in-flight";
    processing?: Promise<void>;
    flushRequested: boolean;
    cancelled: boolean;
    settled: boolean;
    dispatchAdmission: "pending" | "admitted" | "cancelled";
    dispatchAbortController: AbortController;
    pendingResolutionWaiters: Set<() => void>;
    spooledReplayParticipants: TelegramSpooledReplayDeferredParticipant[];
  };

export type PendingMediaGroupIgnore = {
  settle: (authorized: boolean) => Promise<boolean>;
};

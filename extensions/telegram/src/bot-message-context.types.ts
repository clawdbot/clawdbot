import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
  TelegramTopicConfig,
} from "openclaw/plugin-sdk/config-types";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { StickerMetadata, TelegramContext } from "./bot/types.js";
import type { TelegramReplyChainEntry } from "./message-cache.js";

export type TelegramMediaRef = {
  path: string;
  contentType?: string;
  stickerMetadata?: StickerMetadata;
};

export type TelegramMessageContextOptions = {
  commandSource?: "text" | "native";
  forceWasMentioned?: boolean;
  messageIdOverride?: string;
  receivedAtMs?: number;
  ingressBuffer?: "inbound-debounce" | "text-fragment";
};

export type TelegramLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
};

type ResolveTelegramGroupConfig = (
  chatId: string | number,
  messageThreadId?: number,
) => {
  groupConfig?: TelegramGroupConfig | TelegramDirectConfig;
  topicConfig?: TelegramTopicConfig;
};

type ResolveGroupActivation = (params: {
  chatId: string | number;
  agentId?: string;
  messageThreadId?: number;
  sessionKey?: string;
}) => boolean | undefined;

type ResolveGroupRequireMention = (chatId: string | number) => boolean;

type TelegramMessageContextRuntimeOverrides = Partial<
  Pick<
    typeof import("./bot-message-context.runtime.js"),
    | "createStatusReactionController"
    | "ensureConfiguredBindingRouteReady"
    | "getRuntimeConfig"
    | "recordChannelActivity"
  >
>;

export type TelegramMessageContextSessionRuntimeOverrides = Partial<
  Pick<
    typeof import("./bot-message-context.session.runtime.js"),
    | "finalizeInboundContext"
    | "readSessionUpdatedAt"
    | "recordInboundSession"
    | "resolveInboundLastRouteSessionKey"
    | "resolvePinnedMainDmOwnerFromAllowlist"
    | "resolveStorePath"
  >
>;

export type BuildTelegramMessageContextParams = {
  primaryCtx: TelegramContext;
  allMedia: TelegramMediaRef[];
  replyMedia?: TelegramMediaRef[];
  replyChain?: TelegramReplyChainEntry[];
  storeAllowFrom: string[];
  options?: TelegramMessageContextOptions;
  bot: Bot;
  cfg: OpenClawConfig;
  account: { accountId: string };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  dmPolicy: DmPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  ackReactionScope: "off" | "none" | "group-mentions" | "group-all" | "direct" | "all";
  logger: TelegramLogger;
  resolveGroupActivation: ResolveGroupActivation;
  resolveGroupRequireMention: ResolveGroupRequireMention;
  resolveTelegramGroupConfig: ResolveTelegramGroupConfig;
  loadFreshConfig?: () => OpenClawConfig;
  runtime?: TelegramMessageContextRuntimeOverrides;
  sessionRuntime?: TelegramMessageContextSessionRuntimeOverrides;
  upsertPairingRequest?: typeof import("openclaw/plugin-sdk/conversation-runtime").upsertChannelPairingRequest;
  /** Global (per-account) handler for sendChatAction 401 backoff (#27092). */
  sendChatActionHandler: import("./sendchataction-401-backoff.js").TelegramSendChatActionHandler;
};

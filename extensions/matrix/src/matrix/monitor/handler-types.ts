import type { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { createChannelInboundEnvelopeBuilder } from "openclaw/plugin-sdk/channel-inbound";
import type { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import type {
  CoreConfig,
  MatrixConfig,
  MatrixRoomConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import type {
  resolveMatrixMonitorLiveUserAllowlist,
  MatrixResolvedAllowlistEntry,
} from "./config.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";
import type { PluginRuntime, RuntimeEnv, RuntimeLogger } from "./runtime-api.js";

export type MatrixMonitorHandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  accountConfig?: MatrixConfig;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  allowFromResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
  groupAllowFrom?: string[];
  groupAllowFromResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: ReadonlySet<string>;
  groupPolicy: "open" | "allowlist" | "disabled";
  replyToMode: ReplyToMode;
  threadReplies: "off" | "inbound" | "always";
  /** DM-specific threadReplies override. Falls back to threadReplies when absent. */
  dmThreadReplies?: "off" | "inbound" | "always";
  /** DM session grouping behavior. */
  dmSessionScope?: "per-user" | "per-room";
  streaming: MatrixStreamingMode;
  previewToolProgressEnabled: boolean;
  blockStreamingEnabled: boolean;
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  textLimit: number;
  mediaMaxBytes: number;
  historyLimit: number;
  startupMs: number;
  startupGraceMs: number;
  dropPreStartupMessages: boolean;
  inboundDeduper?: Pick<MatrixInboundEventDeduper, "claim">;
  directTracker: {
    isDirectMessage: (params: {
      roomId: string;
      senderId: string;
      selfUserId: string;
    }) => Promise<boolean>;
  };
  getRoomInfo: (
    roomId: string,
    opts?: { includeAliases?: boolean },
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  needsRoomAliasesForConfig: boolean;
  resolveLiveUserAllowlist?: typeof resolveMatrixMonitorLiveUserAllowlist;
  resolveStorePath?: typeof resolveStorePath;
  createChannelInboundEnvelopeBuilder?: typeof createChannelInboundEnvelopeBuilder;
  finalizeInboundContext?: (ctx: Record<string, unknown>) => unknown;
  resolveHumanDelayConfig?: typeof resolveHumanDelayConfig;
};

export type MatrixHandlerRuntimeConfig = MatrixMonitorHandlerParams & {
  allowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  groupAllowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  configuredBotUserIds: ReadonlySet<string>;
  resolveLiveUserAllowlist: typeof resolveMatrixMonitorLiveUserAllowlist;
  resolveStorePath: typeof resolveStorePath;
  createChannelInboundEnvelopeBuilder: typeof createChannelInboundEnvelopeBuilder;
  resolveHumanDelayConfig: typeof resolveHumanDelayConfig;
};

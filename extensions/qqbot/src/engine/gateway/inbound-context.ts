import type { ChannelIngressDecision } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { EngineAdapters } from "../adapter/index.js";
import type { GroupActivationMode, SessionStoreReader } from "../group/activation.js";
import type { HistoryEntry } from "../group/history.js";
import type { GroupMessageGateResult } from "../group/message-gating.js";
import type { QueuedMessage } from "./message-queue.js";
import type { GatewayAccount, EngineLogger, GatewayPluginRuntime } from "./types.js";
import type { TypingKeepAlive } from "./typing-keepalive.js";

export interface ReplyToInfo {
  id: string;
  body?: string;
  sender?: string;
  isQuote: boolean;
}

export interface InboundGroupInfo {
  gate: GroupMessageGateResult;
  activation: GroupActivationMode;
  historyLimit: number;
  isMerged: boolean;
  mergedMessages?: readonly QueuedMessage[];
  display: {
    groupName: string;
    senderLabel: string;
    introHint?: string;
    behaviorPrompt?: string;
  };
}

export interface InboundContext {
  event: QueuedMessage;
  route: { sessionKey: string; accountId: string; agentId?: string };
  isGroupChat: boolean;
  peerId: string;
  qualifiedTarget: string;
  fromAddress: string;
  agentBody: string;
  body: string;
  groupSystemPrompt?: string;
  localMediaPaths: string[];
  localMediaTypes: string[];
  remoteMediaUrls: string[];
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
  voiceMediaTypes: string[];
  hasAsrReferFallback: boolean;
  voiceTranscriptSources: string[];
  replyTo?: ReplyToInfo;
  commandAuthorized: boolean;
  group?: InboundGroupInfo;
  blocked: boolean;
  blockReason?: string;
  blockReasonCode?: string;
  accessDecision?: ChannelIngressDecision["decision"];
  skipped: boolean;
  skipReason?: "drop_other_mention" | "block_unauthorized_command" | "skip_no_mention";
  typing: { keepAlive: TypingKeepAlive | null };
  inputNotifyRefIdx?: string;
}

export interface InboundPipelineDeps {
  account: GatewayAccount;
  cfg: unknown;
  log?: EngineLogger;
  runtime: GatewayPluginRuntime;
  startTyping: (event: QueuedMessage) => Promise<{
    refIdx?: string;
    keepAlive: TypingKeepAlive | null;
  }>;
  groupHistories?: Map<string, HistoryEntry[]>;
  sessionStoreReader?: SessionStoreReader;
  allowTextCommands?: boolean;
  isControlCommand?: (content: string) => boolean;
  resolveGroupIntroHint?: (params: {
    cfg: unknown;
    accountId: string;
    groupId: string;
  }) => string | undefined;
  adapters: EngineAdapters;
}

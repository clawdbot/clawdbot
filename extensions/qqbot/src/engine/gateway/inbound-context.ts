/**
 * InboundContext — the structured result of the inbound pipeline.
 *
 * Connects the inbound stage (content building, attachment processing,
 * quote resolution) with the outbound stage (AI dispatch, deliver callbacks).
 *
 * All fields are readonly after construction. The outbound dispatcher
 * reads from this object but never mutates it.
 */

import type { QQBotAccessDecision, QQBotAccessReasonCode } from "../access/index.js";
import type { EngineAdapters } from "../adapter/index.js";
import type { GroupActivationMode, SessionStoreReader } from "../group/activation.js";
import type { HistoryEntry } from "../group/history.js";
import type { GroupMessageGateResult } from "../group/message-gating.js";
import type { QueuedMessage } from "./message-queue.js";
import type {
  GatewayAccount,
  EngineLogger,
  GatewayPluginRuntime,
  ProcessedAttachments,
} from "./types.js";
import type { TypingKeepAlive } from "./typing-keepalive.js";

// ============ InboundContext ============

/** Quote (reply-to) metadata resolved during inbound processing. */
export interface ReplyToInfo {
  id: string;
  body?: string;
  sender?: string;
  isQuote: boolean;
}

/**
 * Group-specific inbound metadata.
 *
 * Populated for group / guild events; left `undefined` for DMs. Keeping
 * the group fields under a nested bag makes it obvious which fields are
 * safe to read only when `isGroupChat === true`.
 *
 * The shape is kept small on purpose: everything derivable from `gate`
 * (raw wasMentioned / explicit / implicit / hasAnyMention / bypass) is
 * stored once on `gate`, not duplicated on the outer object.
 */
export interface InboundGroupInfo {
  // ---- Gating decision ----
  /** Full gate evaluation result (source of truth for mention state). */
  gate: GroupMessageGateResult;
  /** Effective activation mode after session-store / cfg merge. */
  activation: GroupActivationMode;

  // ---- Persistence-relevant ----
  /** Per-group history buffer cap. Zero → disabled. */
  historyLimit: number;
  /** `true` if this message was built by merging several queued entries. */
  isMerged: boolean;
  /** The unfiltered list of queued messages when `isMerged`, else undefined. */
  mergedMessages?: readonly QueuedMessage[];

  // ---- Presentation / prompt inputs ----
  /** Bundle of display-only strings; assembled by the envelope stage. */
  display: {
    /** Human-readable group name ("My Group" / first 8 chars of openid). */
    groupName: string;
    /** Sender label ("Nick (OPENID)" / "OPENID") for the UI. */
    senderLabel: string;
    /** Channel-level intro hint contributed by the platform adapter. */
    introHint?: string;
    /** Per-group behaviour prompt appended to the system prompt. */
    behaviorPrompt?: string;
  };
}

/** Fully resolved inbound context passed to the outbound dispatcher. */
export interface InboundContext {
  // ---- Original event ----
  event: QueuedMessage;

  // ---- Routing ----
  route: { sessionKey: string; accountId: string; agentId?: string };
  isGroupChat: boolean;
  peerId: string;
  /** Fully qualified target address: "qqbot:c2c:xxx" / "qqbot:group:xxx" etc. */
  qualifiedTarget: string;
  fromAddress: string;

  // ---- Content ----
  /** event.content after parseFaceTags. */
  parsedContent: string;
  /** parsedContent + voiceText + attachmentInfo — the user-visible text. */
  userContent: string;
  /** "[Quoted message begins]…[ends]" or empty. */
  quotePart: string;
  /** Per-message dynamic metadata lines (images, voice, ASR). */
  dynamicCtx: string;
  /** quotePart + userContent. */
  userMessage: string;
  /** dynamicCtx + userMessage (or raw content for slash commands). */
  agentBody: string;
  /** Formatted inbound envelope (Web UI body). */
  body: string;

  // ---- System prompts ----
  systemPrompts: string[];
  groupSystemPrompt?: string;

  // ---- Attachments ----
  attachments: ProcessedAttachments;
  localMediaPaths: string[];
  localMediaTypes: string[];
  remoteMediaUrls: string[];
  remoteMediaTypes: string[];

  // ---- Voice ----
  uniqueVoicePaths: string[];
  uniqueVoiceUrls: string[];
  uniqueVoiceAsrReferTexts: string[];
  voiceMediaTypes: string[];
  hasAsrReferFallback: boolean;
  voiceTranscriptSources: string[];

  // ---- Reply-to / Quote ----
  replyTo?: ReplyToInfo;

  // ---- Auth ----
  commandAuthorized: boolean;

  // ---- Group ----
  /** Populated only for group / guild messages. */
  group?: InboundGroupInfo;

  // ---- Blocking / skipping ----
  /**
   * Whether the inbound message should be blocked outright (access policy
   * refused the sender). Mutually exclusive with `skipped`.
   */
  blocked: boolean;
  /** Human-readable reason for `blocked`, for logging only. */
  blockReason?: string;
  /** Structured reason code for `blocked`. */
  blockReasonCode?: QQBotAccessReasonCode;
  /** The raw access decision produced by the policy engine. */
  accessDecision?: QQBotAccessDecision;
  /**
   * Whether the inbound was accepted by access control but stopped before
   * AI dispatch by the group gate (e.g. "skip_no_mention"). The caller
   * should NOT forward `skipped` messages to the outbound dispatcher, but
   * history / activity side-effects may already have been applied.
   */
  skipped: boolean;
  /** Structured reason code for `skipped`. */
  skipReason?: "drop_other_mention" | "block_unauthorized_command" | "skip_no_mention";

  // ---- Typing ----
  typing: { keepAlive: TypingKeepAlive | null };
  /** refIdx returned by the initial InputNotify call. */
  inputNotifyRefIdx?: string;
}

// ============ Pipeline dependencies ============

/** Dependencies injected into the inbound pipeline. */
export interface InboundPipelineDeps {
  account: GatewayAccount;
  cfg: unknown;
  log?: EngineLogger;
  runtime: GatewayPluginRuntime;
  /** Start typing indicator and return the refIdx from InputNotify. */
  startTyping: (event: QueuedMessage) => Promise<{
    refIdx?: string;
    keepAlive: TypingKeepAlive | null;
  }>;
  // ---- Group dependencies (optional — omit when the caller doesn't need
  // group support, e.g. a DM-only test harness). ----
  /** Shared per-connection history buffer, created by the gateway. */
  groupHistories?: Map<string, HistoryEntry[]>;
  /** Session-store reader for activation-mode overrides. */
  sessionStoreReader?: SessionStoreReader;
  /** Whether text-based control commands are enabled globally. */
  allowTextCommands?: boolean;
  /**
   * Framework probe that returns true when `content` is a known control
   * command. Injected to avoid hard-coding a list of commands in engine.
   */
  isControlCommand?: (content: string) => boolean;
  /** Optional platform hook that contributes a channel-level intro hint. */
  resolveGroupIntroHint?: (params: {
    cfg: unknown;
    accountId: string;
    groupId: string;
  }) => string | undefined;
  /** SDK adapter ports for delegating to shared implementations. */
  adapters: EngineAdapters;
}

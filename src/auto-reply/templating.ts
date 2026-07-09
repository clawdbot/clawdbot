/** Shared inbound message context types used by prompt templating and reply dispatch. */
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { ReplyToMode } from "../config/types.base.js";
import type {
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
} from "../media-understanding/types.js";
import type { PluginHookChannelContext } from "../plugins/hook-channel-context.types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { CommandTurnContext } from "./command-turn-context.js";
import type { CommandArgs } from "./commands-args.types.js";
import type { HistoryEntry } from "./reply/history.types.js";
import type { ReplyThreadingPolicy } from "./types.js";

/** Valid message channels for routing. */
export type OriginatingChannelType = string & { readonly __originatingChannelBrand?: never };

export type MentionSource =
  | "explicit_bot"
  | "subteam"
  | "mention_pattern"
  | "implicit_thread"
  | "command_bypass"
  | "none";

export type InboundSourceModality = "text" | "voice" | "audio" | "image" | "video" | "document";

type StickerContextMetadata = {
  cachedDescription?: string;
  emoji?: string;
  setName?: string;
  description?: string;
  fileId?: string;
  fileUniqueId?: string;
  uniqueFileId?: string;
  isAnimated?: boolean;
  isVideo?: boolean;
} & Record<string, unknown>;

type UntrustedStructuredContextEntry = {
  label: string;
  source?: string;
  type?: string;
  payload: unknown;
};

/** Structured supplemental facts projected into prompt context by inbound finalization. */
export type SupplementalContextFacts = {
  quote?: {
    id?: string;
    fullId?: string;
    body?: string;
    sender?: string;
    senderAllowed?: boolean;
    isExternal?: boolean;
    isQuote?: boolean;
  };
  forwarded?: {
    from?: string;
    fromType?: string;
    fromId?: string;
    date?: number;
    senderAllowed?: boolean;
  };
  thread?: {
    id?: string;
    starterBody?: string;
    historyBody?: string;
    label?: string;
    parentSessionKey?: string;
    modelParentSessionKey?: string;
    senderAllowed?: boolean;
  };
  untrustedContext?: Array<{ label: string; source?: string; type?: string; payload: unknown }>;
  groupSystemPrompt?: string;
  /** Prompt-like group metadata from user-controlled sources; never enters the system prompt. */
  untrustedGroupSystemPrompt?: string;
};

/** Raw inbound message context accepted from channels before finalization. */
export type MsgContext = {
  Body?: string;
  InboundEventKind?: InboundEventKind;
  /**
   * Agent prompt body (may include envelope/history/context). Prefer this for prompt shaping.
   * Should use real newlines (`\n`), not escaped `\\n`.
   */
  BodyForAgent?: string;
  /**
   * Recent chat history for context (untrusted user content). Prefer passing this
   * as structured context blocks in the user prompt rather than rendering plaintext envelopes.
   */
  InboundHistory?: HistoryEntry[];
  /**
   * @deprecated Use CommandBody.
   *
   * Raw message body without structural context (history, sender labels).
   * Legacy alias for CommandBody. Falls back to Body if not set.
   */
  RawBody?: string;
  /**
   * Prefer for command detection; RawBody is treated as legacy alias.
   */
  CommandBody?: string;
  /**
   * Command parsing body. Prefer this over CommandBody/RawBody when set.
   * Should be the "clean" text (no history/sender context).
   */
  BodyForCommands?: string;
  CommandArgs?: CommandArgs;
  From?: string;
  To?: string;
  SessionKey?: string;
  /**
   * Resolved agent scope for canonical session keys that do not encode the agent
   * id, such as selected-agent global sessions.
   */
  AgentId?: string;
  /**
   * Session-like key used for runtime policy (sandbox/tool policy) when the
   * conversation key intentionally remains broader, such as a main-session DM.
   */
  RuntimePolicySessionKey?: string;
  /** Provider account id (multi-account). */
  AccountId?: string;
  ParentSessionKey?: string;
  /**
   * Session key used only for inheriting session-scoped model/provider
   * overrides. Unlike ParentSessionKey, this must not trigger transcript
   * forking or parent-session lifecycle behavior.
   */
  ModelParentSessionKey?: string;
  MessageSid?: string;
  /** Provider-specific full message id when MessageSid is a shortened alias. */
  MessageSidFull?: string;
  MessageSids?: string[];
  MessageSidFirst?: string;
  MessageSidLast?: string;
  AmbientTranscriptWatermarkKey?: string;
  AmbientTranscriptBody?: string;
  AmbientTranscriptMessageId?: string;
  AmbientTranscriptTimestampMs?: number;
  AmbientTranscriptPreviousMessageId?: string;
  AmbientTranscriptPreviousTimestampMs?: number;
  /** Per-turn reply-threading overrides. */
  ReplyThreading?: ReplyThreadingPolicy;
  /** Effective channel reply mode prepared for this turn. */
  ReplyToMode?: ReplyToMode;
  ReplyToId?: string;
  /**
   * Root message id for thread reconstruction (used by Feishu for root_id).
   * When a message is part of a thread, this is the id of the first message.
   */
  RootMessageId?: string;
  /** Provider-specific full reply-to id when ReplyToId is a shortened alias. */
  ReplyToIdFull?: string;
  ReplyToBody?: string;
  ReplyToQuoteText?: string;
  ReplyToSender?: string;
  ReplyChain?: Array<{
    messageId?: string;
    threadId?: string;
    sender?: string;
    senderId?: string;
    senderUsername?: string;
    timestamp?: number;
    body?: string;
    isQuote?: boolean;
    mediaType?: string;
    mediaPath?: string;
    mediaRef?: string;
    replyToId?: string;
    forwardedFrom?: string;
    forwardedFromId?: string;
    forwardedFromUsername?: string;
    forwardedDate?: number;
  }>;
  ReplyToIsQuote?: boolean;
  /** Forward origin from the reply target (when reply_to_message is a forwarded message). */
  ReplyToForwardedFrom?: string;
  ReplyToForwardedFromType?: string;
  ReplyToForwardedFromId?: string;
  ReplyToForwardedFromUsername?: string;
  ReplyToForwardedFromTitle?: string;
  ReplyToForwardedDate?: number;
  ForwardedFrom?: string;
  ForwardedFromType?: string;
  ForwardedFromId?: string;
  ForwardedFromUsername?: string;
  ForwardedFromTitle?: string;
  ForwardedFromSignature?: string;
  ForwardedFromChatType?: string;
  ForwardedFromMessageId?: number;
  ForwardedDate?: number;
  ThreadStarterBody?: string;
  /** Full thread history when starting a new thread session. */
  ThreadHistoryBody?: string;
  IsFirstThreadTurn?: boolean;
  ThreadLabel?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaDir?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  /** Original message modality before transcription or other media normalization. */
  SourceModality?: InboundSourceModality;
  MediaWorkspaceDir?: string;
  /** Attachment indexes whose audio was already transcribed before media understanding runs. */
  MediaTranscribedIndexes?: number[];
  /**
   * Marker: skip downstream stageSandboxMedia. chat.send RPC sets this so
   * staging runs synchronously before respond() and surfaces 5xx to the
   * client; any later failure only reaches the broadcast channel.
   */
  MediaStaged?: boolean;
  /** Telegram sticker metadata (emoji, set name, file IDs, cached description). */
  Sticker?: StickerContextMetadata;
  /** True when current-turn sticker media is present in MediaPaths. */
  StickerMediaIncluded?: boolean;
  /** Skip automatic understanding for the current sticker because its cached description is used. */
  SkipStickerMediaUnderstanding?: boolean;
  OutputDir?: string;
  OutputBase?: string;
  /** Remote host for SCP when media lives on a different machine (e.g., openclaw@192.168.64.3). */
  MediaRemoteHost?: string;
  Transcript?: string;
  MediaUnderstanding?: MediaUnderstandingOutput[];
  MediaUnderstandingDecisions?: MediaUnderstandingDecision[];
  LinkUnderstanding?: string[];
  Prompt?: string;
  MaxChars?: number;
  ChatType?: string;
  /** Human label for envelope headers (conversation label, not sender). */
  ConversationLabel?: string;
  GroupSubject?: string;
  /** Human label for channel-like group conversations (e.g. #general, #support). */
  GroupChannel?: string;
  GroupSpace?: string;
  /** Trusted provider role ids for the sender in this group turn. */
  MemberRoleIds?: string[];
  GroupMembers?: string;
  GroupSystemPrompt?: string;
  /**
   * Canonical inbound supplemental facts for new channel code. `finalizeInboundContext`
   * projects these to the existing flat reply/forward/thread/group prompt fields.
   */
  SupplementalContext?: SupplementalContextFacts;
  /** Untrusted metadata that must not be treated as system instructions. */
  UntrustedContext?: string[];
  /** Structured untrusted metadata rendered by prompt assembly as fenced JSON. */
  UntrustedStructuredContext?: UntrustedStructuredContextEntry[];
  /** System-attached provenance for the current inbound message. */
  InputProvenance?: InputProvenance;
  /** Explicit owner allowlist overrides (trusted, configuration-derived). */
  OwnerAllowFrom?: Array<string | number>;
  SenderName?: string;
  SenderId?: string;
  SenderUsername?: string;
  SenderTag?: string;
  SenderE164?: string;
  SenderIsBot?: boolean;
  Timestamp?: number;
  LocationLat?: number;
  LocationLon?: number;
  LocationAccuracy?: number;
  LocationName?: string;
  LocationAddress?: string;
  LocationSource?: string;
  LocationIsLive?: boolean;
  LocationCaption?: string;
  /** Provider label. */
  Provider?: string;
  /** Provider surface label. Prefer this over `Provider` when available. */
  Surface?: string;
  /** Platform bot username when command mentions should be normalized. */
  BotUsername?: string;
  WasMentioned?: boolean;
  /** Effective channel-owned mention policy before any plugin-binding bypass. */
  GroupRequireMention?: boolean;
  /** True when this turn explicitly mentioned the current bot target. */
  ExplicitlyMentionedBot?: boolean;
  /** Provider-native explicit user mention ids present on this turn. */
  MentionedUserIds?: string[];
  /** Provider-native explicit user-group/subteam mention ids present on this turn. */
  MentionedSubteamIds?: string[];
  /** Provider-native implicit mention wake reasons present on this turn. */
  ImplicitMentionKinds?: string[];
  /** Provider-native source that caused the current mention decision. */
  MentionSource?: MentionSource;
  CommandAuthorized?: boolean;
  CommandTurn?: CommandTurnContext;
  CommandSource?: "text" | "native";
  CommandTargetSessionKey?: string;
  /**
   * Internal flag: command handling prepared trailing prompt text for ACP dispatch.
   * Used for `/new <prompt>` and `/reset <prompt>` on ACP-bound sessions.
   */
  AcpDispatchTailAfterReset?: boolean;
  /** Gateway client scopes when the message originates from the gateway. */
  GatewayClientScopes?: string[];
  /** Gateway client capabilities when the message originates from the gateway. */
  GatewayClientCaps?: string[];
  /** Gateway device id allowed to review approvals initiated by this turn. */
  ApprovalReviewerDeviceId?: string;
  /** Thread identifier (Telegram topic id or Matrix thread event id). */
  MessageThreadId?: string | number;
  /** Provider-native thread target for reply delivery without making the session thread-scoped. */
  TransportThreadId?: string | number;
  /** Platform-native channel/conversation id (e.g. Slack DM channel "D…" id). */
  NativeChannelId?: string;
  /** Channel-owned metadata exposed to plugin hook context, not prompt text. */
  ChannelContext?: PluginHookChannelContext;
  /** Provider-native chat/conversation id used by channel plugins that expose `chat_id`. */
  ChatId?: string;
  /** Stable provider-native direct-peer id when a DM room/user mapping must survive later writes. */
  NativeDirectUserId?: string;
  /** Telegram forum supergroup marker. */
  IsForum?: boolean;
  /** Human-readable Telegram forum topic name (cached from service messages). */
  TopicName?: string;
  /** Warning: DM has topics enabled but this message is not in a topic. */
  TopicRequiredButMissing?: boolean;
  /**
   * Originating channel for reply routing.
   * When set, replies should be routed back to this provider
   * instead of using lastChannel from the session.
   */
  OriginatingChannel?: OriginatingChannelType;
  /**
   * Originating destination for reply routing.
   * The chat/channel/user ID where the reply should be sent.
   */
  OriginatingTo?: string;
  /**
   * True when the current turn intentionally requested external delivery to
   * OriginatingChannel/OriginatingTo, rather than inheriting stale session route metadata.
   */
  ExplicitDeliverRoute?: boolean;
  /**
   * Internal flag for channels that emit message_received through a channel-specific
   * privacy gate before entering the shared reply dispatcher.
   */
  SuppressMessageReceivedHooks?: boolean;
  /**
   * Provider-specific parent conversation id for threaded contexts.
   * For Discord threads, this is the parent channel id.
   */
  ThreadParentId?: string;
  /**
   * Messages from hooks to be included in the response.
   * Used for hook confirmation messages like "Session context saved to memory".
   */
  HookMessages?: string[];
};

export type FinalizedMsgContext = Omit<MsgContext, "CommandAuthorized"> & {
  /**
   * Always set by finalizeInboundContext().
   * Default-deny: missing/undefined becomes false.
   */
  CommandAuthorized: boolean;
  /**
   * Populated by finalizeInboundContext(); optional for public SDK
   * compatibility with existing plugin-constructed finalized contexts.
   */
  CommandTurn?: CommandTurnContext;
};

export type TemplateContext = MsgContext & {
  BodyStripped?: string;
  SessionId?: string;
  IsNewSession?: string;
};

function formatTemplateValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (entry == null) {
          return [];
        }
        if (typeof entry === "string") {
          return [entry];
        }
        if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") {
          return [String(entry)];
        }
        return [];
      })
      .join(",");
  }
  if (typeof value === "object") {
    return "";
  }
  return "";
}

// Simple {{Placeholder}} interpolation using inbound message context.
export function applyTemplate(str: string | undefined, ctx: TemplateContext) {
  if (!str) {
    return "";
  }
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = ctx[key as keyof TemplateContext];
    return formatTemplateValue(value);
  });
}

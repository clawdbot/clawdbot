import type { ChannelId } from "../channels/plugins/types.js";
import type { StickerMetadata } from "../telegram/bot/types.js";
import type { InternalMessageChannel } from "../utils/message-channel.js";
import type { CommandArgs } from "./commands-registry.types.js";
import type {
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
} from "../media-understanding/types.js";

/** Valid message channels for routing. */
export type OriginatingChannelType = ChannelId | InternalMessageChannel;

export type MsgContext = {
  Body?: string;
  /**
   * Agent prompt body (may include envelope/history/context). Prefer this for prompt shaping.
   * Should use real newlines (`\n`), not escaped `\\n`.
   */
  BodyForAgent?: string;
  /**
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
  /** Provider account id (multi-account). */
  AccountId?: string;
  ParentSessionKey?: string;
  MessageSid?: string;
  /** Provider-specific full message id when MessageSid is a shortened alias. */
  MessageSidFull?: string;
  MessageSids?: string[];
  MessageSidFirst?: string;
  MessageSidLast?: string;
  ReplyToId?: string;
  /** Provider-specific full reply-to id when ReplyToId is a shortened alias. */
  ReplyToIdFull?: string;
  ReplyToBody?: string;
  ReplyToSender?: string;
  ReplyToIsQuote?: boolean;
  ForwardedFrom?: string;
  ForwardedFromType?: string;
  ForwardedFromId?: string;
  ForwardedFromUsername?: string;
  ForwardedFromTitle?: string;
  ForwardedFromSignature?: string;
  ForwardedDate?: number;
  ThreadStarterBody?: string;
  ThreadLabel?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaDir?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  /** Telegram sticker metadata (emoji, set name, file IDs, cached description). */
  Sticker?: StickerMetadata;
  OutputDir?: string;
  OutputBase?: string;
  /** Remote host for SCP when media lives on a different machine (e.g., moltbot@192.168.64.3). */
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
  GroupMembers?: string;
  GroupSystemPrompt?: string;
  SenderName?: string;
  SenderId?: string;
  SenderUsername?: string;
  SenderTag?: string;
  SenderE164?: string;
  Timestamp?: number;
  /** Provider label (e.g. whatsapp, telegram). */
  Provider?: string;
  /** Provider surface label (e.g. discord, slack). Prefer this over `Provider` when available. */
  Surface?: string;
  WasMentioned?: boolean;
  CommandAuthorized?: boolean;
  CommandSource?: "text" | "native";
  CommandTargetSessionKey?: string;
  /** Thread identifier (Telegram topic id or Matrix thread event id). */
  MessageThreadId?: string | number;
  /** Telegram forum supergroup marker. */
  IsForum?: boolean;
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
};

export type TemplateContext = MsgContext & {
  BodyStripped?: string;
  SessionId?: string;
  IsNewSession?: string;
};

function formatTemplateValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (entry == null) return [];
        if (typeof entry === "string") return [entry];
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
  if (!str) return "";
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = ctx[key as keyof TemplateContext];
    return formatTemplateValue(value);
  });
}

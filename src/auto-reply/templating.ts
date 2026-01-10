import type { ProviderId } from "../providers/plugins/types.js";

/** Valid provider channels for message routing. */
export type OriginatingChannelType = ProviderId | "webchat";

export type MsgContext = {
  Body?: string;
  /**
   * Raw message body without structural context (history, sender labels).
   * Legacy alias for CommandBody. Falls back to Body if not set.
   */
  RawBody?: string;
  /**
   * Prefer for command detection; RawBody is treated as legacy alias.
   */
  CommandBody?: string;
  From?: string;
  To?: string;
  SessionKey?: string;
  /** Provider account id (multi-account). */
  AccountId?: string;
  ParentSessionKey?: string;
  MessageSid?: string;
  ReplyToId?: string;
  ReplyToBody?: string;
  ReplyToSender?: string;
  ThreadStarterBody?: string;
  ThreadLabel?: string;
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  Transcript?: string;
  ChatType?: string;
  GroupSubject?: string;
  GroupRoom?: string;
  GroupSpace?: string;
  GroupMembers?: string;
  GroupSystemPrompt?: string;
  SenderName?: string;
  SenderId?: string;
  SenderUsername?: string;
  SenderTag?: string;
  SenderE164?: string;
  /** Provider label (e.g. whatsapp, telegram). */
  Provider?: string;
  /** Provider surface label (e.g. discord, slack). Prefer this over `Provider` when available. */
  Surface?: string;
  WasMentioned?: boolean;
  CommandAuthorized?: boolean;
  CommandSource?: "text" | "native";
  CommandTargetSessionKey?: string;
  /** Telegram forum topic thread ID. */
  MessageThreadId?: number;
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
};

export type TemplateContext = MsgContext & {
  BodyStripped?: string;
  SessionId?: string;
  IsNewSession?: string;
};

// Simple {{Placeholder}} interpolation using inbound message context.
export function applyTemplate(str: string | undefined, ctx: TemplateContext) {
  if (!str) return "";
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = ctx[key as keyof TemplateContext];
    return value == null ? "" : String(value);
  });
}

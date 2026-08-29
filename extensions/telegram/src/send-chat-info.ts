// Telegram plugin module implements read-only chat introspection behavior.
import type { ChatFullInfo, ChatMember } from "grammy/types";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  resolveTelegramApiContext,
  withTelegramApiContextLease,
  type TelegramApiContext,
} from "./send-context.js";
import type { TelegramApiCallOpts } from "./send-message-types.js";

// Bounded string length for model-visible introspection fields. Raw Telegram
// API responses carry PII (bio, usernames, business info) and unbounded text;
// only an allowlist of fields the agent needs to reason about chat context is
// returned, each capped to keep tool output bounded.
const TELEGRAM_CHAT_INFO_FIELD_MAX_CHARS = 200;

// Hard cap on the administrator roster returned to model context. Telegram
// groups can have large admin lists; per-field truncation alone does not bound
// the aggregate roster size or its context cost, so the projection owner drops
// any entries beyond this limit and reports the truncation.
const TELEGRAM_ADMINISTRATORS_MAX_RETURNED = 20;

type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export type TelegramChatInfoProjection = {
  id: number;
  type: TelegramChatType;
  title?: string;
  username?: string;
  membersCount?: number;
  isForum?: boolean;
  pinnedMessageText?: string;
};

export type TelegramChatMemberProjection = {
  status: ChatMember["status"];
  userId: number;
  isBot: boolean;
  displayName?: string;
  customTitle?: string;
  isAnonymous?: boolean;
  privileges?: Record<string, boolean>;
};

function boundString(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return truncateUtf16Safe(trimmed, TELEGRAM_CHAT_INFO_FIELD_MAX_CHARS);
}

function projectTelegramUser(user: ChatMember["user"]): {
  userId: number;
  isBot: boolean;
  displayName?: string;
} {
  const names = [user.first_name, user.last_name].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0,
  );
  return {
    userId: user.id,
    isBot: Boolean(user.is_bot),
    displayName: boundString(names.join(" ")) ?? undefined,
  };
}

// Administrator privilege flags the agent may need to reason about roles. The
// raw ChatMemberAdministrator carries many booleans; only the operationally
// meaningful subset is surfaced.
const TELEGRAM_ADMIN_PRIVILEGE_KEYS = [
  "can_manage_chat",
  "can_delete_messages",
  "can_restrict_members",
  "can_promote_members",
  "can_change_info",
  "can_invite_users",
  "can_pin_messages",
  "can_manage_topics",
  "can_post_messages",
  "can_edit_messages",
] as const;

export function projectTelegramChatInfo(chat: ChatFullInfo): TelegramChatInfoProjection {
  const projection: TelegramChatInfoProjection = {
    id: chat.id,
    type: chat.type,
  };
  const title = boundString(chat.title);
  if (title) {
    projection.title = title;
  }
  const username = boundString(chat.username);
  if (username) {
    projection.username = username;
  }
  if (typeof chat.members_count === "number") {
    projection.membersCount = chat.members_count;
  }
  if (typeof chat.is_forum === "boolean") {
    projection.isForum = chat.is_forum;
  }
  const pinnedText =
    typeof chat.pinned_message?.text === "string" ? boundString(chat.pinned_message.text) : undefined;
  if (pinnedText) {
    projection.pinnedMessageText = pinnedText;
  }
  return projection;
}

export function projectTelegramChatMember(member: ChatMember): TelegramChatMemberProjection {
  const user = projectTelegramUser(member.user);
  const projection: TelegramChatMemberProjection = {
    status: member.status,
    userId: user.userId,
    isBot: user.isBot,
  };
  if (user.displayName) {
    projection.displayName = user.displayName;
  }
  if (typeof member.is_anonymous === "boolean") {
    projection.isAnonymous = member.is_anonymous;
  }
  const customTitle = boundString(
    "custom_title" in member ? member.custom_title : undefined,
  );
  if (customTitle) {
    projection.customTitle = customTitle;
  }
  if (member.status === "administrator") {
    const privileges: Record<string, boolean> = {};
    for (const key of TELEGRAM_ADMIN_PRIVILEGE_KEYS) {
      const value = member[key];
      if (typeof value === "boolean") {
        privileges[key] = value;
      }
    }
    projection.privileges = privileges;
  }
  return projection;
}

async function getTelegramChatInfoWithContext(
  chatId: string | number,
  context: TelegramApiContext,
): Promise<TelegramChatInfoProjection> {
  const chat = await context.api.getChat(chatId);
  return projectTelegramChatInfo(chat);
}

export async function getTelegramChatInfo(
  chatId: string | number,
  opts: TelegramApiCallOpts,
): Promise<TelegramChatInfoProjection> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(context, getTelegramChatInfoWithContext(chatId, context));
}

async function getTelegramChatMemberWithContext(
  chatId: string | number,
  userId: number,
  context: TelegramApiContext,
): Promise<TelegramChatMemberProjection> {
  const member = await context.api.getChatMember(chatId, userId);
  return projectTelegramChatMember(member);
}

export async function getTelegramChatMember(
  chatId: string | number,
  userId: number,
  opts: TelegramApiCallOpts,
): Promise<TelegramChatMemberProjection> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    getTelegramChatMemberWithContext(chatId, userId, context),
  );
}

// Bounds the administrator roster at the projection owner: per-field caps
// alone leave the aggregate array unbounded, so the collection is truncated to
// a hard limit and the dropped count is surfaced so the model knows the list
// is incomplete.
export function boundTelegramAdministrators(
  administrators: ChatMember[],
): { members: TelegramChatMemberProjection[]; truncatedCount: number } {
  const total = administrators.length;
  const capped = administrators.slice(0, TELEGRAM_ADMINISTRATORS_MAX_RETURNED);
  return {
    members: capped.map(projectTelegramChatMember),
    truncatedCount: Math.max(0, total - capped.length),
  };
}

async function getTelegramChatAdministratorsWithContext(
  chatId: string | number,
  context: TelegramApiContext,
): Promise<{
  members: TelegramChatMemberProjection[];
  truncatedCount: number;
}> {
  const administrators = await context.api.getChatAdministrators(chatId);
  return boundTelegramAdministrators(administrators);
}

export async function getTelegramChatAdministrators(
  chatId: string | number,
  opts: TelegramApiCallOpts,
): Promise<{
  members: TelegramChatMemberProjection[];
  truncatedCount: number;
}> {
  const context = resolveTelegramApiContext(opts);
  return withTelegramApiContextLease(
    context,
    getTelegramChatAdministratorsWithContext(chatId, context),
  );
}

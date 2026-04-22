import type { MsgContext } from "../auto-reply/templating.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeChatType } from "./chat-type.js";

function extractConversationId(from?: string): string | undefined {
  const trimmed = normalizeOptionalString(from);
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function shouldAppendId(id: string): boolean {
  if (/^[0-9]+$/.test(id)) {
    return true;
  }
  if (/^[^\s:@]+@[^\s:@]+$/.test(id)) {
    return true;
  }
  return false;
}

export function resolveConversationLabel(ctx: MsgContext): string | undefined {
  const explicit = normalizeOptionalString(ctx.ConversationLabel);
  if (explicit) {
    return explicit;
  }

  const threadLabel = normalizeOptionalString(ctx.ThreadLabel);
  if (threadLabel) {
    return threadLabel;
  }

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType === "direct") {
    return normalizeOptionalString(ctx.SenderName) ?? normalizeOptionalString(ctx.From);
  }

  const base =
    normalizeOptionalString(ctx.GroupChannel) ||
    normalizeOptionalString(ctx.GroupSubject) ||
    normalizeOptionalString(ctx.GroupSpace) ||
    normalizeOptionalString(ctx.From) ||
    "";
  if (!base) {
    return undefined;
  }

  const id = extractConversationId(ctx.From);
  if (!id) {
    return base;
  }
  if (!shouldAppendId(id)) {
    return base;
  }
  if (base === id) {
    return base;
  }
  if (base.includes(id)) {
    return base;
  }
  if (normalizeLowercaseStringOrEmpty(base).includes(" id:")) {
    return base;
  }
  if (base.startsWith("#") || base.startsWith("@")) {
    return base;
  }
  return `${base} id:${id}`;
}

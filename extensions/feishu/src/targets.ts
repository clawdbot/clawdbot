import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { FeishuIdType } from "./types.js";

const CHAT_ID_PREFIX = "oc_";
const OPEN_ID_PREFIX = "ou_";
const USER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function stripProviderPrefix(raw: string): string {
  return raw.replace(/^(feishu|lark):/i, "").trim();
}

export function detectIdType(id: string): FeishuIdType | null {
  const trimmed = id.trim();
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return "chat_id";
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return "open_id";
  }
  if (USER_ID_REGEX.test(trimmed)) {
    return "user_id";
  }
  return null;
}

export function normalizeFeishuTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const withoutProvider = stripProviderPrefix(trimmed);
  const lowered = normalizeLowercaseStringOrEmpty(withoutProvider);
  if (lowered.startsWith("chat:")) {
    return withoutProvider.slice("chat:".length).trim() || null;
  }
  if (lowered.startsWith("group:")) {
    return withoutProvider.slice("group:".length).trim() || null;
  }
  if (lowered.startsWith("channel:")) {
    return withoutProvider.slice("channel:".length).trim() || null;
  }
  if (lowered.startsWith("user:")) {
    return withoutProvider.slice("user:".length).trim() || null;
  }
  if (lowered.startsWith("dm:")) {
    return withoutProvider.slice("dm:".length).trim() || null;
  }
  if (lowered.startsWith("open_id:")) {
    return withoutProvider.slice("open_id:".length).trim() || null;
  }

  return withoutProvider;
}

export function resolveReceiveIdType(id: string): "chat_id" | "open_id" | "user_id" {
  const trimmed = id.trim();
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (
    lowered.startsWith("chat:") ||
    lowered.startsWith("group:") ||
    lowered.startsWith("channel:")
  ) {
    return "chat_id";
  }
  if (lowered.startsWith("open_id:")) {
    return "open_id";
  }
  if (lowered.startsWith("user:") || lowered.startsWith("dm:")) {
    const normalized = trimmed.replace(/^(user|dm):/i, "").trim();
    return normalized.startsWith(OPEN_ID_PREFIX) ? "open_id" : "user_id";
  }
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return "chat_id";
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return "open_id";
  }
  return "user_id";
}

export function looksLikeFeishuId(raw: string): boolean {
  const trimmed = stripProviderPrefix(raw.trim());
  if (!trimmed) {
    return false;
  }
  if (/^(chat|group|channel|user|dm|open_id):/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith(CHAT_ID_PREFIX)) {
    return true;
  }
  if (trimmed.startsWith(OPEN_ID_PREFIX)) {
    return true;
  }
  return false;
}

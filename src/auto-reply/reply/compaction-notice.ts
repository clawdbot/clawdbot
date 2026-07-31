// Shared compaction formatting and user-facing notice payload helpers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";

export type CompactionNoticePhase =
  | "start"
  | "end"
  | "incomplete"
  | "skipped"
  | "memory_flush_degraded";

const COMPACTION_NOTICE_TEXT: Record<CompactionNoticePhase, string> = {
  start: "🧹 Compacting context...",
  end: "🧹 Compaction complete",
  incomplete: "🧹 Compaction incomplete",
  skipped: "🧹 Compaction not needed",
  memory_flush_degraded: "⚠️ Memory maintenance temporarily failed; continuing your reply.",
};

export function formatCompactionModelRef(provider?: string, model?: string): string {
  const normalizedProvider = normalizeOptionalString(provider);
  const normalizedModel = normalizeOptionalString(model);
  if (normalizedProvider && normalizedModel) {
    return `${sanitizeForLog(normalizedProvider)}/${sanitizeForLog(normalizedModel)}`;
  }
  if (normalizedProvider) {
    return sanitizeForLog(normalizedProvider);
  }
  if (normalizedModel) {
    return sanitizeForLog(normalizedModel);
  }
  return "unknown model";
}

export function shouldNotifyUserAboutCompaction(cfg?: OpenClawConfig): boolean {
  return cfg?.agents?.defaults?.compaction?.notifyUser === true;
}

export function createCompactionNoticePayload(params: {
  phase: CompactionNoticePhase;
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload {
  const payload: ReplyPayload = {
    text: COMPACTION_NOTICE_TEXT[params.phase],
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

export function readCompactionHookMessages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function createCompactionHookNoticePayload(params: {
  messages: string[];
  currentMessageId?: string;
  applyReplyToMode?: (payload: ReplyPayload) => ReplyPayload;
}): ReplyPayload | undefined {
  if (params.messages.length === 0) {
    return undefined;
  }
  const payload: ReplyPayload = {
    text: params.messages.join("\n\n"),
    ...(params.currentMessageId ? { replyToId: params.currentMessageId } : {}),
    replyToCurrent: true,
    isCompactionNotice: true,
  };
  return params.applyReplyToMode ? params.applyReplyToMode(payload) : payload;
}

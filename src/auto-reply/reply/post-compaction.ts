import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

export const DEFAULT_POST_COMPACTION_PROMPT = [
  "Compaction completed.",
  "Read memory/YYYY-MM-DD.md to recover context and continue any pending work.",
  `Reply with ${SILENT_REPLY_TOKEN} if nothing requires attention.`,
].join(" ");

export const DEFAULT_POST_COMPACTION_SYSTEM_PROMPT = [
  "Post-compaction recovery turn.",
  "Check memory files for recent work context and verify if you were mid-task.",
].join(" ");

export type PostCompactionSettings = {
  enabled: boolean;
  prompt: string;
  systemPrompt: string;
};

export function resolvePostCompactionSettings(cfg?: MoltbotConfig): PostCompactionSettings | null {
  const defaults = cfg?.agents?.defaults?.compaction?.postCompaction;
  const enabled = defaults?.enabled ?? true;
  if (!enabled) return null;

  const prompt = defaults?.prompt?.trim() || DEFAULT_POST_COMPACTION_PROMPT;
  const systemPrompt = defaults?.systemPrompt?.trim() || DEFAULT_POST_COMPACTION_SYSTEM_PROMPT;

  return {
    enabled,
    prompt: ensureNoReplyHint(prompt),
    systemPrompt: ensureNoReplyHint(systemPrompt),
  };
}

function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) return text;
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

export function shouldRunPostCompaction(params: {
  entry?: Pick<SessionEntry, "compactionCount" | "postCompactionCompactionCount">;
  memoryCompactionCompleted: boolean;
}): boolean {
  if (!params.memoryCompactionCompleted) return false;

  const compactionCount = params.entry?.compactionCount ?? 0;
  const lastPostCompactionAt = params.entry?.postCompactionCompactionCount;

  // Don't run if we've already run post-compaction for this compaction cycle
  if (typeof lastPostCompactionAt === "number" && lastPostCompactionAt === compactionCount) {
    return false;
  }

  return true;
}

import { formatTokenCount } from "../utils/usage-format.js";
import { formatRawAssistantErrorForUi } from "../agents/pi-embedded-helpers.js";

export function resolveFinalAssistantText(params: {
  finalText?: string | null;
  streamedText?: string | null;
}) {
  const finalText = params.finalText ?? "";
  if (finalText.trim()) return finalText;
  const streamedText = params.streamedText ?? "";
  if (streamedText.trim()) return streamedText;
  return "(no output)";
}

function extractTextBlocks(content: unknown, opts?: { includeThinking?: boolean }): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
    if (
      opts?.includeThinking &&
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      parts.push(`[thinking]\n${record.thinking}`);
    }
  }
  return parts.join("\n").trim();
}

export function extractTextFromMessage(
  message: unknown,
  opts?: { includeThinking?: boolean },
): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const text = extractTextBlocks(record.content, opts);
  if (text) return text;

  const stopReason = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stopReason !== "error") return "";

  const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "";
  return formatRawAssistantErrorForUi(errorMessage);
}

export function formatTokens(total?: number | null, context?: number | null) {
  if (total == null && context == null) return "tokens ?";
  const totalLabel = total == null ? "?" : formatTokenCount(total);
  if (context == null) return `tokens ${totalLabel}`;
  const pct =
    typeof total === "number" && context > 0
      ? Math.min(999, Math.round((total / context) * 100))
      : null;
  return `tokens ${totalLabel}/${formatTokenCount(context)}${pct !== null ? ` (${pct}%)` : ""}`;
}

export function formatContextUsageLine(params: {
  total?: number | null;
  context?: number | null;
  remaining?: number | null;
  percent?: number | null;
}) {
  const totalLabel = typeof params.total === "number" ? formatTokenCount(params.total) : "?";
  const ctxLabel = typeof params.context === "number" ? formatTokenCount(params.context) : "?";
  const pct = typeof params.percent === "number" ? Math.min(999, Math.round(params.percent)) : null;
  const remainingLabel =
    typeof params.remaining === "number" ? `${formatTokenCount(params.remaining)} left` : null;
  const pctLabel = pct !== null ? `${pct}%` : null;
  const extra = [remainingLabel, pctLabel].filter(Boolean).join(", ");
  return `tokens ${totalLabel}/${ctxLabel}${extra ? ` (${extra})` : ""}`;
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

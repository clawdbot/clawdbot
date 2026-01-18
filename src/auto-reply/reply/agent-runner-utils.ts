import type { NormalizedUsage } from "../../agents/usage.js";
import { getChannelDock } from "../../channels/dock.js";
import type { ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import { normalizeChannelId } from "../../channels/registry.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { estimateUsageCost, formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import type { TemplateContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;

/**
 * Build provider-specific threading context for tool auto-injection.
 */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: ClawdbotConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  if (!config) return {};
  const provider = normalizeChannelId(sessionCtx.Provider);
  if (!provider) return {};
  const dock = getChannelDock(provider);
  if (!dock?.threading?.buildToolContext) return {};
  // WhatsApp context isolation keys off conversation id, not the bot's own number.
  const threadingTo =
    provider === "whatsapp"
      ? (sessionCtx.From ?? sessionCtx.To)
      : provider === "imessage" && sessionCtx.ChatType === "direct"
        ? (sessionCtx.From ?? sessionCtx.To)
        : sessionCtx.To;
  const context =
    dock.threading.buildToolContext({
      cfg: config,
      accountId: sessionCtx.AccountId,
      context: {
        Channel: sessionCtx.Provider,
        To: threadingTo,
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider,
  };
}

export const isBunFetchSocketError = (message?: string) =>
  Boolean(message && BUN_FETCH_SOCKET_ERROR_RE.test(message));

export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

export const formatResponseUsageLine = (params: {
  usage?: NormalizedUsage;
  showCost: boolean;
  costConfig?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Usage format: "inout" (default) or "context". */
  format?: "inout" | "context";
  /** Context window size (for "context" format). */
  contextTokens?: number;
}): string | null => {
  const usage = params.usage;
  if (!usage) return null;
  const input = usage.input;
  const output = usage.output;
  if (typeof input !== "number" && typeof output !== "number") return null;

  // Context format: "Usage: 16k/200k (8%)"
  if (params.format === "context" && params.contextTokens && typeof input === "number") {
    const totalUsed = input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    const usedLabel = formatTokenCount(totalUsed);
    const maxLabel = formatTokenCount(params.contextTokens);
    const pct = Math.round((totalUsed / params.contextTokens) * 100);
    return `Usage: ${usedLabel}/${maxLabel} (${pct}%)`;
  }

  // Default "inout" format: "Usage: 10 in / 93 out · est $0.01"
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  const cost =
    params.showCost && typeof input === "number" && typeof output === "number"
      ? estimateUsageCost({
          usage: {
            input,
            output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          cost: params.costConfig,
        })
      : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${inputLabel} in / ${outputLabel} out${suffix}`;
};

export const appendUsageLine = (payloads: ReplyPayload[], line: string): ReplyPayload[] => {
  let index = -1;
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    if (payloads[i]?.text) {
      index = i;
      break;
    }
  }
  if (index === -1) return [...payloads, { text: line }];
  const existing = payloads[index];
  const existingText = existing.text ?? "";
  const separator = existingText.endsWith("\n") ? "" : "\n";
  const next = {
    ...existing,
    text: `${existingText}${separator}${line}`,
  };
  const updated = payloads.slice();
  updated[index] = next;
  return updated;
};

export const resolveEnforceFinalTag = (run: FollowupRun["run"], provider: string) =>
  Boolean(run.enforceFinalTag || isReasoningTagProvider(provider));

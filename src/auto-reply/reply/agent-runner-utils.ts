import type { NormalizedUsage } from "../../agents/usage.js";
import { getChannelDock } from "../../channels/dock.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
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
  const rawProvider = sessionCtx.Provider?.trim().toLowerCase();
  if (!rawProvider) return {};
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., BlueBubbles before plugin registry init)
  const dock = provider ? getChannelDock(provider) : undefined;
  if (!dock?.threading?.buildToolContext) {
    return {
      currentChannelId: sessionCtx.To?.trim() || undefined,
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      hasRepliedRef,
    };
  }
  const context =
    dock.threading.buildToolContext({
      cfg: config,
      accountId: sessionCtx.AccountId,
      context: {
        Channel: sessionCtx.Provider,
        From: sessionCtx.From,
        To: sessionCtx.To,
        ChatType: sessionCtx.ChatType,
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since dock exists
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
}): string | null => {
  const usage = params.usage;
  if (!usage) return null;
  const input = usage.input;
  const output = usage.output;
  if (typeof input !== "number" && typeof output !== "number") return null;
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

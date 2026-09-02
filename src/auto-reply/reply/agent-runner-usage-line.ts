import { expectDefined } from "@openclaw/normalization-core";
import { hasBillableUsage, hasNonzeroUsage, type NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";
import {
  estimateAggregateUsageCost,
  formatTokenCount,
  formatUsd,
  type ModelCostConfig,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { resolveEffectiveResponseUsage } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { buildUsageContract } from "../usage-bar/contract.js";
import { loadUsageBarTemplate } from "../usage-bar/template.js";
import { renderUsageBar } from "../usage-bar/translator.js";

const formatResponseUsageLine = (params: {
  usage?: NormalizedUsage;
  showCost: boolean;
  costConfig?: ModelCostConfig;
}): string | null => {
  const usage = params.usage;
  if (!usage) {
    return null;
  }
  const input = usage.input;
  const output = usage.output;
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : undefined;
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined;
  const canPriceUsage =
    usage.cost !== undefined || (typeof input === "number" && typeof output === "number");
  const cost =
    params.showCost && canPriceUsage
      ? estimateAggregateUsageCost({ usage, cost: params.costConfig })
      : undefined;
  const costLabel = params.showCost ? formatUsd(cost) : undefined;
  if (typeof input !== "number" && typeof output !== "number" && !costLabel) {
    return null;
  }
  const cacheSuffix =
    (typeof cacheRead === "number" && cacheRead > 0) ||
    (typeof cacheWrite === "number" && cacheWrite > 0)
      ? ` · cache ${formatTokenCount(cacheRead ?? 0)} cached / ${formatTokenCount(cacheWrite ?? 0)} new`
      : "";
  const suffix = costLabel ? ` · est ${costLabel}` : "";
  return `Usage: ${inputLabel} in / ${outputLabel} out${cacheSuffix}${suffix}`;
};

export const resolveResponseUsageLine = (params: {
  config: OpenClawConfig;
  agentDir: string;
  sessionRaw?: string | null;
  channel?: string;
  usage?: NormalizedUsage;
  provider?: string;
  model?: string;
  preserveUserFacingSessionState?: boolean;
  replyUsageState?: PluginHookReplyUsageState;
}): string | undefined => {
  const responseUsageMode = resolveEffectiveResponseUsage(
    params.sessionRaw,
    params.config.messages?.responseUsage,
    params.channel,
  );
  const showCost = responseUsageMode === "full";
  const hasUsage = showCost ? hasBillableUsage(params.usage) : hasNonzeroUsage(params.usage);
  if (responseUsageMode === "off" || !hasUsage || params.preserveUserFacingSessionState === true) {
    return undefined;
  }

  const costConfig = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.config,
    agentDir: params.agentDir,
    allowPluginNormalization: false,
  });
  const formatted = formatResponseUsageLine({
    usage: params.usage,
    showCost,
    costConfig,
  });
  const usageTemplate =
    responseUsageMode === "full" && params.replyUsageState
      ? loadUsageBarTemplate(params.config.messages?.usageTemplate)
      : undefined;
  const rendered =
    usageTemplate && params.replyUsageState
      ? renderUsageBar(usageTemplate, buildUsageContract(params.replyUsageState, params.channel))
      : undefined;

  if (rendered) {
    return rendered;
  }
  return formatted ?? undefined;
};

export const appendUsageLine = (payloads: ReplyPayload[], line: string): ReplyPayload[] => {
  let index = -1;
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    if (payloads[i]?.text) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    return [...payloads, { text: line, isStatusNotice: true }];
  }
  const existing = expectDefined(payloads[index], "payloads entry at index");
  const existingText = existing.text ?? "";
  const separator = existingText.endsWith("\n") ? "" : "\n";
  const next = {
    ...existing,
    text: `${existingText}${separator}${line}`,
  };
  const metadata = getReplyPayloadMetadata(existing);
  // Transcript mirrors must track the mutated text or source-reply delivery drifts.
  const nextWithMetadata = metadata
    ? setReplyPayloadMetadata(next, {
        ...metadata,
        ...(metadata.sourceReplyTranscriptMirror
          ? {
              sourceReplyTranscriptMirror: {
                ...metadata.sourceReplyTranscriptMirror,
                text: next.text,
              },
            }
          : {}),
      })
    : next;
  const updated = payloads.slice();
  updated[index] = nextWithMetadata;
  return updated;
};

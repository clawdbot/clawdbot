import { emitAgentRunOutputTokens } from "../infra/agent-events.js";
import type { AssistantMessage, Usage } from "../llm/types.js";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./embedded-agent-runner/usage-accumulator.js";
import { runBestEffortCallback } from "./embedded-agent-subscribe.callback.js";
import { isSubscribeTranscriptOnlyOpenClawAssistantMessage } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import type { AgentSessionEvent } from "./sessions/index.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  hasObservedModelUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type NormalizedUsage,
} from "./usage.js";

function preserveAssistantUsage(message: AssistantMessage, pending: NormalizedUsage | undefined) {
  if (!pending) {
    return;
  }
  const final = normalizeUsage(message.usage);
  if (hasNonzeroUsage(final)) {
    if (
      pending.cost?.totalOrigin === "provider-billed" &&
      final.cost?.totalOrigin !== "provider-billed"
    ) {
      message.usage.cost = {
        ...makeZeroUsageSnapshot().cost,
        ...message.usage.cost,
        ...pending.cost,
      };
    }
    return;
  }

  // Only missing/zero final counters inherit this call's stream; provider totals win.
  const input = pending.input ?? 0;
  const output = pending.output ?? 0;
  const cacheRead = pending.cacheRead ?? 0;
  const cacheWrite = pending.cacheWrite ?? 0;
  message.usage = {
    ...makeZeroUsageSnapshot(),
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(pending.cacheWrite1h !== undefined ? { cacheWrite1h: pending.cacheWrite1h } : {}),
    ...(pending.contextUsage ? { contextUsage: { ...pending.contextUsage } } : {}),
    totalTokens: pending.total ?? input + output + cacheRead + cacheWrite,
    ...(pending.reasoningTokens !== undefined ? { reasoningTokens: pending.reasoningTokens } : {}),
  };
  Object.assign(message.usage.cost, pending.cost);
}

/** Owns model facts at event ingress, independently of queued reply delivery. */
export function createEmbeddedModelState(
  params: SubscribeEmbeddedAgentSessionParams,
  log: Parameters<typeof runBestEffortCallback>[0]["log"],
) {
  const totals = createUsageAccumulator();
  let pending: NormalizedUsage | undefined;
  let lastUsage: NormalizedUsage | undefined;
  let retryUsage: NormalizedUsage | undefined;
  let completed: AssistantMessage | undefined;

  const recordPendingUsage = (raw: Usage) => {
    const usage = normalizeUsage(raw);
    if (!hasObservedModelUsage(usage)) {
      return;
    }
    const cost = usage.cost;
    const next = pending && !hasNonzeroUsage(usage) ? { ...pending, cost } : usage;
    // A provider-billed price remains authoritative over a later catalog estimate.
    if (
      pending?.cost?.totalOrigin === "provider-billed" &&
      cost?.totalOrigin !== "provider-billed"
    ) {
      next.cost = pending.cost;
    }
    pending = next;
  };

  const recordModelUsage = (usage: NormalizedUsage | undefined) => {
    if (!hasObservedModelUsage(usage)) {
      return;
    }
    mergeUsageIntoAccumulator(totals, usage);
    if (params.onRunUsageTotals) {
      runBestEffortCallback({
        label: "run usage totals callback",
        log,
        callback: () => params.onRunUsageTotals?.(toNormalizedUsage(totals) ?? {}),
      });
    }
    if (!hasNonzeroUsage(usage) || !params.lifecycleGeneration) {
      return;
    }
    const data = emitAgentRunOutputTokens({
      runId: params.runId,
      lifecycleGeneration: params.lifecycleGeneration,
      outputTokens: usage.output ?? 0,
    });
    if (data && params.onAgentEvent) {
      runBestEffortCallback({
        label: "usage agent event",
        log,
        callback: () => params.onAgentEvent?.({ stream: "usage", data }),
      });
    }
  };

  return {
    captureModelEvent: (evt: AgentSessionEvent): void => {
      if (evt.type === "compaction_end") {
        if (evt.outcome.status === "completed" && evt.outcome.willRetry) {
          // Retain the prior call only until the retry completes or reports its own usage.
          completed = undefined;
          retryUsage = lastUsage ?? retryUsage;
          lastUsage = undefined;
        }
        return;
      }
      if (
        evt.type !== "message_start" &&
        evt.type !== "message_update" &&
        evt.type !== "message_end"
      ) {
        return;
      }
      const message = evt.message;
      if (
        message.role !== "assistant" ||
        isSubscribeTranscriptOnlyOpenClawAssistantMessage(message)
      ) {
        return;
      }
      switch (evt.type) {
        case "message_start":
          pending = undefined;
          return;
        case "message_update":
          // Capture the prepared message; core consumes done/error before message_end.
          if (evt.assistantMessageEvent.type === "text_end") {
            recordPendingUsage(message.usage);
          }
          return;
        case "message_end":
          recordPendingUsage(message.usage);
          preserveAssistantUsage(message, pending);
          if (hasNonzeroUsage(pending)) {
            lastUsage = { ...pending };
          }
          recordModelUsage(pending);
          pending = undefined;
          // Context-engine projection can later mutate transcript objects; retain this run's result.
          completed = structuredClone(message);
          lastUsage ??= message.stopReason === "error" ? retryUsage : undefined;
          retryUsage = undefined;
          params.onContextAccountingEvent?.({
            kind: "model",
            contextTokens: deriveSessionTotalTokens({
              lastCallUsage: normalizeUsage(message.usage),
            }),
          });
      }
    },
    recordAuxiliaryUsage: (usage: Usage) => recordModelUsage(normalizeUsage(usage)),
    getUsageTotals: () => toNormalizedUsage(totals),
    getLastAssistantUsage: () => normalizeUsage(lastUsage),
    getCurrentAttemptAssistant: () => (completed ? structuredClone(completed) : undefined),
  };
}

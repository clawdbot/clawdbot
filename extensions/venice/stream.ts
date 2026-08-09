// Venice plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  normalizeOpenAICompatibleReasoningReplay,
} from "openclaw/plugin-sdk/provider-stream-shared";

function isVeniceDeepSeekV4ModelId(modelId: unknown): boolean {
  return modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro";
}

function isVeniceGeminiModelId(modelId: unknown): boolean {
  return typeof modelId === "string" && modelId.trim().toLowerCase().startsWith("gemini-");
}

function isVeniceGemini3ModelId(modelId: unknown): boolean {
  return typeof modelId === "string" && /^gemini-3(?:[.-]|$)/.test(modelId.trim().toLowerCase());
}

function stringifyHistoricalValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[Unserializable historical value]";
  }
}

function describeHistoricalToolCall(toolCall: Record<string, unknown>): {
  id?: string;
  name: string;
  text: string;
} {
  const fn =
    toolCall.function && typeof toolCall.function === "object"
      ? (toolCall.function as Record<string, unknown>)
      : {};
  const name = typeof fn.name === "string" && fn.name.length > 0 ? fn.name : "unknown_tool";
  const args = stringifyHistoricalValue(fn.arguments) || "{}";
  return {
    ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
    name,
    text: `[Historical tool call: ${name}(${args})]`,
  };
}

function applyVeniceGeminiToolHistoryCompatibility(
  payload: Record<string, unknown>,
  context: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[1],
  model: Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[0],
): void {
  if (model.provider !== "venice" || !isVeniceGeminiModelId(model.id)) {
    return;
  }
  const historicalToolCallBatches: Array<
    Array<{ id: string; name: string; thoughtSignature?: string }>
  > = [];
  let hasHistoricalSignature = false;
  const requiresUnsignedCallFallback = isVeniceGemini3ModelId(model.id);
  for (const message of context.messages ?? []) {
    if (
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    ) {
      continue;
    }
    const isExactRoute =
      message.api === model.api &&
      message.provider === model.provider &&
      message.model === model.id;
    const batch: Array<{ id: string; name: string; thoughtSignature?: string }> = [];
    for (const block of message.content) {
      if (block.type !== "toolCall" || typeof block.id !== "string") {
        continue;
      }
      const thoughtSignature =
        isExactRoute &&
        typeof block.thoughtSignature === "string" &&
        block.thoughtSignature.length > 0
          ? block.thoughtSignature
          : undefined;
      hasHistoricalSignature ||= thoughtSignature !== undefined;
      batch.push({
        id: block.id,
        name: block.name,
        ...(thoughtSignature ? { thoughtSignature } : {}),
      });
    }
    if (batch.length > 0) {
      historicalToolCallBatches.push(batch);
    }
  }
  if (
    (!hasHistoricalSignature && !requiresUnsignedCallFallback) ||
    !Array.isArray(payload.messages)
  ) {
    return;
  }
  let historicalBatchIndex = 0;
  let pendingDowngradedToolCalls: Map<string, string[]> | undefined;
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      pendingDowngradedToolCalls = undefined;
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "tool") {
      const toolCallId = typeof record.tool_call_id === "string" ? record.tool_call_id : undefined;
      if (!toolCallId) {
        continue;
      }
      const pendingCalls = pendingDowngradedToolCalls;
      if (!pendingCalls) {
        continue;
      }
      const toolNames = pendingCalls.get(toolCallId);
      if (!toolNames) {
        continue;
      }
      const toolName = toolNames.shift();
      if (!toolName) {
        continue;
      }
      if (toolNames.length === 0) {
        pendingCalls.delete(toolCallId);
      }
      const result = stringifyHistoricalValue(record.content);
      for (const key of Object.keys(record)) {
        delete record[key];
      }
      record.role = "user";
      record.content = `[Historical tool result for ${toolName}:\n${result}]`;
      continue;
    }
    pendingDowngradedToolCalls = undefined;
    if (record.role !== "assistant" || !Array.isArray(record.tool_calls)) {
      continue;
    }

    // Tool-call ids are provider-local and can be reused on later turns. Match
    // signature metadata and result rewriting to this assistant occurrence.
    const historicalBatch = historicalToolCallBatches[historicalBatchIndex++];
    let shouldDowngradeBatch = false;
    const describedCalls: Array<ReturnType<typeof describeHistoricalToolCall>> = [];
    for (const [toolCallIndex, toolCall] of record.tool_calls.entries()) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const toolCallRecord = toolCall as Record<string, unknown>;
      const historicalCall = historicalBatch?.[toolCallIndex];
      const describedCall = describeHistoricalToolCall(toolCallRecord);
      const signature =
        historicalCall &&
        historicalCall.id === toolCallRecord.id &&
        historicalCall.name === describedCall.name
          ? historicalCall.thoughtSignature
          : undefined;
      if (signature) {
        toolCallRecord.thought_signature = signature;
      } else if (requiresUnsignedCallFallback) {
        shouldDowngradeBatch = true;
      }
      describedCalls.push(describedCall);
    }
    if (!shouldDowngradeBatch) {
      continue;
    }
    pendingDowngradedToolCalls = new Map<string, string[]>();
    for (const call of describedCalls) {
      if (call.id) {
        const names = pendingDowngradedToolCalls.get(call.id) ?? [];
        names.push(call.name);
        pendingDowngradedToolCalls.set(call.id, names);
      }
    }
    const existingContent = stringifyHistoricalValue(record.content);
    record.content = [existingContent, ...describedCalls.map((call) => call.text)]
      .filter((part) => part.length > 0)
      .join("\n");
    delete record.tool_calls;
  }
}

export function createVeniceStreamWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  void thinkingLevel;
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, context, model }) => {
    if (model.provider === "venice" && isVeniceDeepSeekV4ModelId(model.id)) {
      delete payload.thinking;
      delete payload.reasoning;
      delete payload.reasoning_effort;
      normalizeOpenAICompatibleReasoningReplay(payload, {
        thinkingEnabled: true,
        replaceNullReasoningContent: true,
      });
    }
    applyVeniceGeminiToolHistoryCompatibility(payload, context, model);
  });
}

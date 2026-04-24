import type { Api, Context, Model } from "@mariozechner/pi-ai";

const SYNTHETIC_TOOL_RESULT_APIS = new Set<string>([
  "anthropic-messages",
  "openclaw-anthropic-messages-transport",
  "bedrock-converse-stream",
  "google-generative-ai",
  "openclaw-google-generative-ai-transport",
]);

type PendingToolCall = { id: string; name: string };

function defaultAllowSyntheticToolResults(modelApi: Api): boolean {
  return SYNTHETIC_TOOL_RESULT_APIS.has(modelApi);
}

function appendMissingToolResults(
  result: Context["messages"],
  pendingToolCalls: PendingToolCall[],
  existingToolResultIds: ReadonlySet<string>,
): void {
  for (const toolCall of pendingToolCalls) {
    if (!existingToolResultIds.has(toolCall.id)) {
      result.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
}

export function transformTransportMessages(
  messages: Context["messages"],
  model: Model<Api>,
  normalizeToolCallId?: (
    id: string,
    targetModel: Model<Api>,
    source: { provider: string; api: Api; model: string },
  ) => string,
): Context["messages"] {
  const allowSyntheticToolResults = defaultAllowSyntheticToolResults(model.api);
  const toolCallIdMap = new Map<string, string>();
  const transformed = messages.map((msg) => {
    if (msg.role === "user") {
      return msg;
    }
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      return normalizedId && normalizedId !== msg.toolCallId
        ? { ...msg, toolCallId: normalizedId }
        : msg;
    }
    if (msg.role !== "assistant") {
      return msg;
    }
    const isSameModel =
      msg.provider === model.provider && msg.api === model.api && msg.model === model.id;
    const content: typeof msg.content = [];
    for (const block of msg.content) {
      if (block.type === "thinking") {
        if (block.redacted) {
          if (isSameModel) {
            content.push(block);
          }
          continue;
        }
        if (isSameModel && block.thinkingSignature) {
          content.push(block);
          continue;
        }
        if (!block.thinking.trim()) {
          continue;
        }
        content.push(isSameModel ? block : { type: "text", text: block.thinking });
        continue;
      }
      if (block.type === "text") {
        content.push(isSameModel ? block : { type: "text", text: block.text });
        continue;
      }
      if (block.type !== "toolCall") {
        content.push(block);
        continue;
      }
      let normalizedToolCall = block;
      if (!isSameModel && block.thoughtSignature) {
        normalizedToolCall = { ...normalizedToolCall };
        delete normalizedToolCall.thoughtSignature;
      }
      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(block.id, model, msg);
        if (normalizedId !== block.id) {
          toolCallIdMap.set(block.id, normalizedId);
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      content.push(normalizedToolCall);
    }
    return { ...msg, content };
  });

  const result: Context["messages"] = [];
  let pendingToolCalls: PendingToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  for (const msg of transformed) {
    if (msg.role === "assistant") {
      if (allowSyntheticToolResults && pendingToolCalls.length > 0) {
        appendMissingToolResults(result, pendingToolCalls, existingToolResultIds);
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const toolCalls = msg.content.filter(
        (block): block is Extract<(typeof msg.content)[number], { type: "toolCall" }> =>
          block.type === "toolCall",
      );
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls.map((block) => ({ id: block.id, name: block.name }));
        existingToolResultIds = new Set();
      }
      result.push(msg);
      continue;
    }
    if (msg.role === "toolResult") {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
      continue;
    }
    if (allowSyntheticToolResults && pendingToolCalls.length > 0) {
      appendMissingToolResults(result, pendingToolCalls, existingToolResultIds);
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
    result.push(msg);
  }
  return result;
}

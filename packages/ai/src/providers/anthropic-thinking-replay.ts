import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAiTransportHost } from "../host.js";

type ReplayMessage = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
};

export const ANTHROPIC_OMITTED_REASONING_TEXT = "[assistant reasoning omitted]";

export function applyAnthropicThinkingBindingControls(
  params: { thinking?: unknown },
  directApiKeyBetaHeader: string | undefined,
): Record<string, string> | undefined {
  if (
    directApiKeyBetaHeader === undefined ||
    !isRecord(params.thinking) ||
    params.thinking.type !== "adaptive"
  ) {
    return undefined;
  }
  params.thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
  const betas = directApiKeyBetaHeader
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
  return {
    "anthropic-beta": [...new Set([...betas, "thinking-binding-controls-2026-08-01"])].join(","),
  };
}

export function readAnthropicInputTransformations(event: unknown): unknown[] | undefined {
  if (!isRecord(event) || (event.type !== "message_start" && event.type !== "message_delta")) {
    return undefined;
  }
  const message = isRecord(event.message) ? event.message : undefined;
  const transformations = message?.input_transformations ?? event.input_transformations;
  return Array.isArray(transformations) ? transformations : undefined;
}

export function logAnthropicThinkingDrops(transformations: unknown[] | undefined): void {
  const drops = transformations?.filter(
    (entry): entry is { reason: string; path: string } =>
      isRecord(entry) &&
      entry.type === "thinking_dropped" &&
      typeof entry.reason === "string" &&
      /^(?:prefix|model|organization|end_user)_binding_mismatch$/.test(entry.reason) &&
      typeof entry.path === "string" &&
      /^messages\.\d{1,10}\.content\.\d{1,10}$/.test(entry.path),
  );
  if (!drops?.length) {
    return;
  }
  const paths = drops.slice(0, 5).map(({ reason, path }) => `${reason} at ${path}`);
  getAiTransportHost().logWarn(
    "anthropic",
    `replayed thinking dropped: ${drops.length} block(s) (${paths.join(", ")}${drops.length > 5 ? ", …" : ""})`,
  );
}

function asReplayMessage(value: unknown): ReplayMessage | undefined {
  return value && typeof value === "object" ? (value as ReplayMessage) : undefined;
}

/**
 * Anthropic tool results continue the preceding assistant turn. Preserve that
 * turn's signed thinking even when the next request disables new thinking.
 */
export function findActiveAnthropicToolTurnAssistantIndex(messages: readonly unknown[]): number {
  const toolResultIds = new Set<string>();
  let index = messages.length - 1;

  while (index >= 0) {
    const message = asReplayMessage(messages[index]);
    if (message?.role !== "toolResult") {
      break;
    }
    if (typeof message.toolCallId === "string") {
      toolResultIds.add(message.toolCallId);
    }
    index -= 1;
  }

  if (toolResultIds.size === 0) {
    return -1;
  }

  const assistant = asReplayMessage(messages[index]);
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) {
    return -1;
  }

  const toolCallIds = new Set<string>();
  for (const block of assistant.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; id?: unknown };
    if (
      (record.type === "toolCall" ||
        record.type === "tool_use" ||
        record.type === "function_call") &&
      typeof record.id === "string"
    ) {
      toolCallIds.add(record.id);
    }
  }

  return [...toolResultIds].every((toolCallId) => toolCallIds.has(toolCallId)) ? index : -1;
}

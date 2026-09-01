// Github Copilot plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { sanitizeCopilotReplayResponsePayload } from "./connection-bound-ids.js";
import { stripCopilotAssistantThinkingMessages } from "./replay-policy.js";
import { buildCopilotRuntimeHeaders } from "./runtime-identity.js";

type StreamOptions = Parameters<StreamFn>[2];

function containsCopilotContentType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsCopilotContentType(item, type));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as { type?: unknown; content?: unknown };
  return entry.type === type || containsCopilotContentType(entry.content, type);
}

function inferCopilotInitiator(messages: Context["messages"]): "agent" | "user" {
  const last = messages[messages.length - 1];
  if (!last) {
    return "user";
  }
  if (last.role === "user" && containsCopilotContentType(last.content, "tool_result")) {
    return "agent";
  }
  return last.role === "user" ? "user" : "agent";
}

function hasCopilotVisionInput(messages: Context["messages"]): boolean {
  return messages.some((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return message.content.some((item) => containsCopilotContentType(item, "image"));
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
      return message.content.some((item) => containsCopilotContentType(item, "image"));
    }
    return false;
  });
}

function patchOnPayloadResult(
  result: unknown,
  patchPayload: (payload: unknown) => unknown = sanitizeCopilotReplayResponsePayload,
  fallbackPayload?: unknown,
): unknown {
  if (result && typeof result === "object" && "then" in result) {
    return Promise.resolve(result).then((next) => {
      patchPayload(next === undefined ? fallbackPayload : next);
      return next;
    });
  }
  patchPayload(result === undefined ? fallbackPayload : result);
  return result;
}

type CopilotAnthropicToolBlock = {
  record: Record<string, unknown>;
  idKey: "id" | "tool_use_id";
  rawId: string;
};

function normalizeCopilotAnthropicToolIds(messages: unknown[]): void {
  const blocks: CopilotAnthropicToolBlock[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const record = block as Record<string, unknown>;
      const idKey =
        record.type === "tool_use" ? "id" : record.type === "tool_result" ? "tool_use_id" : null;
      const rawId = idKey ? record[idKey] : undefined;
      if (idKey && typeof rawId === "string") {
        blocks.push({ record, idKey, rawId });
      }
    }
  }

  // Reserve valid IDs globally so an earlier invalid call cannot steal the ID
  // of a later native call; replaying this payload patch must also be stable.
  const validId = /^[a-zA-Z0-9_-]{1,64}$/;
  const reserved = new Set(
    blocks
      .filter((block) => block.idKey === "id" && validId.test(block.rawId))
      .map((block) => block.rawId),
  );
  const used = new Set(reserved);
  const claimedValid = new Set<string>();
  const pendingByRawId = new Map<string, string[]>();
  const lastResolvedByRawId = new Map<string, string>();

  const allocate = (rawId: string): string => {
    if (validId.test(rawId) && !claimedValid.has(rawId)) {
      claimedValid.add(rawId);
      return rawId;
    }

    const base = rawId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    if (!used.has(base)) {
      used.add(base);
      return base;
    }

    for (let occurrence = 2; ; occurrence += 1) {
      const suffix = `_${occurrence}`;
      const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  };

  for (const block of blocks) {
    if (block.idKey === "id") {
      const wireId = allocate(block.rawId);
      const pending = pendingByRawId.get(block.rawId);
      if (pending) {
        pending.push(wireId);
      } else {
        pendingByRawId.set(block.rawId, [wireId]);
      }
      block.record.id = wireId;
      continue;
    }

    // Upstream projection can collapse distinct raw calls to the same string;
    // consume occurrences in order so each result answers its own tool call.
    const pending = pendingByRawId.get(block.rawId);
    const wireId =
      pending?.shift() ?? lastResolvedByRawId.get(block.rawId) ?? allocate(block.rawId);
    if (pending?.length === 0) {
      pendingByRawId.delete(block.rawId);
    }
    lastResolvedByRawId.set(block.rawId, wireId);
    block.record.tool_use_id = wireId;
  }
}

function patchCopilotAnthropicPayload(payload: Record<string, unknown>): void {
  if (Array.isArray(payload.messages)) {
    const messages = stripCopilotAssistantThinkingMessages(payload.messages);
    payload.messages = messages;
    normalizeCopilotAnthropicToolIds(messages);
  }
  applyAnthropicEphemeralCacheControlMarkers(payload);
}

function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  const payloadWrapper = createPayloadPatchStreamWrapper(underlying, ({ payload }) =>
    patchCopilotAnthropicPayload(payload),
  );
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    return payloadWrapper(model, context, {
      ...options,
      onPayload: (payload, payloadModel) =>
        patchOnPayloadResult(
          originalOnPayload?.(payload, payloadModel),
          (replacement) => {
            if (replacement && typeof replacement === "object") {
              patchCopilotAnthropicPayload(replacement as Record<string, unknown>);
            }
          },
          payload,
        ),
    });
  };
}

function wrapCopilotOpenAIResponsesStream(
  baseStreamFn: StreamFn | undefined,
): StreamFn | undefined {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "openai-responses") {
      return underlying(model, context, options);
    }

    const originalOnPayload = options?.onPayload;
    const wrappedOptions: StreamOptions = {
      ...options,
      onPayload: (payload, payloadModel) => {
        sanitizeCopilotReplayResponsePayload(payload);
        return patchOnPayloadResult(originalOnPayload?.(payload, payloadModel), undefined, payload);
      },
    };
    return underlying(model, context, wrappedOptions);
  };
}

export function wrapCopilotProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const stream = wrapCopilotOpenAIResponsesStream(wrapCopilotAnthropicStream(ctx.streamFn));
  if (!stream) {
    return undefined;
  }
  return (model, context, options) => {
    if (
      model.provider !== "github-copilot" ||
      !["anthropic-messages", "openai-responses", "openai-completions"].includes(model.api)
    ) {
      return stream(model, context, options);
    }
    return stream(model, context, {
      ...options,
      headers: buildCopilotRuntimeHeaders({
        config: ctx.config,
        headers: {
          ...model.headers,
          "x-initiator": inferCopilotInitiator(context.messages),
          ...(hasCopilotVisionInput(context.messages) ? { "Copilot-Vision-Request": "true" } : {}),
          ...options?.headers,
        },
      }),
    });
  };
}

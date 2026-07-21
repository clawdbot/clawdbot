import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../internal/shared.js";
/**
 * Anthropic-family request payload policy helpers.
 * Applies service-tier and cache-control markers only when provider endpoint
 * capabilities allow them.
 */
import { resolveProviderRequestCapabilities } from "./host-policy.js";

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicServiceTier = "auto" | "standard_only";

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicEphemeralCacheControl = {
  type: "ephemeral";
  ttl?: "1h";
};

type AnthropicPayloadPolicyInput = {
  api?: string;
  baseUrl?: string;
  cacheRetention?: "short" | "long" | "none";
  enableCacheControl?: boolean;
  provider?: string;
  serviceTier?: AnthropicServiceTier;
};

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicPayloadPolicy = {
  allowsServiceTier: boolean;
  cacheControl: AnthropicEphemeralCacheControl | undefined;
  serviceTier: AnthropicServiceTier | undefined;
};

function resolveBaseUrlHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function isLongTtlEligibleEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== "string") {
    return false;
  }
  const hostname = resolveBaseUrlHostname(baseUrl);
  if (!hostname) {
    return false;
  }
  return (
    hostname === "api.anthropic.com" ||
    hostname === "aiplatform.googleapis.com" ||
    hostname.endsWith("-aiplatform.googleapis.com")
  );
}

/** Resolve Anthropic cache-control marker retention for a request endpoint. */
export function resolveAnthropicEphemeralCacheControl(
  baseUrl: string | undefined,
  cacheRetention: AnthropicPayloadPolicyInput["cacheRetention"],
): AnthropicEphemeralCacheControl | undefined {
  const retention =
    cacheRetention ?? (process.env.OPENCLAW_CACHE_RETENTION === "long" ? "long" : "short");
  if (retention === "none") {
    return undefined;
  }
  // Trust explicit long-retention opt-ins for Anthropic-compatible custom providers.
  // Keep hostname gating for implicit/env-driven long retention so defaults stay conservative.
  const ttl =
    retention === "long" && (cacheRetention === "long" || isLongTtlEligibleEndpoint(baseUrl))
      ? "1h"
      : undefined;
  return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

function applyAnthropicCacheControlToSystem(
  system: unknown,
  cacheControl: AnthropicEphemeralCacheControl,
): void {
  if (!Array.isArray(system)) {
    return;
  }

  const normalizedBlocks: Array<unknown> = [];
  for (const block of system) {
    if (!block || typeof block !== "object") {
      normalizedBlocks.push(block);
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") {
      normalizedBlocks.push(block);
      continue;
    }
    const split = splitSystemPromptCacheBoundary(record.text);
    if (!split) {
      if (record.cache_control === undefined) {
        record.cache_control = cacheControl;
      }
      normalizedBlocks.push(record);
      continue;
    }

    const { cache_control: existingCacheControl, ...rest } = record;
    if (split.stablePrefix) {
      normalizedBlocks.push({
        ...rest,
        text: split.stablePrefix,
        cache_control: existingCacheControl ?? cacheControl,
      });
    }
    if (split.dynamicSuffix) {
      normalizedBlocks.push({
        ...rest,
        text: split.dynamicSuffix,
      });
    }
  }

  system.splice(0, system.length, ...normalizedBlocks);
}

function stripAnthropicSystemPromptBoundary(system: unknown): void {
  if (!Array.isArray(system)) {
    return;
  }

  for (const block of system) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      record.text = stripSystemPromptCacheBoundary(record.text);
    }
  }
}

function applyAnthropicCacheControlToMessages(
  messages: unknown,
  cacheControl: AnthropicEphemeralCacheControl,
  markerLimit: number,
  cacheBreakpointOptOutMessageIndexes: ReadonlySet<number>,
): void {
  if (!Array.isArray(messages) || messages.length === 0 || markerLimit <= 0) {
    return;
  }

  let fallbackToolResult: Record<string, unknown> | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }

    const record = message as Record<string, unknown>;
    if (record.role !== "user" || cacheBreakpointOptOutMessageIndexes.has(i)) {
      continue;
    }

    const content = record.content;
    if (typeof content === "string") {
      if (fallbackToolResult && markerLimit === 1) {
        fallbackToolResult.cache_control = cacheControl;
        return;
      }
      record.content = [
        {
          type: "text",
          text: content,
          cache_control: cacheControl,
        },
      ];
      if (fallbackToolResult && markerLimit > 1) {
        fallbackToolResult.cache_control = cacheControl;
      }
      return;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (!block || typeof block !== "object") {
        continue;
      }

      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type === "text" || blockRecord.type === "image") {
        if (fallbackToolResult && markerLimit === 1) {
          fallbackToolResult.cache_control = cacheControl;
          return;
        }
        blockRecord.cache_control = cacheControl;
        if (fallbackToolResult && markerLimit > 1) {
          fallbackToolResult.cache_control = cacheControl;
        }
        return;
      }
      if (blockRecord.type === "tool_result" && fallbackToolResult === undefined) {
        fallbackToolResult = blockRecord;
      }
    }
  }

  if (fallbackToolResult) {
    fallbackToolResult.cache_control = cacheControl;
  }
}

function countAnthropicCacheControlMarkers(blocks: unknown): number {
  if (!Array.isArray(blocks)) {
    return 0;
  }

  let count = 0;
  for (const block of blocks) {
    if (block && typeof block === "object" && "cache_control" in block) {
      count += 1;
    }
  }
  return count;
}

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export function resolveAnthropicPayloadPolicy(
  input: AnthropicPayloadPolicyInput,
): AnthropicPayloadPolicy {
  const capabilities = resolveProviderRequestCapabilities({
    provider: input.provider,
    api: input.api,
    baseUrl: input.baseUrl,
    capability: "llm",
    transport: "stream",
  });

  return {
    allowsServiceTier: capabilities.allowsAnthropicServiceTier,
    cacheControl:
      input.enableCacheControl === true
        ? resolveAnthropicEphemeralCacheControl(input.baseUrl, input.cacheRetention)
        : undefined,
    serviceTier: input.serviceTier,
  };
}

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export function applyAnthropicPayloadPolicyToParams(
  payloadObj: Record<string, unknown>,
  policy: AnthropicPayloadPolicy,
  cacheBreakpointOptOutMessageIndexes: ReadonlySet<number>,
): void {
  if (
    policy.allowsServiceTier &&
    policy.serviceTier !== undefined &&
    payloadObj.service_tier === undefined
  ) {
    payloadObj.service_tier = policy.serviceTier;
  }

  if (policy.cacheControl) {
    applyAnthropicCacheControlToSystem(payloadObj.system, policy.cacheControl);
  } else {
    stripAnthropicSystemPromptBoundary(payloadObj.system);
  }

  if (!policy.cacheControl) {
    return;
  }

  const usedMarkers =
    countAnthropicCacheControlMarkers(payloadObj.system) +
    countAnthropicCacheControlMarkers(payloadObj.tools);
  applyAnthropicCacheControlToMessages(
    payloadObj.messages,
    policy.cacheControl,
    ANTHROPIC_CACHE_CONTROL_LIMIT - usedMarkers,
    cacheBreakpointOptOutMessageIndexes,
  );
}

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
export function applyAnthropicEphemeralCacheControlMarkers(
  payloadObj: Record<string, unknown>,
  cacheControl: AnthropicEphemeralCacheControl | null = { type: "ephemeral" },
): void {
  const messages = payloadObj.messages;
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages as Array<{ role?: string; content?: unknown }>) {
    if (message.role === "system" || message.role === "developer") {
      if (!cacheControl) {
        continue;
      }
      if (typeof message.content === "string") {
        message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
        continue;
      }
      if (Array.isArray(message.content) && message.content.length > 0) {
        const last = message.content[message.content.length - 1];
        if (last && typeof last === "object") {
          const record = last as Record<string, unknown>;
          if (record.type !== "thinking" && record.type !== "redacted_thinking") {
            record.cache_control = cacheControl;
          }
        }
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const record = block as Record<string, unknown>;
        if (record.type === "thinking" || record.type === "redacted_thinking") {
          delete record.cache_control;
        }
      }
    }
  }
}

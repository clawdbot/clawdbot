import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CacheRetention } from "../types.js";
import { splitSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import type { ResolvedOpenAICompletionsCompat } from "./openai-completions-compat.js";

// Payload identity lasts only for one request. Wrappers must not reinterpret a
// builder's already-shaped boundary or its transient-message exclusions.
const shapedPayloads = new WeakSet<object>();

type CacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };

export function resolveCompletionsCacheControl(
  compat: Pick<
    ResolvedOpenAICompletionsCompat,
    "cacheControlFormat" | "supportsLongCacheRetention" | "configuredSupportsLongCacheRetention"
  >,
  retention: CacheRetention,
  openRouterRoute: boolean,
): CacheControl | undefined {
  if (compat.cacheControlFormat !== "anthropic" || retention === "none") {
    return undefined;
  }
  return {
    type: "ephemeral",
    ...(retention === "long" &&
    compat.supportsLongCacheRetention &&
    (openRouterRoute || compat.configuredSupportsLongCacheRetention === true)
      ? { ttl: "1h" }
      : {}),
  };
}

/** Shared Chat Completions policy; repeated wrapper application preserves existing checkpoints. */
export function applyCompletionsAnthropicCacheControl(
  payload: Record<string, unknown>,
  cacheControl: CacheControl | null = { type: "ephemeral" },
  cacheOptOutIndexes: ReadonlySet<number> = new Set(),
  markTools = true,
  markMessages = true,
): void {
  if (shapedPayloads.has(payload)) {
    return;
  }
  shapedPayloads.add(payload);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const tools = Array.isArray(payload.tools) ? payload.tools.filter(isRecord) : [];
  const blocks = messages
    .filter(isRecord)
    .flatMap((message) => (Array.isArray(message.content) ? message.content.filter(isRecord) : []));
  // This policy owns at most three breakpoints: tools, stable system, history.
  for (const block of [...tools, ...blocks]) {
    delete block.cache_control;
  }
  if (!cacheControl) {
    return;
  }
  const markText = (message: Record<string, unknown>, splitBoundary: boolean): boolean => {
    if (typeof message.content === "string" && message.content) {
      message.content = [{ type: "text", text: message.content }];
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      return false;
    }
    for (let i = content.length - 1; i >= 0; i--) {
      const block: unknown = content[i];
      if (
        !isRecord(block) ||
        block.type !== "text" ||
        typeof block.text !== "string" ||
        !block.text
      ) {
        continue;
      }
      const split = splitBoundary ? splitSystemPromptCacheBoundary(block.text) : undefined;
      if (split) {
        content.splice(
          i,
          1,
          ...(split.stablePrefix
            ? [{ type: "text", text: split.stablePrefix, cache_control: cacheControl }]
            : []),
          ...(split.dynamicSuffix ? [{ type: "text", text: split.dynamicSuffix }] : []),
        );
        if (!split.stablePrefix) {
          return false;
        }
      } else {
        block.cache_control = cacheControl;
      }
      return true;
    }
    return false;
  };

  const lastTool = tools.at(-1);
  if (markTools && lastTool) {
    lastTool.cache_control = cacheControl;
  }
  // String-only endpoints cannot carry block markers; wrappers retain this decision.
  if (!markMessages) {
    return;
  }
  const system = messages.find(
    (message) => isRecord(message) && (message.role === "system" || message.role === "developer"),
  );
  if (isRecord(system)) {
    markText(system, true);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message: unknown = messages[i];
    if (
      !cacheOptOutIndexes.has(i) &&
      isRecord(message) &&
      (message.role === "user" || message.role === "tool") &&
      markText(message, false)
    ) {
      return;
    }
  }
}

import type { BetaContextManagementConfig } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { TextBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getAiTransportHost } from "../host.js";
import type { AnthropicContextManagementOptions } from "../provider-options.js";
import { isAnthropicOAuthApiKey } from "../providers/anthropic-auth-headers.js";
import { ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK } from "../providers/anthropic-model-contract.js";
import { resolveCacheRetention } from "../providers/cache-retention.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";
/**
 * Anthropic-family request payload policy helpers.
 * Applies service-tier and cache-control markers only when provider endpoint
 * capabilities allow them.
 */
import { resolveProviderEndpoint, resolveProviderRequestCapabilities } from "./host-policy.js";
import { parsePositiveInteger } from "./transport-utils.js";

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicServiceTier = "auto" | "standard_only";

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicEphemeralCacheControl = {
  type: "ephemeral";
  ttl?: "1h" | "5m";
};

type AnthropicPayloadPolicyInput = {
  api?: string;
  baseUrl?: string;
  cacheRetention?: "short" | "long" | "none";
  cacheTtlPruning?: AnthropicContextManagementOptions["cacheTtlPruning"];
  contextWindow?: unknown;
  enableCacheControl?: boolean;
  enableServerCompaction?: boolean;
  extraParams?: Record<string, unknown>;
  provider?: string;
  serviceTier?: AnthropicServiceTier;
};

const ANTHROPIC_CACHE_CONTROL_LIMIT = 4;
const ANTHROPIC_COMPACT_THRESHOLD_MIN = 50_000;

/** @deprecated Anthropic-family provider payload helper; do not use from third-party plugins. */
type AnthropicPayloadPolicy = {
  allowsServiceTier: boolean;
  cacheControl: AnthropicEphemeralCacheControl | undefined;
  compactThreshold: number;
  serviceTier: AnthropicServiceTier | undefined;
  useServerCompaction: boolean;
  toolClearing?: {
    trigger: number;
    clearAtLeast: number;
    tools: NonNullable<AnthropicContextManagementOptions["cacheTtlPruning"]>["tools"];
  };
};

/** Resolve the Anthropic input-token trigger, including the API's minimum. */
function resolveAnthropicCompactThreshold(contextWindow: unknown, configured: unknown): number {
  const configuredThreshold = parsePositiveInteger(configured);
  if (configuredThreshold !== undefined) {
    return Math.max(ANTHROPIC_COMPACT_THRESHOLD_MIN, configuredThreshold);
  }
  const resolvedContextWindow = parsePositiveInteger(contextWindow);
  return Math.max(
    ANTHROPIC_COMPACT_THRESHOLD_MIN,
    resolvedContextWindow === undefined
      ? ANTHROPIC_COMPACT_THRESHOLD_MIN
      : Math.floor(resolvedContextWindow * 0.7),
  );
}

/** Resolve the server-compaction gate and effective threshold for an Anthropic route. */
export function resolveAnthropicServerCompactionPlan(
  model: {
    provider?: unknown;
    api?: unknown;
    baseUrl?: string;
    contextWindow?: unknown;
  },
  extraParams?: Record<string, unknown>,
  apiKey?: string,
): { enabled: boolean; threshold?: number } {
  const enabled =
    extraParams?.anthropicServerCompaction === true &&
    !isAnthropicOAuthApiKey(apiKey) &&
    normalizeOptionalLowercaseString(model.api) === "anthropic-messages" &&
    isDirectAnthropicModel(model);
  return {
    enabled,
    ...(enabled
      ? {
          threshold: resolveAnthropicCompactThreshold(
            model.contextWindow,
            extraParams?.anthropicCompactThreshold,
          ),
        }
      : {}),
  };
}

export function isDirectAnthropicModel(model: { provider?: unknown; baseUrl?: string }): boolean {
  const baseUrl = model.baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim();
  const endpointModel = baseUrl === model.baseUrl ? model : { ...model, baseUrl };
  const endpointClass = resolveProviderEndpoint(endpointModel).endpointClass;
  return (
    normalizeOptionalLowercaseString(model.provider) === "anthropic" &&
    (endpointClass === "anthropic-public" ||
      (endpointClass === "default" &&
        (!baseUrl || resolveBaseUrlHostname(baseUrl) === "api.anthropic.com")))
  );
}

export function isAnthropicServerToolClearingEnabled(
  model: { provider?: unknown; api?: unknown; baseUrl?: string },
  apiKey?: string,
): boolean {
  const resolvedApiKey = apiKey && getAiTransportHost().resolveSecretSentinel(apiKey);
  // Only a prepared direct API-key request can take ownership away from client pruning.
  return (
    Boolean(resolvedApiKey?.trim()) &&
    !isAnthropicOAuthApiKey(resolvedApiKey) &&
    normalizeOptionalLowercaseString(model.api) === "anthropic-messages" &&
    isDirectAnthropicModel(model)
  );
}

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
    hostname === "aiplatform.us.rep.googleapis.com" ||
    hostname === "aiplatform.eu.rep.googleapis.com" ||
    hostname.endsWith("-aiplatform.googleapis.com")
  );
}

/** Resolve Anthropic cache-control marker retention for a request endpoint. */
export function resolveAnthropicEphemeralCacheControl(
  baseUrl: string | undefined,
  cacheRetention: AnthropicPayloadPolicyInput["cacheRetention"],
): AnthropicEphemeralCacheControl | undefined {
  const retention = resolveCacheRetention(cacheRetention);
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

export function resolveAnthropicCacheOptions(
  model: Model<"anthropic-messages">,
  cacheRetention?: "short" | "long" | "none",
) {
  const supportsLongCacheRetention =
    model.compat?.supportsLongCacheRetention ?? model.provider !== "fireworks";
  const baseUrl =
    model.baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  const cacheControl = resolveAnthropicEphemeralCacheControl(baseUrl, cacheRetention);
  return {
    cacheControl:
      cacheControl && !supportsLongCacheRetention ? { type: "ephemeral" as const } : cacheControl,
    supportsCacheControlOnTools:
      model.compat?.supportsCacheControlOnTools ?? model.provider !== "fireworks",
  };
}

export function buildAnthropicSystemBlocks(
  systemPrompt: string | undefined,
  isOAuthToken: boolean,
  cacheControl: AnthropicEphemeralCacheControl | undefined,
): TextBlockParam[] | undefined {
  const blocks: TextBlockParam[] = systemPrompt
    ? [{ type: "text", text: sanitizeSurrogates(systemPrompt) }]
    : [];
  if (cacheControl) {
    applyAnthropicCacheControlToSystem(blocks, cacheControl);
  } else {
    stripAnthropicSystemPromptBoundary(blocks);
  }
  if (systemPrompt && blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  if (isOAuthToken) {
    // The stable application prompt covers the OAuth preamble too; keep slots for history.
    const identityCacheControl = blocks.some((block) => block.cache_control)
      ? undefined
      : cacheControl;
    blocks.unshift(
      { type: "text", text: ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        ...(identityCacheControl ? { cache_control: identityCacheControl } : {}),
      },
    );
  }
  return blocks.length > 0 ? blocks : undefined;
}

/** Allocate tool and history checkpoints around the prepared stable system blocks. */
export function applyAnthropicRequestCacheControl(
  payload: { system?: unknown; tools?: unknown; messages?: unknown },
  cacheControl: AnthropicEphemeralCacheControl | undefined,
  supportsCacheControlOnTools: boolean,
  cacheBreakpointOptOutMessageIndexes: ReadonlySet<number> = new Set(),
): void {
  if (!cacheControl) {
    return;
  }
  if (supportsCacheControlOnTools && Array.isArray(payload.tools)) {
    const lastTool = payload.tools.at(-1);
    if (isRecord(lastTool)) {
      lastTool.cache_control = cacheControl;
    }
  }
  const usedMarkers =
    countAnthropicCacheControlMarkers(payload.system) +
    countAnthropicCacheControlMarkers(payload.tools);
  applyAnthropicCacheControlToMessages(
    payload.messages,
    cacheControl,
    ANTHROPIC_CACHE_CONTROL_LIMIT - usedMarkers,
    cacheBreakpointOptOutMessageIndexes,
  );
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

/** Apply one shared deepest-stable-message cache breakpoint policy. */
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
  model?: Model,
): AnthropicPayloadPolicy {
  const capabilities = resolveProviderRequestCapabilities(
    {
      provider: input.provider,
      api: input.api,
      baseUrl: input.baseUrl,
      capability: "llm",
      transport: "stream",
    },
    model,
  );
  const serverCompactionPlan = resolveAnthropicServerCompactionPlan(input, input.extraParams);

  return {
    allowsServiceTier: capabilities.allowsAnthropicServiceTier,
    cacheControl:
      input.enableCacheControl === true
        ? resolveAnthropicEphemeralCacheControl(input.baseUrl, input.cacheRetention)
        : undefined,
    compactThreshold:
      serverCompactionPlan.threshold ??
      resolveAnthropicCompactThreshold(
        input.contextWindow,
        input.extraParams?.anthropicCompactThreshold,
      ),
    serviceTier: input.serviceTier,
    useServerCompaction: input.enableServerCompaction === true && serverCompactionPlan.enabled,
    ...(input.cacheTtlPruning &&
    normalizeOptionalLowercaseString(input.api) === "anthropic-messages" &&
    isDirectAnthropicModel(input)
      ? {
          toolClearing: {
            trigger: Math.max(
              50_000,
              Math.floor((parsePositiveInteger(input.contextWindow) ?? 0) * 0.3),
            ),
            clearAtLeast: Math.max(
              12_500,
              Math.floor((parsePositiveInteger(input.contextWindow) ?? 0) * 0.05),
            ),
            tools: input.cacheTtlPruning.tools,
          },
        }
      : {}),
  };
}

type AnthropicContextManagementPayload = {
  context_management?: unknown;
  tools?: unknown;
  messages?: unknown;
};

function resolveToolClearingExclusions(
  payload: AnthropicContextManagementPayload,
  filter: NonNullable<AnthropicPayloadPolicy["toolClearing"]>["tools"],
): string[] {
  const compile = (patterns: string[] | undefined) =>
    (patterns ?? [])
      .map((pattern) => pattern.trim().toLowerCase())
      .filter(Boolean)
      .map(
        (pattern) =>
          new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*")}$`),
      );
  const allow = compile(filter?.allow);
  const deny = compile(filter?.deny);
  if (allow.length === 0 && deny.length === 0) {
    return [];
  }
  const excluded = new Set(
    filter?.deny?.map((name) => name.trim()).filter((name) => name && !name.includes("*")),
  );
  const candidates = new Set<string>();
  for (const tool of Array.isArray(payload.tools) ? payload.tools : []) {
    if (isRecord(tool) && typeof tool.name === "string") {
      candidates.add(tool.name);
    }
  }
  // Pruning filters apply to history too: removing a tool must not make its results clearable.
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
        candidates.add(block.name);
      }
    }
  }
  for (const toolName of candidates) {
    const name = toolName.trim().toLowerCase();
    if (
      deny.some((pattern) => pattern.test(name)) ||
      (allow.length > 0 && !allow.some((pattern) => pattern.test(name)))
    ) {
      excluded.add(toolName);
    }
  }
  return [...excluded].toSorted();
}

function applyAnthropicContextManagementEdits(
  payload: AnthropicContextManagementPayload,
  policy: AnthropicPayloadPolicy,
): void {
  if (payload.context_management !== undefined) {
    return;
  }
  const edits: NonNullable<BetaContextManagementConfig["edits"]> = [];
  if (policy.toolClearing) {
    edits.push({
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: policy.toolClearing.trigger },
      keep: { type: "tool_uses", value: 3 },
      clear_at_least: { type: "input_tokens", value: policy.toolClearing.clearAtLeast },
      exclude_tools: resolveToolClearingExclusions(payload, policy.toolClearing.tools),
      clear_tool_inputs: false,
    });
  }
  // Clear cheap-to-discard tool results before asking the server to summarize the remaining context.
  if (policy.useServerCompaction) {
    edits.push({
      type: "compact_20260112",
      trigger: { type: "input_tokens", value: policy.compactThreshold },
    });
  }
  if (edits.length > 0) {
    payload.context_management = { edits };
  }
}

export function applyAnthropicContextManagementToRequest(
  payload: AnthropicContextManagementPayload,
  model: Model,
  options: AnthropicContextManagementOptions | undefined,
  directApiKeyBetaHeader: string | undefined,
): void {
  if (
    directApiKeyBetaHeader === undefined ||
    (!options?.cacheTtlPruning && !options?.anthropicServerCompaction)
  ) {
    return;
  }
  applyAnthropicContextManagementEdits(
    payload,
    resolveAnthropicPayloadPolicy({
      ...model,
      // This adapter owns the wire API; simple-dispatch aliases remain on the replay identity.
      api: "anthropic-messages",
      enableServerCompaction: true,
      extraParams: { ...options },
      cacheTtlPruning: options?.cacheTtlPruning,
    }),
  );
}

export function resolveAnthropicContextManagementBetaHeader(
  payload: AnthropicContextManagementPayload,
  directApiKeyBetaHeader: string | undefined,
): string | undefined {
  if (directApiKeyBetaHeader === undefined || !isRecord(payload.context_management)) {
    return directApiKeyBetaHeader;
  }
  const edits = payload.context_management.edits;
  const betas = new Set(
    directApiKeyBetaHeader
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean),
  );
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!isRecord(edit)) {
      continue;
    }
    if (edit.type === "clear_tool_uses_20250919") {
      betas.add("context-management-2025-06-27");
    } else if (edit.type === "compact_20260112") {
      betas.add("compact-2026-01-12");
    }
  }
  return [...betas].join(",");
}

export function logAnthropicContextEdits(event: unknown): void {
  if (!isRecord(event) || !isRecord(event.context_management)) {
    return;
  }
  const edits = event.context_management.applied_edits;
  let clearedTools = 0;
  let clearedTokens = 0;
  for (const edit of Array.isArray(edits) ? edits : []) {
    if (
      !isRecord(edit) ||
      edit.type !== "clear_tool_uses_20250919" ||
      typeof edit.cleared_tool_uses !== "number" ||
      !Number.isSafeInteger(edit.cleared_tool_uses) ||
      edit.cleared_tool_uses < 0 ||
      typeof edit.cleared_input_tokens !== "number" ||
      !Number.isSafeInteger(edit.cleared_input_tokens) ||
      edit.cleared_input_tokens < 0
    ) {
      continue;
    }
    clearedTools = Math.min(Number.MAX_SAFE_INTEGER, clearedTools + edit.cleared_tool_uses);
    clearedTokens = Math.min(Number.MAX_SAFE_INTEGER, clearedTokens + edit.cleared_input_tokens);
  }
  if (clearedTools > 0 || clearedTokens > 0) {
    getAiTransportHost().logInfo(
      "anthropic",
      `server-side context edit: cleared ${clearedTools} tool results (${clearedTokens} input tokens)`,
    );
  }
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

  applyAnthropicContextManagementEdits(payloadObj, policy);

  applyAnthropicRequestCacheControl(
    payloadObj,
    policy.cacheControl,
    false,
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

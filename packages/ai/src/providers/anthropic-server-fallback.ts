import { stableStringify } from "@openclaw/normalization-core";
import type { AssistantMessageDiagnostic, Model } from "../types.js";
import {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeOpus5ModelIdentity,
} from "./anthropic-model-contract.js";

/** Anthropic beta that re-serves safety refusals on an allowed fallback model. */
export const ANTHROPIC_SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Let Anthropic select the recommended model for each refusal category. */
export const ANTHROPIC_SERVER_SIDE_FALLBACKS = "default" as const;

export function isCanonicalAnthropicPublicUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value?.trim() || "https://api.anthropic.com");
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.anthropic.com" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

export function anthropicRequestEnablesServerFallback(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const fallbacks = (payload as { fallbacks?: unknown }).fallbacks;
  return (
    fallbacks === ANTHROPIC_SERVER_SIDE_FALLBACKS ||
    (Array.isArray(fallbacks) && fallbacks.length > 0)
  );
}

export type AnthropicServerFallbackAuthorization = {
  fallbacksFingerprint: string;
  model: string;
};

export function snapshotAnthropicServerFallbackAuthorization(
  payload: unknown,
): AnthropicServerFallbackAuthorization | undefined {
  if (!anthropicRequestEnablesServerFallback(payload)) {
    return undefined;
  }
  const record = payload as { fallbacks: unknown; model?: unknown };
  if (typeof record.model !== "string") {
    return undefined;
  }
  return {
    fallbacksFingerprint: stableStringify(record.fallbacks),
    model: record.model,
  };
}

export function assertAnthropicServerFallbackPayloadAuthorized(params: {
  authorization?: AnthropicServerFallbackAuthorization;
  payload: unknown;
}): void {
  if (!anthropicRequestEnablesServerFallback(params.payload)) {
    return;
  }
  const payloadFallbacks = (params.payload as { fallbacks?: unknown }).fallbacks;
  const payloadModel =
    params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
      ? (params.payload as { model?: unknown }).model
      : undefined;
  if (
    !params.authorization ||
    typeof payloadModel !== "string" ||
    payloadModel !== params.authorization.model ||
    stableStringify(payloadFallbacks) !== params.authorization.fallbacksFingerprint
  ) {
    throw new Error(
      "Anthropic server fallback requires a supported model, first-party endpoint, beta header, and guarded dispatch",
    );
  }
}

export function preserveAnthropicServerFallbackBetaHeader<T extends string | null>(
  headers: Record<string, T> | undefined,
  required: boolean,
): Record<string, T> | undefined {
  if (!required) {
    return headers;
  }
  const next = { ...headers };
  const betaKeys = Object.keys(next).filter((key) => key.toLowerCase() === "anthropic-beta");
  const betaTokens = betaKeys.flatMap((key) => {
    const value = next[key];
    return typeof value === "string"
      ? value
          .split(",")
          .map((token) => token.trim())
          .filter(Boolean)
      : [];
  });
  for (const key of betaKeys) {
    delete next[key];
  }
  if (!betaTokens.includes(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA)) {
    betaTokens.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
  }
  next["anthropic-beta"] = betaTokens.join(",") as T;
  return next;
}

// Anthropic's current default routes serve fallback output on Opus 5 or 4.8,
// which share the same standard and fast-mode rates.
export const CLAUDE_OPUS_FALLBACK_MODEL_COST = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
} as const;

export type AnthropicFallbackBoundary = {
  fromModel: string | null;
  toModel: string | null;
};

export function resolveAnthropicFallbackModelIdentity(modelId: string | null): string | null {
  if (!modelId?.trim()) {
    return null;
  }
  const ref = { id: modelId };
  const normalized = resolveClaudeModelIdentity(ref);
  if (normalized === "opus" || normalized === "opus-5" || resolveClaudeOpus5ModelIdentity(ref)) {
    return "claude-opus-5";
  }
  if (resolveClaudeFable5ModelIdentity(ref)) {
    return "claude-fable-5";
  }
  if (/^claude-opus-4-8(?=$|[^a-z0-9])/.test(normalized)) {
    return "claude-opus-4-8";
  }
  return normalized || null;
}

function isClaudeOpusFallbackModel(modelId: string): boolean {
  return modelId === "claude-opus-5" || modelId === "claude-opus-4-8";
}

/** Resolve billed rates from the serving model reported by Anthropic's fallback stream. */
export function resolveAnthropicFallbackServingModelCost(params: {
  requestedModelId: string;
  servingModelId: string | null;
  requestedCost: Model["cost"];
}): Model["cost"] {
  const requestedModelId = resolveAnthropicFallbackModelIdentity(params.requestedModelId);
  const servingModelId = resolveAnthropicFallbackModelIdentity(params.servingModelId);
  if (
    !servingModelId ||
    servingModelId === requestedModelId ||
    !isClaudeOpusFallbackModel(servingModelId)
  ) {
    return params.requestedCost;
  }
  if (requestedModelId && isClaudeOpusFallbackModel(requestedModelId)) {
    return params.requestedCost;
  }
  return CLAUDE_OPUS_FALLBACK_MODEL_COST;
}

function readBoundaryModel(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const model = (value as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model : null;
}

/** Reads a `fallback` content block marking where one model's output gives way to the next. */
export function readAnthropicFallbackBoundary(block: unknown): AnthropicFallbackBoundary | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const record = block as { type?: unknown; from?: unknown; to?: unknown };
  if (record.type !== "fallback") {
    return null;
  }
  return {
    fromModel: readBoundaryModel(record.from),
    toModel: readBoundaryModel(record.to),
  };
}

/**
 * Drops pre-fallback thinking/tool calls while preserving the text prefix that
 * the serving model continued. Dropped tool calls must never execute or replay.
 */
export function applyAnthropicFallbackBoundary(params: {
  output: {
    content: Array<{ type: string }>;
    responseModel?: string;
    diagnostics?: AssistantMessageDiagnostic[];
  };
  boundary: AnthropicFallbackBoundary;
  provider: string;
}): void {
  const { output } = params;
  applyAnthropicFallbackContentBoundary(output);
  applyAnthropicFallbackServingModel(params);
}

/** Drops pre-fallback executable content while retaining the continuation text prefix. */
export function applyAnthropicFallbackContentBoundary(output: {
  content: Array<{ type: string }>;
}): void {
  const survivors = output.content.filter((block) => block.type === "text");
  for (const survivor of survivors) {
    delete (survivor as { textSignature?: string }).textSignature;
  }
  output.content.splice(0, output.content.length, ...survivors);
}

/** Records one authoritative serving-model transition without rewriting content. */
export function applyAnthropicFallbackServingModel(params: {
  output: {
    content: Array<{ type: string }>;
    responseModel?: string;
    diagnostics?: AssistantMessageDiagnostic[];
  };
  boundary: AnthropicFallbackBoundary;
  provider: string;
}): void {
  const { output, boundary } = params;
  if (boundary.toModel) {
    output.responseModel = boundary.toModel;
  }
  output.diagnostics = [
    ...(output.diagnostics ?? []),
    {
      type: "provider_fallback",
      timestamp: Date.now(),
      details: {
        provider: params.provider,
        fromModel: boundary.fromModel,
        toModel: boundary.toModel,
      },
    },
  ];
}

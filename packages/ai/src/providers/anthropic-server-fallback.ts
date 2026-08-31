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

function resolveFallbackModelIdentity(modelId: string | null): string | null {
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
  const requestedModelId = resolveFallbackModelIdentity(params.requestedModelId);
  const servingModelId = resolveFallbackModelIdentity(params.servingModelId);
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
  const { output, boundary } = params;
  const survivors = output.content.filter((block) => block.type === "text");
  for (const survivor of survivors) {
    delete (survivor as { textSignature?: string }).textSignature;
  }
  output.content.splice(0, output.content.length, ...survivors);
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

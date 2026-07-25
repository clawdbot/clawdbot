import type { AssistantMessageDiagnostic } from "../types.js";

/** Anthropic beta that re-serves safety refusals on an allowed fallback model. */
export const ANTHROPIC_SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

// Anthropic documents claude-opus-4-8 as the allowed fallback for claude-fable-5.
export const CLAUDE_FABLE_5_FALLBACK_MODEL = "claude-opus-4-8";

// Fallback-served turns bill at the serving model's rates.
export const CLAUDE_FABLE_5_FALLBACK_MODEL_COST = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite: 6.25,
} as const;

export function buildAnthropicServerSideFallbacks(): Array<{ model: string }> {
  return [{ model: CLAUDE_FABLE_5_FALLBACK_MODEL }];
}

export type AnthropicFallbackBoundary = {
  fromModel: string | null;
  toModel: string | null;
};

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

import { AnthropicVertex as AnthropicVertexSdk } from "@anthropic-ai/vertex-sdk";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  streamAnthropic as streamAnthropicDefault,
  type AnthropicOptions,
  type Model,
} from "@earendil-works/pi-ai";
import {
  applyAnthropicPayloadPolicyToParams,
  resolveAnthropicPayloadPolicy,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { resolveAnthropicVertexClientRegion, resolveAnthropicVertexProjectId } from "./region.js";

type AnthropicVertexEffort = NonNullable<AnthropicOptions["effort"]>;
type AnthropicVertexAdaptiveEffort = AnthropicVertexEffort | "xhigh";
type AnthropicVertexClientOptions = {
  baseURL?: string;
  projectId?: string;
  region: string;
};

export type AnthropicVertexStreamDeps = {
  AnthropicVertex: new (options: AnthropicVertexClientOptions) => unknown;
  streamAnthropic: typeof streamAnthropicDefault;
};

const defaultAnthropicVertexStreamDeps: AnthropicVertexStreamDeps = {
  AnthropicVertex: AnthropicVertexSdk as AnthropicVertexStreamDeps["AnthropicVertex"],
  streamAnthropic: streamAnthropicDefault,
};

function isClaudeOpus47Model(modelId: string): boolean {
  return modelId.includes("opus-4-7") || modelId.includes("opus-4.7");
}

function isClaudeOpus46Model(modelId: string): boolean {
  return modelId.includes("opus-4-6") || modelId.includes("opus-4.6");
}

function supportsAdaptiveThinking(modelId: string): boolean {
  return (
    isClaudeOpus47Model(modelId) ||
    isClaudeOpus46Model(modelId) ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

function mapAnthropicAdaptiveEffort(
  reasoning: string,
  modelId: string,
): AnthropicVertexAdaptiveEffort {
  const effortMap: Record<string, AnthropicVertexAdaptiveEffort> = {
    minimal: "low",
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: isClaudeOpus47Model(modelId) ? "xhigh" : isClaudeOpus46Model(modelId) ? "max" : "high",
  };
  return effortMap[reasoning] ?? "high";
}

function resolveAnthropicVertexMaxTokens(params: {
  modelMaxTokens: number | undefined;
  requestedMaxTokens: number | undefined;
}): number | undefined {
  const modelMax =
    typeof params.modelMaxTokens === "number" &&
    Number.isFinite(params.modelMaxTokens) &&
    params.modelMaxTokens > 0
      ? Math.floor(params.modelMaxTokens)
      : undefined;
  const requested =
    typeof params.requestedMaxTokens === "number" &&
    Number.isFinite(params.requestedMaxTokens) &&
    params.requestedMaxTokens > 0
      ? Math.floor(params.requestedMaxTokens)
      : undefined;

  if (modelMax !== undefined && requested !== undefined) {
    return Math.min(requested, modelMax);
  }
  return requested ?? modelMax;
}

function createAnthropicVertexOnPayload(params: {
  model: { api: string; baseUrl?: string; provider: string };
  cacheRetention: AnthropicOptions["cacheRetention"] | undefined;
  onPayload: AnthropicOptions["onPayload"] | undefined;
}): NonNullable<AnthropicOptions["onPayload"]> {
  const policy = resolveAnthropicPayloadPolicy({
    provider: params.model.provider,
    api: params.model.api,
    baseUrl: params.model.baseUrl,
    cacheRetention: params.cacheRetention,
    enableCacheControl: true,
  });

  function applyPolicy(payload: unknown): unknown {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      applyAnthropicPayloadPolicyToParams(payload as Record<string, unknown>, policy);
    }
    return payload;
  }

  return async (payload, model) => {
    const shapedPayload = applyPolicy(payload);
    const nextPayload = await params.onPayload?.(shapedPayload, model);
    if (nextPayload === undefined || nextPayload === shapedPayload) {
      return shapedPayload;
    }
    return applyPolicy(nextPayload);
  };
}

/**
 * Create a StreamFn that routes through pi-ai's `streamAnthropic` with an
 * injected `AnthropicVertex` client.  All streaming, message conversion, and
 * event handling is handled by pi-ai — we only supply the GCP-authenticated
 * client and map SimpleStreamOptions → AnthropicOptions.
 */
export function createAnthropicVertexStreamFn(
  projectId: string | undefined,
  region: string,
  baseURL?: string,
  deps: AnthropicVertexStreamDeps = defaultAnthropicVertexStreamDeps,
): StreamFn {
  const client = new deps.AnthropicVertex({
    region,
    ...(baseURL ? { baseURL } : {}),
    ...(projectId ? { projectId } : {}),
  });

  return (model, context, options) => {
    const transportModel = model as Model<"anthropic-messages"> & {
      api: string;
      baseUrl?: string;
      provider: string;
    };
    const maxTokens = resolveAnthropicVertexMaxTokens({
      modelMaxTokens: transportModel.maxTokens,
      requestedMaxTokens: options?.maxTokens,
    });
    const opts: AnthropicOptions = {
      client: client as AnthropicOptions["client"],
      temperature: options?.temperature,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      signal: options?.signal,
      cacheRetention: options?.cacheRetention,
      sessionId: options?.sessionId,
      headers: options?.headers,
      onPayload: createAnthropicVertexOnPayload({
        model: transportModel,
        cacheRetention: options?.cacheRetention,
        onPayload: options?.onPayload,
      }),
      maxRetryDelayMs: options?.maxRetryDelayMs,
      metadata: options?.metadata,
    };

    if (options?.reasoning) {
      if (supportsAdaptiveThinking(model.id)) {
        opts.thinkingEnabled = true;
        opts.effort = mapAnthropicAdaptiveEffort(
          options.reasoning,
          model.id,
        ) as AnthropicVertexEffort;
      } else {
        opts.thinkingEnabled = true;
        const budgets = options.thinkingBudgets;
        opts.thinkingBudgetTokens =
          (budgets && options.reasoning in budgets
            ? budgets[options.reasoning as keyof typeof budgets]
            : undefined) ?? 10000;
      }
    } else {
      opts.thinkingEnabled = false;
    }

    return deps.streamAnthropic(transportModel, context, opts);
  };
}

function resolveAnthropicVertexSdkBaseUrl(baseUrl?: string): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (!normalizedPath || normalizedPath === "") {
      url.pathname = "/v1";
      return url.toString().replace(/\/$/, "");
    }
    if (!normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/v1`;
      return url.toString().replace(/\/$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export function createAnthropicVertexStreamFnForModel(
  model: { baseUrl?: string },
  env: NodeJS.ProcessEnv = process.env,
  deps?: AnthropicVertexStreamDeps,
): StreamFn {
  return createAnthropicVertexStreamFn(
    resolveAnthropicVertexProjectId(env),
    resolveAnthropicVertexClientRegion({
      baseUrl: model.baseUrl,
      env,
    }),
    resolveAnthropicVertexSdkBaseUrl(model.baseUrl),
    deps,
  );
}

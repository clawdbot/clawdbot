import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import {
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../agents/self-hosted-provider-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { cancelUnreadResponseBody } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin } from "../infra/net/ssrf.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";

const log = createSubsystemLogger("plugins/self-hosted-provider-discovery");

// Self-hosted provider base URLs are user-supplied and untrusted. Cap discovery
// bodies before parsing so a hostile or buggy endpoint cannot exhaust memory.
const SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES = 16 * 1024 * 1024;
const SELF_HOSTED_RUNTIME_CONTEXT_MAX_MODELS = 200;
const SELF_HOSTED_RUNTIME_CONTEXT_CONCURRENCY = 8;

type OpenAICompatibleModelDiscoveryRow = {
  model: Record<string, unknown>;
  props?: Record<string, unknown>;
};

type OpenAICompatibleModelDiscoveryResult =
  | {
      kind: "success";
      health: "ready" | "loading" | "unknown";
      rows: OpenAICompatibleModelDiscoveryRow[];
      fetchedAt: number;
    }
  | { kind: "unreachable"; error: unknown }
  | { kind: "http-error"; path: string; status: number }
  | { kind: "invalid-response"; path: string; error: unknown };

type DiscoveryResponse =
  | { kind: "response"; ok: boolean; status: number; body?: unknown }
  | { kind: "unreachable"; error: unknown }
  | { kind: "invalid-response"; error: unknown };

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.trunc(value);
}

const OPENAI_COMPAT_CONTEXT_WINDOW_FIELDS = [
  "context_length",
  "context_window",
  "context_size",
] as const;

function readOpenAICompatibleContextWindow(
  model: Record<string, unknown> | undefined,
): number | undefined {
  for (const field of OPENAI_COMPAT_CONTEXT_WINDOW_FIELDS) {
    const contextWindow = readPositiveInteger(model?.[field]);
    if (contextWindow !== undefined) {
      return contextWindow;
    }
  }
  return undefined;
}

function buildSelfHostedDiscoveryHeaders(params: {
  apiKey?: string;
  headers?: Record<string, string>;
  acceptJson?: boolean;
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {
    ...(params.acceptJson ? { Accept: "application/json" } : {}),
    ...params.headers,
  };
  const hasAuthorization = Object.keys(headers).some(
    (name) => name.trim().toLowerCase() === "authorization",
  );
  const apiKey = normalizeOptionalString(params.apiKey);
  if (apiKey && !isNonSecretApiKeyMarker(apiKey) && !hasAuthorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

async function fetchSelfHostedDiscoveryJson(params: {
  url: string;
  origin: string;
  apiKey?: string;
  headers?: Record<string, string>;
  acceptJson?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  readBody: boolean;
  label: string;
}): Promise<DiscoveryResponse> {
  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
  try {
    guarded = await fetchWithSsrFGuard({
      url: params.url,
      init: { headers: buildSelfHostedDiscoveryHeaders(params) },
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.origin),
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      auditContext: "self-hosted-provider-discovery",
    });
  } catch (error) {
    return { kind: "unreachable", error };
  }

  try {
    if (!params.readBody || !guarded.response.ok) {
      return {
        kind: "response",
        ok: guarded.response.ok,
        status: guarded.response.status,
      };
    }
    try {
      return {
        kind: "response",
        ok: true,
        status: guarded.response.status,
        body: await readProviderJsonResponse(guarded.response, `${params.label} discovery`, {
          maxBytes: SELF_HOSTED_DISCOVERY_JSON_MAX_BYTES,
        }),
      };
    } catch (error) {
      return { kind: "invalid-response", error };
    }
  } finally {
    await cancelUnreadResponseBody(guarded.response);
    await guarded.release();
  }
}

function readDiscoveryRows(body: unknown): Record<string, unknown>[] {
  const bodyRecord = asOptionalRecord(body);
  if (!Array.isArray(bodyRecord?.data)) {
    throw new Error("model list must contain data[]");
  }
  return bodyRecord.data.flatMap((entry) => {
    const row = asOptionalRecord(entry);
    return row ? [row] : [];
  });
}

function shouldProbeRuntimeProps(model: Record<string, unknown>): boolean {
  const status = asOptionalRecord(model.status)?.value;
  return status === undefined || status === "loaded" || status === "sleeping";
}

function resolveRuntimePropsUrl(params: { serverBaseUrl: string; modelId?: string }): string {
  const url = new URL(`${params.serverBaseUrl.replace(/\/+$/, "")}/props`);
  const modelId = normalizeOptionalString(params.modelId);
  if (modelId) {
    url.searchParams.set("model", modelId);
    url.searchParams.set("autoload", "false");
  }
  return url.toString();
}

/** Guarded model-row discovery for OpenAI-compatible self-hosted servers. */
async function discoverOpenAICompatibleModelRows(params: {
  inferenceBaseUrl: string;
  serverBaseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  label: string;
  healthPath?: string;
  modelsPathOrder?: "inference" | "server-first";
  routerModelProps?: boolean;
  discoverRuntimeContext?: boolean;
  timeoutMs?: number;
  propsTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<OpenAICompatibleModelDiscoveryResult> {
  const inferenceBaseUrl = params.inferenceBaseUrl.trim().replace(/\/+$/, "");
  const inferredServerBaseUrl = inferenceBaseUrl.replace(/\/v1$/u, "");
  const serverBaseUrl = (params.serverBaseUrl ?? inferredServerBaseUrl).replace(/\/+$/, "");
  const origin = new URL(serverBaseUrl).origin;
  const timeoutMs = params.timeoutMs ?? 5_000;
  let health: "ready" | "loading" | "unknown" = "unknown";

  if (params.healthPath) {
    const path = params.healthPath;
    const healthResult = await fetchSelfHostedDiscoveryJson({
      url: `${serverBaseUrl}${path}`,
      origin,
      apiKey: params.apiKey,
      headers: params.headers,
      acceptJson: true,
      timeoutMs,
      signal: params.signal,
      readBody: false,
      label: params.label,
    });
    if (healthResult.kind === "unreachable") {
      return healthResult;
    }
    if (healthResult.kind === "invalid-response") {
      return { ...healthResult, path };
    }
    health =
      healthResult.status === 200 ? "ready" : healthResult.status === 503 ? "loading" : "unknown";
    if (![200, 404, 503].includes(healthResult.status)) {
      return { kind: "http-error", path, status: healthResult.status };
    }
  }

  const modelCandidates =
    params.modelsPathOrder === "server-first"
      ? [
          { path: "/models", url: `${serverBaseUrl}/models` },
          { path: "/v1/models", url: `${inferenceBaseUrl}/models` },
        ]
      : [{ path: "/v1/models", url: `${inferenceBaseUrl}/models` }];
  let modelsPath = modelCandidates[0]?.path ?? "/v1/models";
  let modelsResult: DiscoveryResponse | undefined;
  for (const [index, candidate] of modelCandidates.entries()) {
    modelsPath = candidate.path;
    modelsResult = await fetchSelfHostedDiscoveryJson({
      url: candidate.url,
      origin,
      apiKey: params.apiKey,
      headers: params.headers,
      acceptJson: params.modelsPathOrder === "server-first",
      timeoutMs,
      signal: params.signal,
      readBody: true,
      label: params.label,
    });
    if (
      modelsResult.kind !== "response" ||
      modelsResult.status !== 404 ||
      index === modelCandidates.length - 1
    ) {
      break;
    }
  }
  if (!modelsResult || modelsResult.kind === "unreachable") {
    return modelsResult ?? { kind: "unreachable", error: new Error("missing model response") };
  }
  if (modelsResult.kind === "invalid-response") {
    return { ...modelsResult, path: modelsPath };
  }
  if (!modelsResult.ok) {
    return { kind: "http-error", path: modelsPath, status: modelsResult.status };
  }

  let models: Record<string, unknown>[];
  try {
    models = readDiscoveryRows(modelsResult.body);
  } catch (error) {
    return { kind: "invalid-response", path: modelsPath, error };
  }
  const rows: OpenAICompatibleModelDiscoveryRow[] = models.map((model) => ({ model }));
  if (params.discoverRuntimeContext !== false) {
    const routerMode =
      params.routerModelProps &&
      models.some((model) => asOptionalRecord(model.status) !== undefined);
    const queryByModel = routerMode || (!params.routerModelProps && models.length > 1);
    const probeIndexes = models
      .map((model, index) => (shouldProbeRuntimeProps(model) ? index : -1))
      .filter((index) => index >= 0)
      .slice(0, SELF_HOSTED_RUNTIME_CONTEXT_MAX_MODELS);
    const deadline = Date.now() + timeoutMs;
    const { results } = await runTasksWithConcurrency({
      limit: SELF_HOSTED_RUNTIME_CONTEXT_CONCURRENCY,
      errorMode: "stop",
      throwOnError: true,
      tasks: probeIndexes.map((index) => async () => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          return undefined;
        }
        const model = models[index];
        const modelId = normalizeOptionalString(model?.id);
        if (!model || !modelId) {
          return undefined;
        }
        const result = await fetchSelfHostedDiscoveryJson({
          url: resolveRuntimePropsUrl({
            serverBaseUrl,
            modelId: queryByModel ? modelId : undefined,
          }),
          origin,
          apiKey: params.apiKey,
          headers: params.headers,
          acceptJson: params.modelsPathOrder === "server-first",
          timeoutMs: Math.min(params.propsTimeoutMs ?? timeoutMs, remainingMs),
          signal: params.signal,
          readBody: true,
          label: `${params.label} /props`,
        });
        const props =
          result.kind === "response" && result.ok ? asOptionalRecord(result.body) : undefined;
        return props ? ([index, props] as const) : undefined;
      }),
    });
    for (const result of results) {
      if (result) {
        rows[result[0]] = { model: models[result[0]]!, props: result[1] };
      }
    }
  }

  return { kind: "success", health, rows, fetchedAt: Date.now() };
}

type OpenAICompatibleLocalModelsParams = {
  baseUrl: string;
  serverBaseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  label: string;
  healthPath?: string;
  modelsPathOrder?: "inference" | "server-first";
  routerModelProps?: boolean;
  contextWindow?: number;
  discoverRuntimeContext?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  propsTimeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  rawResult?: boolean;
};

/** Discovers normalized model configs from a conventional OpenAI-compatible endpoint. */
export function discoverOpenAICompatibleLocalModels(
  params: OpenAICompatibleLocalModelsParams & { rawResult: true },
): Promise<OpenAICompatibleModelDiscoveryResult>;
export function discoverOpenAICompatibleLocalModels(
  params: OpenAICompatibleLocalModelsParams & { rawResult?: false },
): Promise<ModelDefinitionConfig[]>;
export async function discoverOpenAICompatibleLocalModels(
  params: OpenAICompatibleLocalModelsParams,
): Promise<ModelDefinitionConfig[] | OpenAICompatibleModelDiscoveryResult> {
  const env = params.env ?? process.env;
  if (!params.rawResult && (env.VITEST || env.NODE_ENV === "test")) {
    return [];
  }

  const result = await discoverOpenAICompatibleModelRows({
    inferenceBaseUrl: params.baseUrl,
    serverBaseUrl: params.serverBaseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    label: params.label,
    healthPath: params.healthPath,
    modelsPathOrder: params.modelsPathOrder,
    routerModelProps: params.routerModelProps,
    discoverRuntimeContext:
      params.contextWindow === undefined && params.discoverRuntimeContext !== false,
    timeoutMs: params.timeoutMs,
    propsTimeoutMs: params.propsTimeoutMs ?? 2_500,
    signal: params.signal,
  });
  if (params.rawResult) {
    return result;
  }
  if (result.kind !== "success") {
    if (result.kind === "invalid-response") {
      log.warn(`${params.label} discovery: malformed JSON response: ${String(result.error)}`);
    } else {
      const detail = result.kind === "http-error" ? result.status : String(result.error);
      log.warn(`Failed to discover ${params.label} models: ${detail}`);
    }
    return [];
  }
  if (result.rows.length === 0) {
    log.warn(`No ${params.label} models found on local instance`);
    return [];
  }

  return result.rows.flatMap(({ model, props }) => {
    const modelId = normalizeOptionalString(model.id);
    if (!modelId) {
      return [];
    }
    const meta = asOptionalRecord(model.meta);
    const generationSettings = asOptionalRecord(props?.default_generation_settings);
    const runtimeContextTokens =
      readPositiveInteger(generationSettings?.n_ctx) ?? readPositiveInteger(props?.n_ctx);
    const modelConfig: ModelDefinitionConfig = {
      id: modelId,
      name: modelId,
      reasoning: /r1|reasoning|think|reason/i.test(modelId),
      input: ["text"],
      cost: SELF_HOSTED_DEFAULT_COST,
      contextWindow:
        params.contextWindow ??
        readPositiveInteger(meta?.n_ctx_train) ??
        readOpenAICompatibleContextWindow(model) ??
        SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
      ...(runtimeContextTokens ? { contextTokens: runtimeContextTokens } : {}),
    };
    return [modelConfig];
  });
}

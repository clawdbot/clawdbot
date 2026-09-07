import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
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
  "max_model_len",
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
  return bodyRecord.data.filter(isRecord);
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
async function discoverOpenAICompatibleModelRows(
  params: OpenAICompatibleLocalModelsParams,
): Promise<OpenAICompatibleModelDiscoveryResult> {
  const inferenceBaseUrl = params.baseUrl.trim().replace(/\/+$/, "");
  const inferredServerBaseUrl = inferenceBaseUrl.replace(/\/v1$/u, "");
  const serverBaseUrl = (params.serverBaseUrl ?? inferredServerBaseUrl).replace(/\/+$/, "");
  const timeoutMs = params.timeoutMs ?? 5_000;
  const request = {
    ...params,
    origin: new URL(serverBaseUrl).origin,
    timeoutMs,
    acceptJson: params.modelsPathOrder === "server-first",
    readBody: true,
  };
  let health: "ready" | "loading" | "unknown" = "unknown";

  if (params.healthPath) {
    const path = params.healthPath;
    const healthResult = await fetchSelfHostedDiscoveryJson({
      ...request,
      url: `${serverBaseUrl}${path}`,
      acceptJson: true,
      readBody: false,
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
  let modelList:
    | { kind: "success"; models: Record<string, unknown>[] }
    | Exclude<OpenAICompatibleModelDiscoveryResult, { kind: "success" }>
    | undefined;
  for (const candidate of modelCandidates) {
    const result = await fetchSelfHostedDiscoveryJson({
      ...request,
      url: candidate.url,
    });
    if (result.kind === "unreachable") {
      return result;
    }
    if (result.kind === "invalid-response") {
      modelList = { ...result, path: candidate.path };
    } else if (!result.ok) {
      modelList = { kind: "http-error", path: candidate.path, status: result.status };
    } else {
      try {
        modelList = { kind: "success", models: readDiscoveryRows(result.body) };
      } catch (error) {
        modelList = { kind: "invalid-response", path: candidate.path, error };
      }
    }
    // A root endpoint may serve a web app instead of a model list. Try the
    // inference endpoint, while keeping auth and service failures terminal.
    if (
      modelList.kind === "success" ||
      (modelList.kind === "http-error" && modelList.status !== 404)
    ) {
      break;
    }
  }
  if (!modelList || modelList.kind !== "success") {
    return modelList ?? { kind: "unreachable", error: new Error("missing model response") };
  }
  const rows: OpenAICompatibleModelDiscoveryRow[] = modelList.models.map((model) => ({ model }));
  if (params.discoverRuntimeContext !== false) {
    const routerMode =
      params.routerModelProps &&
      rows.some(({ model }) => asOptionalRecord(model.status) !== undefined);
    const queryByModel = routerMode || (!params.routerModelProps && rows.length > 1);
    const probeRows = rows
      .filter(({ model }) => shouldProbeRuntimeProps(model))
      .slice(0, SELF_HOSTED_RUNTIME_CONTEXT_MAX_MODELS);
    const deadline = performance.now() + timeoutMs;
    await runTasksWithConcurrency({
      limit: SELF_HOSTED_RUNTIME_CONTEXT_CONCURRENCY,
      errorMode: "stop",
      throwOnError: true,
      tasks: probeRows.map((row) => async () => {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          return;
        }
        const modelId = normalizeOptionalString(row.model.id);
        if (!modelId) {
          return;
        }
        const result = await fetchSelfHostedDiscoveryJson({
          ...request,
          url: resolveRuntimePropsUrl({
            serverBaseUrl,
            modelId: queryByModel ? modelId : undefined,
          }),
          timeoutMs: Math.min(params.propsTimeoutMs ?? timeoutMs, remainingMs),
          label: `${params.label} /props`,
        });
        const props =
          result.kind === "response" && result.ok ? asOptionalRecord(result.body) : undefined;
        if (props) {
          row.props = props;
        }
      }),
    });
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
    ...params,
    discoverRuntimeContext:
      params.contextWindow === undefined && params.discoverRuntimeContext !== false,
    propsTimeoutMs: params.propsTimeoutMs ?? 2_500,
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

  const topLevelContextByModelId = new Map<string, number>();
  for (const { model } of result.rows) {
    const modelId = normalizeOptionalString(model.id);
    const contextWindow = readOpenAICompatibleContextWindow(model);
    if (modelId && contextWindow !== undefined) {
      topLevelContextByModelId.set(modelId, contextWindow);
    }
  }

  return result.rows.flatMap(({ model, props }) => {
    const modelId = normalizeOptionalString(model.id);
    if (!modelId) {
      return [];
    }
    const meta = asOptionalRecord(model.meta);
    const parentId = normalizeOptionalString(model.parent);
    const parentContextWindow =
      parentId && parentId !== modelId ? topLevelContextByModelId.get(parentId) : undefined;
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
        parentContextWindow ??
        SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      maxTokens: params.maxTokens ?? SELF_HOSTED_DEFAULT_MAX_TOKENS,
      ...(runtimeContextTokens ? { contextTokens: runtimeContextTokens } : {}),
    };
    return [modelConfig];
  });
}

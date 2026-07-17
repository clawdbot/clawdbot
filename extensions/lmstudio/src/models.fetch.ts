// Lmstudio plugin module implements models.fetch behavior.
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import {
  readProviderJsonArrayFieldResponse,
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { SELF_HOSTED_DEFAULT_COST } from "openclaw/plugin-sdk/provider-setup";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH } from "./defaults.js";
import {
  buildLmstudioModelName,
  mapLmstudioWireEntry,
  resolveLmstudioCanonicalModelKey,
  resolveLmstudioServerBase,
  resolveLoadedContextWindow,
  type LmstudioModelWire,
} from "./models.js";
import { buildLmstudioAuthHeaders } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/models");
const LMSTUDIO_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

type LmstudioLoadResponse = {
  status?: string;
};

type LmstudioResolvedModelKeyError = {
  resolvedModelKey: string;
};

type FetchLmstudioModelsResult = {
  reachable: boolean;
  status?: number;
  models: LmstudioModelWire[];
  error?: unknown;
};

type DiscoverLmstudioModelsParams = {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  quiet: boolean;
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function fetchLmstudioEndpoint(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
  auditContext: string;
}): Promise<{ response: Response; release: () => Promise<void> }> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let response: Response;
  let release: () => Promise<void>;
  if (params.ssrfPolicy) {
    const guarded = await fetchWithSsrFGuard({
      url: params.url,
      init: params.init,
      timeoutMs,
      fetchImpl: params.fetchImpl,
      policy: params.ssrfPolicy,
      auditContext: params.auditContext,
    });
    response = guarded.response;
    release = guarded.release;
  } else {
    const fetchFn = params.fetchImpl ?? fetch;
    response = await fetchFn(params.url, {
      ...params.init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    release = async () => undefined;
  }
  return {
    response,
    release: async () => {
      await cancelUnreadResponseBody(response);
      await release();
    },
  };
}

function asLmstudioModelWire(value: unknown): LmstudioModelWire {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LM Studio model list: malformed JSON response");
  }
  return value as LmstudioModelWire;
}

function withResolvedLmstudioModelKey(
  error: unknown,
  resolvedModelKey: string,
): Error & LmstudioResolvedModelKeyError {
  if (error instanceof Error) {
    return Object.assign(error, { resolvedModelKey });
  }
  return Object.assign(new Error(String(error)), {
    cause: error,
    resolvedModelKey,
  });
}

/** Fetches /api/v1/models and reports transport reachability separately from HTTP status. */
export async function fetchLmstudioModels(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<FetchLmstudioModelsResult> {
  const baseUrl = resolveLmstudioServerBase(params.baseUrl);
  const timeoutMs = params.timeoutMs ?? 5000;
  try {
    const { response, release } = await fetchLmstudioEndpoint({
      url: `${baseUrl}/api/v1/models`,
      init: {
        headers: buildLmstudioAuthHeaders({
          apiKey: params.apiKey,
          headers: params.headers,
        }),
      },
      timeoutMs,
      fetchImpl: params.fetchImpl,
      ssrfPolicy: params.ssrfPolicy,
      auditContext: "lmstudio-model-discovery",
    });
    try {
      if (!response.ok) {
        return {
          reachable: true,
          status: response.status,
          models: [],
        };
      }
      const models = await readProviderJsonArrayFieldResponse(
        response,
        "LM Studio model list",
        "models",
      );
      return {
        reachable: true,
        status: response.status,
        models: models.map(asLmstudioModelWire),
      };
    } finally {
      await release();
    }
  } catch (error) {
    return {
      reachable: false,
      models: [],
      error,
    };
  }
}

/** Discovers LLM models from LM Studio and maps them to OpenClaw model definitions. */
export async function discoverLmstudioModels(
  params: DiscoverLmstudioModelsParams,
): Promise<ModelDefinitionConfig[]> {
  const fetched = await fetchLmstudioModels({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    fetchImpl: params.fetchImpl,
  });
  const quiet = params.quiet;
  if (!fetched.reachable) {
    if (!quiet) {
      log.debug(`Failed to discover LM Studio models: ${String(fetched.error)}`);
    }
    return [];
  }
  if (fetched.status !== undefined && fetched.status >= 400) {
    if (!quiet) {
      log.debug(`Failed to discover LM Studio models: ${fetched.status}`);
    }
    return [];
  }
  const models = fetched.models;
  if (models.length === 0) {
    if (!quiet) {
      log.debug("No LM Studio models found on local instance");
    }
    return [];
  }

  return models
    .map((entry): ModelDefinitionConfig | null => {
      const base = mapLmstudioWireEntry(entry);
      if (!base) {
        return null;
      }
      return {
        id: base.id,
        // Runtime display: include format/vision/tool-use/loaded tags in the name.
        name: buildLmstudioModelName(base),
        reasoning: base.reasoning,
        input: base.input,
        cost: SELF_HOSTED_DEFAULT_COST,
        compat: { ...base.compat, supportsUsageInStreaming: true },
        contextWindow: base.contextWindow,
        contextTokens: base.contextTokens,
        maxTokens: base.maxTokens,
      };
    })
    .filter((entry): entry is ModelDefinitionConfig => entry !== null);
}

/** Ensures a model is loaded in LM Studio before first real inference/embedding call. */
export async function ensureLmstudioModelLoaded(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  modelKey: string;
  requestedContextLength?: number;
  timeoutMs?: number;
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const modelKey = params.modelKey.trim();
  if (!modelKey) {
    throw new Error("LM Studio model key is required");
  }

  const timeoutMs = params.timeoutMs ?? 30_000;
  const baseUrl = resolveLmstudioServerBase(params.baseUrl);
  const preflight = await fetchLmstudioModels({
    baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    ssrfPolicy: params.ssrfPolicy,
    timeoutMs,
    fetchImpl: params.fetchImpl,
  });
  if (!preflight.reachable) {
    throw new Error(`LM Studio model discovery failed: ${String(preflight.error)}`);
  }
  if (preflight.status !== undefined && preflight.status >= 400) {
    throw new Error(`LM Studio model discovery failed (${preflight.status})`);
  }
  const canonicalModelKey = resolveLmstudioCanonicalModelKey({
    modelKey,
    models: preflight.models,
  });
  const matchingModel = preflight.models.find((entry) => entry.key?.trim() === canonicalModelKey);
  const loadedContextWindow = matchingModel ? resolveLoadedContextWindow(matchingModel) : null;
  const advertisedContextLimit = asPositiveSafeInteger(matchingModel?.max_context_length) ?? null;
  const requestedContextLength = asPositiveSafeInteger(params.requestedContextLength) ?? null;
  const contextLengthForLoad =
    advertisedContextLimit === null
      ? (requestedContextLength ?? LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH)
      : Math.min(
          requestedContextLength ?? LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
          advertisedContextLimit,
        );
  if (loadedContextWindow !== null && loadedContextWindow >= contextLengthForLoad) {
    return canonicalModelKey;
  }

  try {
    const { response, release } = await fetchLmstudioEndpoint({
      url: `${baseUrl}/api/v1/models/load`,
      init: {
        method: "POST",
        headers: buildLmstudioAuthHeaders({
          apiKey: params.apiKey,
          headers: params.headers,
          json: true,
        }),
        body: JSON.stringify({
          model: canonicalModelKey,
          // Ask LM Studio to load with our default target, capped to the model's own limit.
          context_length: contextLengthForLoad,
        }),
      },
      timeoutMs,
      fetchImpl: params.fetchImpl,
      ssrfPolicy: params.ssrfPolicy,
      auditContext: "lmstudio-model-load",
    });
    try {
      if (!response.ok) {
        const body = await readResponseTextLimited(response, LMSTUDIO_ERROR_BODY_LIMIT_BYTES);
        throw new Error(
          `LM Studio model load failed (${response.status})${body ? `: ${body}` : ""}`,
        );
      }
      // Read the success body through the shared byte-capped reader so a misbehaving
      // or compromised LM Studio server cannot stream an unbounded JSON payload into
      // memory before we parse it. Malformed JSON is wrapped with our own label.
      const payload = await readProviderJsonResponse<LmstudioLoadResponse>(
        response,
        "LM Studio model load",
      );
      if (typeof payload.status === "string" && payload.status.toLowerCase() !== "loaded") {
        throw new Error(`LM Studio model load returned unexpected status: ${payload.status}`);
      }
    } finally {
      await release();
    }
  } catch (error) {
    throw withResolvedLmstudioModelKey(error, canonicalModelKey);
  }
  return canonicalModelKey;
}

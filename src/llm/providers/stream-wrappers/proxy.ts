import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
// Proxy stream wrapper applies provider-specific wrappers around base stream functions.
import {
  normalizeOptionalLowercaseString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { resolveProviderRequestPolicy } from "../../../agents/provider-attribution.js";
import {
  getModelProviderRequestRouteFacts,
  resolveProviderRequestPolicyConfig,
} from "../../../agents/provider-request-config.js";
import type { StreamFn } from "../../../agents/runtime/index.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { normalizeOpenAICompatibleReasoningPayload } from "../../../plugin-sdk/provider-stream-shared.js";
import { parseBooleanValue } from "../../../utils/boolean.js";
import { streamSimple } from "../../stream.js";
import {
  applyAnthropicEphemeralCacheControlMarkers,
  resolveAnthropicEphemeralCacheControl,
} from "./anthropic-cache-control-payload.js";
import { isAnthropicModelRef } from "./anthropic-family-cache-semantics.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";
const KILOCODE_FEATURE_HEADER = "X-KILOCODE-FEATURE";
const KILOCODE_FEATURE_DEFAULT = "openclaw";
const KILOCODE_FEATURE_ENV_VAR = "KILOCODE_FEATURE";
const BOOLEAN_PARAM_PARSE_OPTIONS = {
  truthy: ["1", "true", "yes", "on", "enable", "enabled"],
  falsy: ["0", "false", "no", "off", "disable", "disabled"],
};

function resolveKilocodeAppHeaders(): Record<string, string> {
  const feature = process.env[KILOCODE_FEATURE_ENV_VAR]?.trim() || KILOCODE_FEATURE_DEFAULT;
  return { [KILOCODE_FEATURE_HEADER]: feature };
}

function resolveModelEndpointClass(model: Parameters<StreamFn>[0]) {
  return (
    getModelProviderRequestRouteFacts(model)?.capabilities.endpointClass ??
    resolveProviderRequestPolicy({
      provider: readStringValue(model.provider),
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
    }).endpointClass
  );
}

function readExtraParam(
  extraParams: Record<string, unknown> | undefined,
  keys: readonly string[],
): unknown {
  if (!extraParams) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.hasOwn(extraParams, key)) {
      return extraParams[key];
    }
  }
  return undefined;
}

function resolveOpenRouterResponseCacheTtlSeconds(value: unknown): string | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseStrictFiniteNumber(value)
        : undefined;
  if (parsed === undefined) {
    return undefined;
  }
  return String(Math.max(1, Math.min(86400, Math.trunc(parsed))));
}

function shouldApplyOpenRouterResponseCacheHeaders(model: Parameters<StreamFn>[0]): boolean {
  const provider = readStringValue(model.provider);
  const endpointClass = resolveModelEndpointClass(model);
  return (
    endpointClass === "openrouter" ||
    (endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter")
  );
}

function resolveOpenRouterResponseCacheHeaders(
  model: Parameters<StreamFn>[0],
  extraParams: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!shouldApplyOpenRouterResponseCacheHeaders(model)) {
    return undefined;
  }
  const configuredCache = parseBooleanValue(
    readExtraParam(extraParams, ["responseCache", "response_cache"]),
    BOOLEAN_PARAM_PARSE_OPTIONS,
  );
  const clearCache = parseBooleanValue(
    readExtraParam(extraParams, ["responseCacheClear", "response_cache_clear"]),
    BOOLEAN_PARAM_PARSE_OPTIONS,
  );
  const cacheEnabled = configuredCache ?? (clearCache ? true : undefined);
  if (cacheEnabled === undefined) {
    return undefined;
  }

  const headers: Record<string, string> = {
    "X-OpenRouter-Cache": cacheEnabled ? "true" : "false",
  };
  if (!cacheEnabled) {
    return headers;
  }

  const ttl = resolveOpenRouterResponseCacheTtlSeconds(
    readExtraParam(extraParams, [
      "responseCacheTtlSeconds",
      "response_cache_ttl_seconds",
      "responseCacheTtl",
      "response_cache_ttl",
    ]),
  );
  if (ttl) {
    headers["X-OpenRouter-Cache-TTL"] = ttl;
  }
  if (clearCache) {
    headers["X-OpenRouter-Cache-Clear"] = "true";
  }
  return headers;
}

/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
export function createOpenRouterSystemCacheWrapper(
  baseStreamFn: StreamFn | undefined,
  extraParams?: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const provider = readStringValue(model.provider);
    const modelId = readStringValue(model.id);
    // Keep OpenRouter-specific cache markers on verified OpenRouter routes
    // (or the provider's default route), but not on arbitrary OpenAI proxies.
    const endpointClass = resolveModelEndpointClass(model);
    if (
      !modelId ||
      !isAnthropicModelRef(modelId) ||
      !(
        endpointClass === "openrouter" ||
        (endpointClass === "default" && normalizeOptionalLowercaseString(provider) === "openrouter")
      )
    ) {
      return underlying(model, context, options);
    }

    const cacheRetention =
      readCacheRetention(options?.cacheRetention) ??
      readCacheRetention(extraParams?.cacheRetention);
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      stripCacheRetentionOption(options),
      (payloadObj) => {
        applyAnthropicEphemeralCacheControlMarkers(
          payloadObj,
          resolveAnthropicEphemeralCacheControl(readStringValue(model.baseUrl), cacheRetention) ??
            null,
        );
      },
    );
  };
}

function readCacheRetention(value: unknown): "long" | "none" | "short" | undefined {
  return value === "long" || value === "none" || value === "short" ? value : undefined;
}

function stripCacheRetentionOption(options: Parameters<StreamFn>[2]): Parameters<StreamFn>[2] {
  if (!options || !Object.hasOwn(options, "cacheRetention")) {
    return options;
  }
  const { cacheRetention: _cacheRetention, ...rest } = options;
  return rest;
}

/** @deprecated OpenRouter provider-owned stream helper; do not use from third-party plugins. */
export function createOpenRouterWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
  extraParams?: Record<string, unknown>,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const providerHeaders = resolveOpenRouterResponseCacheHeaders(model, extraParams);
    const headers = resolveProviderRequestPolicyConfig({
      provider: readStringValue(model.provider) ?? "openrouter",
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
      routeFacts: getModelProviderRequestRouteFacts(model),
      callerHeaders: options?.headers,
      providerHeaders,
      precedence: "caller-wins",
    }).headers;
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers,
      },
      (payload) => {
        normalizeOpenAICompatibleReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}

/** @deprecated Proxy provider-owned stream helper; do not use from third-party plugins. */
export function isProxyReasoningUnsupported(modelId: string): boolean {
  const trimmed = normalizeOptionalLowercaseString(modelId);
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 && trimmed?.slice(0, slashIndex) === "x-ai";
}

/** @deprecated Kilocode provider-owned stream helper; do not use from third-party plugins. */
export function createKilocodeWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const headers = resolveProviderRequestPolicyConfig({
      provider: readStringValue(model.provider) ?? "kilocode",
      api: readStringValue(model.api),
      baseUrl: readStringValue(model.baseUrl),
      capability: "llm",
      transport: "stream",
      routeFacts: getModelProviderRequestRouteFacts(model),
      callerHeaders: options?.headers,
      providerHeaders: resolveKilocodeAppHeaders(),
      precedence: "defaults-win",
    }).headers;
    return streamWithPayloadPatch(
      underlying,
      model,
      context,
      {
        ...options,
        headers,
      },
      (payload) => {
        normalizeOpenAICompatibleReasoningPayload(payload, thinkingLevel);
      },
    );
  };
}

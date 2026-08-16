// Openrouter plugin module implements image model capability discovery.
import type {
  ImageGenerationBackground,
  ImageGenerationModelCapabilitiesContext,
  ImageGenerationProviderCapabilities,
  ImageGenerationQuality,
  ImageGenerationResolution,
} from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  isRecord,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeOpenRouterBaseUrl, OPENROUTER_BASE_URL } from "./provider-catalog.js";

// Discovery sits on the image request path; keep its budget far below the
// generation timeout so a slow catalog degrades to static caps, never a stall.
const DISCOVERY_TIMEOUT_MS = 10_000;

type OpenRouterImageDispatcherPolicy = NonNullable<
  Parameters<typeof fetchWithTimeoutGuarded>[4]
>["dispatcherPolicy"];

type OpenRouterImageRequestPolicyCacheKey = ReturnType<
  typeof sanitizeConfiguredModelProviderRequest
>;

type OpenRouterImageRequestConfig = Parameters<typeof sanitizeConfiguredModelProviderRequest>[0];

const IMAGE_RESOLUTION_VALUES: readonly ImageGenerationResolution[] = ["1K", "2K", "4K"];
const IMAGE_QUALITY_VALUES: readonly ImageGenerationQuality[] = ["auto", "low", "medium", "high"];
const IMAGE_BACKGROUND_VALUES: readonly ImageGenerationBackground[] = [
  "auto",
  "opaque",
  "transparent",
];

function isImageResolution(value: string): value is ImageGenerationResolution {
  return (IMAGE_RESOLUTION_VALUES as readonly string[]).includes(value);
}

function isImageQuality(value: string): value is ImageGenerationQuality {
  return (IMAGE_QUALITY_VALUES as readonly string[]).includes(value);
}

function isImageBackground(value: string): value is ImageGenerationBackground {
  return (IMAGE_BACKGROUND_VALUES as readonly string[]).includes(value);
}

// `supported_parameters` values are typed descriptors ({type: "enum"|"range"|"boolean", ...}).
// Each reader validates one descriptor in isolation: an unrecognized or malformed
// descriptor drops only its own parameter, never the model or the catalog.
function readEnumValues(descriptor: unknown): string[] | undefined {
  if (!isRecord(descriptor) || descriptor.type !== "enum") {
    return undefined;
  }
  const values = normalizeTrimmedStringList(descriptor.values);
  return values.length > 0 ? values : undefined;
}

function readRangeMax(descriptor: unknown): number | undefined {
  if (!isRecord(descriptor) || descriptor.type !== "range") {
    return undefined;
  }
  // Negative sentinels ("unlimited") or fractional maxima must drop the
  // parameter, not flow into count gates as nonsense limits.
  return typeof descriptor.max === "number" &&
    Number.isInteger(descriptor.max) &&
    descriptor.max >= 0
    ? descriptor.max
    : undefined;
}

function buildOpenRouterImageModelCapabilities(
  supportedParameters: Record<string, unknown>,
): ImageGenerationProviderCapabilities {
  const aspectRatios = readEnumValues(supportedParameters.aspect_ratio);
  // The API also advertises values outside OpenClaw's resolution union (e.g. "512");
  // drop those rather than widening the union here. A model whose entire set falls
  // outside the union counts as unsupported: an empty geometry list would skip enum
  // snapping and pass raw values through unsanitized instead of reporting them ignored.
  const resolutions = readEnumValues(supportedParameters.resolution)?.filter(isImageResolution);
  const supportsResolution = (resolutions?.length ?? 0) > 0;
  const qualities = readEnumValues(supportedParameters.quality)?.filter(isImageQuality);
  const backgrounds = readEnumValues(supportedParameters.background)?.filter(isImageBackground);
  const maxInputImages = readRangeMax(supportedParameters.input_references);

  // `n` is deliberately NOT mapped to maxCount: `n` is the upstream per-request
  // batch size, while the provider fans out `count` parallel requests with n=1,
  // so a model with n:{min:1,max:1} still serves multi-image generations.
  const modeCapabilities = {
    supportsAspectRatio: aspectRatios !== undefined,
    supportsResolution,
  };
  return {
    generate: modeCapabilities,
    // Absence means unsupported, same client-side policy as the axes above:
    // an edit request against a model that never advertised input_references
    // must skip visibly, not silently drop the user's reference images. Every
    // current catalog model advertises the parameter, so this only fires for
    // malformed or future generate-only entries.
    edit: {
      ...modeCapabilities,
      enabled: maxInputImages !== undefined && maxInputImages > 0,
      maxInputImages: maxInputImages ?? 0,
    },
    geometry: {
      ...(aspectRatios ? { aspectRatios } : {}),
      ...(supportsResolution ? { resolutions } : {}),
    },
    ...(qualities?.length || backgrounds?.length
      ? {
          output: {
            ...(qualities?.length ? { qualities } : {}),
            ...(backgrounds?.length ? { backgrounds } : {}),
          },
        }
      : {}),
  };
}

function findModelSupportedParameters(
  payload: unknown,
  model: string,
): Record<string, unknown> | undefined {
  const entries = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (normalizeOptionalString(entry.id) !== model) {
      continue;
    }
    return isRecord(entry.supported_parameters) ? entry.supported_parameters : undefined;
  }
  return undefined;
}

// Canonical key ordering keeps equivalent request policies on one cache entry.
function stableCacheKeyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableCacheKeyValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableCacheKeyValue(entry)]),
  );
}

function buildRequestPolicyCacheKey(request: OpenRouterImageRequestPolicyCacheKey): unknown {
  return stableCacheKeyValue(request ?? null);
}

function resolveOpenRouterImageCatalogRequest(params: {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  request: OpenRouterImageRequestConfig;
}) {
  const request = sanitizeConfiguredModelProviderRequest(params.request);
  return {
    ...resolveProviderHttpRequestConfig({
      provider: "openrouter",
      capability: "image",
      baseUrl: params.baseUrl,
      defaultBaseUrl: OPENROUTER_BASE_URL,
      defaultHeaders: {
        // `GET /images/models` is public; send the key when one resolves (rate
        // limits, consistency) but never require it for discovery.
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      request,
    }),
    requestPolicyCacheKey: buildRequestPolicyCacheKey(request),
  };
}

async function fetchOpenRouterImageModels(params: {
  baseUrl: string;
  headers: Headers;
  requestPolicyCacheKey: unknown;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterImageDispatcherPolicy;
}): Promise<unknown> {
  return await getCachedLiveCatalogValue({
    // The route is public and its payload identical for every caller, so the
    // API key stays out of the cache identity (unlike the auth-gated video catalog).
    keyParts: ["openrouter", "image-models", params.baseUrl, params.requestPolicyCacheKey],
    load: async () => {
      const url = new URL("images/models", `${params.baseUrl}/`).href;
      const headers = new Headers(params.headers);
      headers.delete("content-type");
      const { response, release } = await fetchWithTimeoutGuarded(
        url,
        { method: "GET", headers },
        params.timeoutMs,
        fetch,
        {
          ...(params.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
          ...(params.dispatcherPolicy ? { dispatcherPolicy: params.dispatcherPolicy } : {}),
          auditContext: "openrouter-image-models",
        },
      );
      try {
        await assertOkOrThrowHttpError(response, "OpenRouter image models request failed");
        return await readProviderJsonResponse<unknown>(
          response,
          "OpenRouter image models request failed",
        );
      } finally {
        await release();
      }
    },
  });
}

export async function resolveOpenRouterImageModelCapabilities(
  ctx: ImageGenerationModelCapabilitiesContext,
): Promise<ImageGenerationProviderCapabilities | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: "openrouter",
    cfg: ctx.cfg,
    agentDir: ctx.agentDir,
    store: ctx.authStore,
  });
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, requestPolicyCacheKey } =
    resolveOpenRouterImageCatalogRequest({
      apiKey: auth.apiKey,
      baseUrl: ctx.cfg?.models?.providers?.openrouter?.baseUrl,
      request: ctx.cfg?.models?.providers?.openrouter?.request,
    });
  // Discovery is defined only for the canonical OpenRouter API. Custom bases use
  // the legacy /chat/completions image path and are not guaranteed to serve this route.
  const canonicalBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
  if (!canonicalBaseUrl) {
    return undefined;
  }
  const payload = await fetchOpenRouterImageModels({
    baseUrl: canonicalBaseUrl,
    headers,
    requestPolicyCacheKey,
    timeoutMs: ctx.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
    allowPrivateNetwork,
    dispatcherPolicy,
  });
  const supportedParameters = findModelSupportedParameters(payload, ctx.model);
  if (!supportedParameters) {
    // Model absent from the catalog: no overlay — static caps apply and the
    // API stays the authority on whether forwarded knobs are accepted.
    return undefined;
  }
  return buildOpenRouterImageModelCapabilities(supportedParameters);
}

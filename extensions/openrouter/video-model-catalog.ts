// Openrouter plugin module implements video model catalog behavior.
import type {
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  assertOkOrThrowHttpError,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import {
  isRecord,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  VideoGenerationModelCapabilitiesContext,
  VideoGenerationProviderCapabilities,
  VideoGenerationResolution,
} from "openclaw/plugin-sdk/video-generation";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";
import { fetchOpenRouterVideoGet, type OpenRouterVideoDispatcherPolicy } from "./video-http.js";

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

type OpenRouterVideoModel = {
  allowed_passthrough_parameters?: unknown;
  canonical_slug?: unknown;
  created?: unknown;
  description?: unknown;
  generate_audio?: unknown;
  id?: unknown;
  name?: unknown;
  pricing_skus?: unknown;
  seed?: unknown;
  supported_aspect_ratios?: unknown;
  supported_durations?: unknown;
  supported_frame_images?: unknown;
  supported_resolutions?: unknown;
  supported_sizes?: unknown;
};

type OpenRouterVideoModelCatalogCapabilities = VideoGenerationProviderCapabilities & {
  allowedPassthroughParameters?: readonly string[];
  canonicalSlug?: string;
  created?: number;
  description?: string;
  pricingSkus?: Readonly<Record<string, string>>;
};

type OpenRouterVideoRequestPolicyCacheKey = ReturnType<
  typeof sanitizeConfiguredModelProviderRequest
>;

type OpenRouterVideoRequestConfig = Parameters<typeof sanitizeConfiguredModelProviderRequest>[0];

function normalizeStringArray(value: unknown): string[] {
  return normalizeTrimmedStringList(value);
}

function normalizeNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    : [];
}

function normalizeResolutionArray(value: unknown): VideoGenerationResolution[] {
  return normalizeStringArray(value).map(
    (entry) => entry.toUpperCase() as VideoGenerationResolution,
  );
}

function normalizeFrameImageRoles(value: unknown): Array<"first_frame" | "last_frame"> {
  const seen = new Set<"first_frame" | "last_frame">();
  for (const entry of normalizeStringArray(value)) {
    if (entry === "first_frame" || entry === "last_frame") {
      seen.add(entry);
    }
  }
  return [...seen];
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalized = normalizeOptionalString(raw);
    if (normalized) {
      record[key] = normalized;
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function isOpenRouterVideoModel(value: unknown): value is OpenRouterVideoModel {
  return isRecord(value);
}

function buildOpenRouterVideoModeCapabilities(params: {
  durations: number[];
  aspectRatios: string[];
  resolutions: VideoGenerationResolution[];
  sizes: string[];
  supportsAudio?: boolean;
}): NonNullable<VideoGenerationProviderCapabilities["generate"]> {
  return {
    maxVideos: 1,
    ...(params.durations.length > 0 ? { supportedDurationSeconds: params.durations } : {}),
    ...(params.aspectRatios.length > 0
      ? {
          supportsAspectRatio: true,
          aspectRatios: params.aspectRatios,
        }
      : {}),
    ...(params.resolutions.length > 0
      ? {
          supportsResolution: true,
          resolutions: params.resolutions,
        }
      : {}),
    ...(params.sizes.length > 0
      ? {
          supportsSize: true,
          sizes: params.sizes,
        }
      : {}),
    ...(params.supportsAudio === undefined ? {} : { supportsAudio: params.supportsAudio }),
  };
}

function buildOpenRouterVideoModelCapabilities(
  model: OpenRouterVideoModel,
): OpenRouterVideoModelCatalogCapabilities {
  const aspectRatios = normalizeStringArray(model.supported_aspect_ratios);
  const durations = normalizeNumberArray(model.supported_durations);
  const frameImages = normalizeFrameImageRoles(model.supported_frame_images);
  const resolutions = normalizeResolutionArray(model.supported_resolutions);
  const sizes = normalizeStringArray(model.supported_sizes);
  const allowedPassthroughParameters = normalizeStringArray(model.allowed_passthrough_parameters);
  const supportsAudio =
    typeof model.generate_audio === "boolean" ? model.generate_audio : undefined;
  const modeCapabilities = buildOpenRouterVideoModeCapabilities({
    durations,
    aspectRatios,
    resolutions,
    sizes,
    supportsAudio,
  });
  const base: VideoGenerationProviderCapabilities = {
    providerOptions: {
      callback_url: "string",
      seed: "number",
    },
    generate: modeCapabilities,
    imageToVideo: {
      enabled: frameImages.length > 0,
      ...modeCapabilities,
      ...(frameImages.length > 0 ? { maxInputImages: frameImages.length } : {}),
    },
    videoToVideo: {
      enabled: false,
    },
  };
  const capabilities: OpenRouterVideoModelCatalogCapabilities = {
    ...base,
  };
  const canonicalSlug = normalizeOptionalString(model.canonical_slug);
  if (canonicalSlug) {
    capabilities.canonicalSlug = canonicalSlug;
  }
  const description = normalizeOptionalString(model.description);
  if (description) {
    capabilities.description = description;
  }
  if (typeof model.created === "number" && Number.isFinite(model.created)) {
    capabilities.created = model.created;
  }
  const pricingSkus = normalizeStringRecord(model.pricing_skus);
  if (pricingSkus) {
    capabilities.pricingSkus = pricingSkus;
  }
  if (allowedPassthroughParameters.length > 0) {
    capabilities.allowedPassthroughParameters = allowedPassthroughParameters;
  }
  return capabilities;
}

function projectOpenRouterVideoModelsToCatalogEntries(
  payload: unknown,
): Array<UnifiedModelCatalogEntry<OpenRouterVideoModelCatalogCapabilities>> {
  const entries: Array<UnifiedModelCatalogEntry<OpenRouterVideoModelCatalogCapabilities>> = [];
  const seen = new Set<string>();
  const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  for (const model of models) {
    if (!isOpenRouterVideoModel(model)) {
      continue;
    }
    const id = normalizeOptionalString(model.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const entry: UnifiedModelCatalogEntry<OpenRouterVideoModelCatalogCapabilities> = {
      kind: "video_generation",
      provider: "openrouter",
      model: id,
      source: "live",
      capabilities: buildOpenRouterVideoModelCapabilities(model),
    };
    const name = normalizeOptionalString(model.name);
    if (name) {
      entry.label = name;
    }
    entries.push(entry);
  }
  return entries;
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

function buildRequestPolicyCacheKey(request: OpenRouterVideoRequestPolicyCacheKey): unknown {
  return stableCacheKeyValue(request ?? null);
}

function resolveOpenRouterVideoCatalogRequest(params: {
  apiKey: string;
  baseUrl: string | undefined;
  request: OpenRouterVideoRequestConfig;
}) {
  const request = sanitizeConfiguredModelProviderRequest(params.request);
  return {
    ...resolveProviderHttpRequestConfig({
      provider: "openrouter",
      capability: "video",
      baseUrl: params.baseUrl,
      defaultBaseUrl: OPENROUTER_BASE_URL,
      defaultHeaders: {
        Authorization: `Bearer ${params.apiKey}`,
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      },
      request,
    }),
    requestPolicyCacheKey: buildRequestPolicyCacheKey(request),
  };
}

async function fetchOpenRouterVideoModels(params: {
  baseUrl: string;
  apiKey: string;
  headers: Headers;
  requestPolicyCacheKey: unknown;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
}): Promise<unknown> {
  return await getCachedLiveCatalogValue({
    keyParts: [
      "openrouter",
      "video-models",
      params.baseUrl,
      params.apiKey,
      params.requestPolicyCacheKey,
    ],
    load: async () => {
      const { response, release } = await fetchOpenRouterVideoGet({
        url: "videos/models",
        baseUrl: params.baseUrl,
        headers: params.headers,
        timeoutMs: params.timeoutMs,
        allowPrivateNetwork: params.allowPrivateNetwork,
        dispatcherPolicy: params.dispatcherPolicy,
        auditContext: "openrouter-video-models",
      });
      try {
        await assertOkOrThrowHttpError(response, "OpenRouter video models request failed");
        return await readProviderJsonResponse<unknown>(
          response,
          "OpenRouter video models request failed",
        );
      } finally {
        await release();
      }
    },
  });
}

export async function listOpenRouterVideoModelCatalog(
  ctx: UnifiedModelCatalogProviderContext,
): Promise<Array<UnifiedModelCatalogEntry<OpenRouterVideoModelCatalogCapabilities>> | null> {
  const { discoveryApiKey: apiKey } = ctx.resolveProviderApiKey("openrouter");
  if (!apiKey) {
    return null;
  }
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, requestPolicyCacheKey } =
    resolveOpenRouterVideoCatalogRequest({
      apiKey,
      baseUrl: ctx.config.models?.providers?.openrouter?.baseUrl,
      request: ctx.config.models?.providers?.openrouter?.request,
    });
  const payload = await fetchOpenRouterVideoModels({
    baseUrl,
    apiKey,
    headers,
    requestPolicyCacheKey,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    allowPrivateNetwork,
    dispatcherPolicy,
  });
  return projectOpenRouterVideoModelsToCatalogEntries(payload);
}

export async function resolveOpenRouterVideoModelCapabilities(
  ctx: VideoGenerationModelCapabilitiesContext,
): Promise<VideoGenerationProviderCapabilities | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: "openrouter",
    cfg: ctx.cfg,
    agentDir: ctx.agentDir,
    store: ctx.authStore,
  });
  if (!auth.apiKey) {
    return undefined;
  }
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy, requestPolicyCacheKey } =
    resolveOpenRouterVideoCatalogRequest({
      apiKey: auth.apiKey,
      baseUrl: ctx.cfg?.models?.providers?.openrouter?.baseUrl,
      request: ctx.cfg?.models?.providers?.openrouter?.request,
    });
  const payload = await fetchOpenRouterVideoModels({
    baseUrl,
    apiKey: auth.apiKey,
    headers,
    requestPolicyCacheKey,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    allowPrivateNetwork,
    dispatcherPolicy,
  });
  return projectOpenRouterVideoModelsToCatalogEntries(payload).find(
    (entry) => entry.model === ctx.model,
  )?.capabilities;
}

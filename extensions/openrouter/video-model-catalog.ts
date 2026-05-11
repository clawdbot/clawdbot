import {
  type UnifiedModelCatalogEntry,
  type UnifiedModelCatalogProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { getCachedLiveCatalogValue } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  assertOkOrThrowHttpError,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
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

type OpenRouterVideoModelsResponse = {
  data?: OpenRouterVideoModel[];
};

export type OpenRouterVideoModelCatalogCapabilities = VideoGenerationProviderCapabilities & {
  allowedPassthroughParameters?: readonly string[];
  canonicalSlug?: string;
  created?: number;
  description?: string;
  pricingSkus?: Readonly<Record<string, string>>;
};

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => Boolean(entry))
    : [];
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

function buildOpenRouterVideoModelCapabilities(
  model: OpenRouterVideoModel,
): OpenRouterVideoModelCatalogCapabilities {
  const aspectRatios = normalizeStringArray(model.supported_aspect_ratios);
  const durations = normalizeNumberArray(model.supported_durations);
  const frameImages = normalizeFrameImageRoles(model.supported_frame_images);
  const resolutions = normalizeResolutionArray(model.supported_resolutions);
  const sizes = normalizeStringArray(model.supported_sizes);
  const allowedPassthroughParameters = normalizeStringArray(model.allowed_passthrough_parameters);
  const audioSupport =
    typeof model.generate_audio === "boolean" ? { supportsAudio: model.generate_audio } : {};
  const base: VideoGenerationProviderCapabilities = {
    providerOptions: {
      callback_url: "string",
      seed: "number",
    },
    generate: {
      maxVideos: 1,
      ...(durations.length > 0 ? { supportedDurationSeconds: durations } : {}),
      ...(aspectRatios.length > 0
        ? {
            supportsAspectRatio: true,
            aspectRatios,
          }
        : {}),
      ...(resolutions.length > 0
        ? {
            supportsResolution: true,
            resolutions,
          }
        : {}),
      ...(sizes.length > 0
        ? {
            supportsSize: true,
            sizes,
          }
        : {}),
      ...audioSupport,
    },
    imageToVideo: {
      enabled: frameImages.length > 0,
      maxVideos: 1,
      ...(frameImages.length > 0 ? { maxInputImages: frameImages.length } : {}),
      ...(durations.length > 0 ? { supportedDurationSeconds: durations } : {}),
      ...(aspectRatios.length > 0
        ? {
            supportsAspectRatio: true,
            aspectRatios,
          }
        : {}),
      ...(resolutions.length > 0
        ? {
            supportsResolution: true,
            resolutions,
          }
        : {}),
      ...(sizes.length > 0
        ? {
            supportsSize: true,
            sizes,
          }
        : {}),
      ...audioSupport,
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
  payload: OpenRouterVideoModelsResponse,
): Array<UnifiedModelCatalogEntry<OpenRouterVideoModelCatalogCapabilities>> {
  const entries: Array<UnifiedModelCatalogEntry<OpenRouterVideoModelCatalogCapabilities>> = [];
  const seen = new Set<string>();
  for (const model of payload.data ?? []) {
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

async function fetchOpenRouterVideoModels(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  allowPrivateNetwork: boolean;
  dispatcherPolicy: OpenRouterVideoDispatcherPolicy;
}): Promise<OpenRouterVideoModelsResponse> {
  return await getCachedLiveCatalogValue({
    keyParts: ["openrouter", "video-models", params.baseUrl, params.apiKey],
    load: async () => {
      const headers = new Headers({
        Authorization: `Bearer ${params.apiKey}`,
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
      });
      const { response, release } = await fetchOpenRouterVideoGet({
        url: "videos/models",
        baseUrl: params.baseUrl,
        headers,
        timeoutMs: params.timeoutMs,
        allowPrivateNetwork: params.allowPrivateNetwork,
        dispatcherPolicy: params.dispatcherPolicy,
        auditContext: "openrouter-video-models",
      });
      try {
        await assertOkOrThrowHttpError(response, "OpenRouter video models request failed");
        return (await response.json()) as OpenRouterVideoModelsResponse;
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
  const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    provider: "openrouter",
    capability: "video",
    baseUrl: ctx.config.models?.providers?.openrouter?.baseUrl,
    defaultBaseUrl: OPENROUTER_BASE_URL,
  });
  const payload = await fetchOpenRouterVideoModels({
    baseUrl,
    apiKey,
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
  const { baseUrl, allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    provider: "openrouter",
    capability: "video",
    baseUrl: ctx.cfg?.models?.providers?.openrouter?.baseUrl,
    defaultBaseUrl: OPENROUTER_BASE_URL,
  });
  const payload = await fetchOpenRouterVideoModels({
    baseUrl,
    apiKey: auth.apiKey,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    allowPrivateNetwork,
    dispatcherPolicy,
  });
  return projectOpenRouterVideoModelsToCatalogEntries(payload).find(
    (entry) => entry.model === ctx.model,
  )?.capabilities;
}

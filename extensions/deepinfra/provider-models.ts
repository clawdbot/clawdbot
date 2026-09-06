import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
// Deepinfra provider module implements model/runtime integration.
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  buildManifestModelProviderConfig,
  getCachedLiveCatalogValue,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_TTS_FALLBACK_CATALOG,
  type DeepInfraSurfaceModel,
} from "./media-models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { parseDeepInfraPricingCatalog } from "./pricing-api.js";

const log = createSubsystemLogger("deepinfra-models");

const DEEPINFRA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "deepinfra",
  catalog: manifest.modelCatalog.providers.deepinfra,
});

const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;
const DEEPINFRA_PRICING_URL = "https://api.deepinfra.com/models/list";

const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V4-Flash";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = DEEPINFRA_MANIFEST_PROVIDER.models;

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

type DeepInfraDiscoveryOptions = {
  hasApiKey?: boolean;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  discoveryMode?: "strict" | "advisory";
};

type DeepInfraAgentModelPricing = DeepInfraSurfaceModel["pricing"];

interface DeepInfraAgentModelMetadata {
  description?: string;
  context_length?: number | null;
  max_tokens?: number | null;
  pricing?: DeepInfraAgentModelPricing;
  tags?: string[];
  default_width?: number | null;
  default_height?: number | null;
  default_iterations?: number | null;
}

interface DeepInfraAgentModelEntry {
  id: string;
  metadata: DeepInfraAgentModelMetadata | null;
}

type DeepInfraSurface = "chat" | "vlm" | "embed" | "image-gen" | "video-gen" | "tts" | "stt";

interface DeepInfraDiscoveredCatalog {
  chat: DeepInfraSurfaceModel[];
  vlm: DeepInfraSurfaceModel[];
  embed: DeepInfraSurfaceModel[];
  imageGen: DeepInfraSurfaceModel[];
  videoGen: DeepInfraSurfaceModel[];
  tts: DeepInfraSurfaceModel[];
  stt: DeepInfraSurfaceModel[];
  /** True iff served from a successful live fetch; false for the static fallback. */
  live: boolean;
}

const SURFACE_FOR_TAG: Record<string, DeepInfraSurface> = {
  chat: "chat",
  vlm: "vlm",
  embed: "embed",
  "image-gen": "image-gen",
  "video-gen": "video-gen",
  tts: "tts",
  stt: "stt",
};

function entryToSurfaceModel(entry: DeepInfraAgentModelEntry): DeepInfraSurfaceModel | null {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!id) {
    return null;
  }
  const metadata = entry.metadata;
  if (metadata === null) {
    return null;
  }
  if (
    !isRecord(metadata) ||
    !Array.isArray(metadata.tags) ||
    metadata.tags.some((tag) => typeof tag !== "string")
  ) {
    throw new Error("DeepInfra model metadata discovery unavailable.");
  }
  const pricing: DeepInfraAgentModelPricing = metadata.pricing ?? {};
  return {
    id,
    name: id,
    description: typeof metadata.description === "string" ? metadata.description : undefined,
    tags: metadata.tags,
    contextWindow: asPositiveSafeInteger(metadata.context_length),
    maxTokens: asPositiveSafeInteger(metadata.max_tokens),
    pricing,
    defaultWidth: asPositiveSafeInteger(metadata.default_width),
    defaultHeight: asPositiveSafeInteger(metadata.default_height),
    defaultIterations: asPositiveSafeInteger(metadata.default_iterations),
  };
}

function bucketBySurface(models: DeepInfraSurfaceModel[]): DeepInfraDiscoveredCatalog {
  const catalog: DeepInfraDiscoveredCatalog = {
    chat: [],
    vlm: [],
    embed: [],
    imageGen: [],
    videoGen: [],
    tts: [],
    stt: [],
    live: true,
  };
  const buckets: Record<DeepInfraSurface, DeepInfraSurfaceModel[]> = {
    chat: catalog.chat,
    vlm: catalog.vlm,
    embed: catalog.embed,
    "image-gen": catalog.imageGen,
    "video-gen": catalog.videoGen,
    tts: catalog.tts,
    stt: catalog.stt,
  };
  for (const model of models) {
    const seen = new Set<DeepInfraSurface>();
    for (const tag of model.tags) {
      const surface = SURFACE_FOR_TAG[tag];
      if (surface && !seen.has(surface)) {
        seen.add(surface);
        buckets[surface].push(model);
      }
    }
  }
  return catalog;
}

// Static fallback. Chat rows live in openclaw.plugin.json (manifest-validated);
// non-chat surfaces live below because the manifest validator only accepts
// chat-shaped rows. These are used pre-auth / offline; live discovery
// overrides once a key is configured.
interface ManifestChatModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: { input?: number; output?: number; cacheRead?: number };
}

function manifestChatEntryToSurfaceModel(entry: ManifestChatModelEntry): DeepInfraSurfaceModel {
  const cost = entry.cost ?? {};
  const pricing: DeepInfraAgentModelPricing = {};
  if (typeof cost.input === "number") {
    pricing.input_tokens = cost.input;
  }
  if (typeof cost.output === "number") {
    pricing.output_tokens = cost.output;
  }
  if (typeof cost.cacheRead === "number" && cost.cacheRead > 0) {
    pricing.cache_read_tokens = cost.cacheRead;
  }
  const tags: string[] = ["chat"];
  if (entry.input?.includes("image")) {
    tags.push("vlm");
  }
  if (entry.reasoning) {
    tags.push("reasoning");
  }
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    tags,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    pricing,
  };
}

// Per-surface static fallback used only when no API key is configured or
// live discovery fails. Kept deliberately minimal: the dynamic
// `/v1/openai/models?sort_by=openclaw&filter=with_meta` projection is the
// real source of truth (140 tagged rows today), so every retired model
// removed from the DeepInfra catalog disappears here automatically the
// next time discovery runs. Newer entries — additional image-gen models,
// video-gen models, additional TTS voices — arrive through discovery
// without a code change.
//
// Every entry below is verified against the live catalog at the time of
// addition; entries are not pinned to historical shipped models if the
// upstream provider has retired them (e.g. `run-diffusion/Juggernaut-
// Lightning-Flux` was removed from DeepInfra and is therefore not listed
// even though earlier main releases shipped it as a fallback).
const STATIC_NON_CHAT_FALLBACK: DeepInfraSurfaceModel[] = [
  // image-gen — representative subset of currently-served models.
  {
    id: "black-forest-labs/FLUX-1-schnell",
    name: "black-forest-labs/FLUX-1-schnell",
    tags: ["image-gen"],
    pricing: { per_image_unit: 0.003 },
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultIterations: 4,
  },
  {
    id: "black-forest-labs/FLUX-1-dev",
    name: "black-forest-labs/FLUX-1-dev",
    tags: ["image-gen"],
    pricing: { per_image_unit: 0.025 },
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultIterations: 28,
  },
  {
    id: "Qwen/Qwen-Image-Max",
    name: "Qwen/Qwen-Image-Max",
    tags: ["image-gen"],
    pricing: { per_image_unit: 0.075 },
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultIterations: 28,
  },
  {
    id: "stabilityai/sdxl-turbo",
    name: "stabilityai/sdxl-turbo",
    tags: ["image-gen"],
    pricing: { per_image_unit: 0.0002 },
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultIterations: 4,
  },
  // video-gen — DeepInfra has no live video-gen catalog rows today;
  // intentionally empty here. Live discovery picks up text-to-video
  // models as soon as the backend tags them, no static row required.
  ...DEEPINFRA_TTS_FALLBACK_CATALOG,
  // stt
  {
    id: "openai/whisper-large-v3-turbo",
    name: "openai/whisper-large-v3-turbo",
    tags: ["stt"],
    pricing: { input_seconds: 0.00004 },
  },
  // embed
  {
    id: "BAAI/bge-m3",
    name: "BAAI/bge-m3",
    tags: ["embed"],
    pricing: { input_tokens: 0.01 },
    maxTokens: 8192,
    contextWindow: 8192,
  },
];

function manifestFallbackCatalog(): DeepInfraDiscoveredCatalog {
  const rawChat = (manifest.modelCatalog.providers.deepinfra.models ??
    []) as ManifestChatModelEntry[];
  const chatModels = rawChat.map(manifestChatEntryToSurfaceModel);
  const catalog = bucketBySurface([...chatModels, ...STATIC_NON_CHAT_FALLBACK]);
  catalog.live = false;
  return catalog;
}

// Sync per-surface fallback for the (sync) register callback. Media providers
// register with these defaults; live discovery feeds the chat, image, and video catalog hooks.
export function getDeepInfraSurfaceFallbackCatalog(): DeepInfraDiscoveredCatalog {
  return manifestFallbackCatalog();
}

// DeepInfra serves every model family over one OpenAI-compatible endpoint, so
// core's endpoint-based attribution resolves all of them to thinkingFormat
// "openai". DeepSeek models emit DSML tool-call markup (`<|DSML|tool_calls>`)
// and reasoning_content that core only strips/recovers when thinkingFormat is
// "deepseek"; without this tag the markup leaks into user channels and the tool
// calls are lost. Declare the dialect per family like opencode-go does for Qwen
// (extensions/opencode-go/provider-catalog.ts).
function resolveDeepInfraThinkingFormat(modelId: string | undefined): "deepseek" | undefined {
  const vendor = (modelId ?? "").toLowerCase().split("/")[0];
  return vendor === "deepseek-ai" ? "deepseek" : undefined;
}

export function buildDeepInfraModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  const thinkingFormat = model.compat?.thinkingFormat ?? resolveDeepInfraThinkingFormat(model.id);
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsUsageInStreaming: model.compat?.supportsUsageInStreaming ?? true,
      ...(thinkingFormat ? { thinkingFormat } : {}),
    },
  };
}

function chatSurfaceModelToModelDefinition(
  model: DeepInfraSurfaceModel,
): Omit<ModelDefinitionConfig, "cost"> {
  const manifestModel = DEEPINFRA_MODEL_CATALOG.find((entry) => entry.id === model.id);
  const input: Array<"text" | "image"> = model.tags.includes("vlm") ? ["text", "image"] : ["text"];
  const reasoning = model.tags.includes("reasoning") || model.tags.includes("reasoning_effort");
  return {
    id: model.id,
    name: model.name,
    reasoning: manifestModel?.reasoning ?? reasoning,
    input,
    ...(manifestModel?.compat ? { compat: manifestModel.compat } : {}),
    contextWindow: model.contextWindow ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
  };
}

function canDiscoverDeepInfra(options?: DeepInfraDiscoveryOptions): boolean {
  if (options?.hasApiKey !== undefined) {
    return options.hasApiKey;
  }
  const env = options?.env ?? process.env;
  const fromEnv = env.DEEPINFRA_API_KEY;
  return (
    (typeof fromEnv === "string" && fromEnv.trim() !== "") ||
    isProviderApiKeyConfigured({ provider: "deepinfra", agentDir: options?.agentDir })
  );
}

// Keep pre-auth offline; successful discovery shares the five-minute live catalog cache.
export async function discoverDeepInfraSurfaces(
  options?: DeepInfraDiscoveryOptions,
): Promise<DeepInfraDiscoveredCatalog> {
  if (canDiscoverDeepInfra(options)) {
    try {
      return await loadDeepInfraSurfaces();
    } catch (error) {
      log.warn(`Model metadata discovery unavailable: ${String(error)}`);
    }
  }
  return manifestFallbackCatalog();
}

async function loadDeepInfraSurfaces(): Promise<DeepInfraDiscoveredCatalog> {
  return getCachedLiveCatalogValue({
    keyParts: ["deepinfra", "surfaces", DEEPINFRA_MODELS_URL],
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    load: async () => {
      const data = await fetchLiveProviderModelRows({
        providerId: "deepinfra",
        endpoint: DEEPINFRA_MODELS_URL,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        buildRequestHeaders: () => ({ Accept: "application/json" }),
        auditContext: "deepinfra-model-discovery",
        fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
      });
      const seenIds = new Set<string>();
      const surfaceModels: DeepInfraSurfaceModel[] = [];
      for (const entry of data) {
        const model = entryToSurfaceModel(entry as DeepInfraAgentModelEntry);
        if (!model || seenIds.has(model.id)) {
          continue;
        }
        seenIds.add(model.id);
        surfaceModels.push(model);
      }
      if (data.length > 0 && surfaceModels.length === 0) {
        throw new Error("DeepInfra model metadata discovery unavailable.");
      }
      return bucketBySurface(surfaceModels);
    },
  });
}

async function discoverDeepInfraPricing() {
  return await getCachedLiveCatalogValue({
    keyParts: ["deepinfra", "native-pricing", DEEPINFRA_PRICING_URL],
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    load: async () => {
      const rows = await fetchLiveProviderModelRows({
        providerId: "deepinfra",
        endpoint: DEEPINFRA_PRICING_URL,
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        buildRequestHeaders: () => ({ Accept: "application/json" }),
        auditContext: "deepinfra-pricing-discovery",
        fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
        readRows: (body) => {
          if (!Array.isArray(body)) {
            throw new Error("Native DeepInfra pricing response must be an array");
          }
          return body;
        },
      });
      const prices = parseDeepInfraPricingCatalog(rows);
      if (!prices) {
        throw new Error("Native DeepInfra pricing is malformed or has no usable schedules");
      }
      return prices;
    },
  });
}

export async function discoverDeepInfraModels(
  options?: DeepInfraDiscoveryOptions,
): Promise<ModelDefinitionConfig[]> {
  if (!canDiscoverDeepInfra(options)) {
    return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
  }
  const strict = options?.discoveryMode !== "advisory";
  // Resolve auth once and load independent public facts concurrently within the discovery deadline.
  // Finish both request releases before publishing; media only loads the projection.
  const [metadata, pricing] = await Promise.allSettled([
    loadDeepInfraSurfaces(),
    discoverDeepInfraPricing(),
  ]);
  if (metadata.status === "rejected") {
    if (strict) {
      throw metadata.reason;
    }
    if (pricing.status === "rejected") {
      return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
    }
  }
  const catalog = metadata.status === "fulfilled" ? metadata.value : undefined;
  const chatModels = catalog ? (catalog.chat.length > 0 ? catalog.chat : catalog.vlm) : [];
  // No price schedule is needed to publish an authoritative empty chat inventory.
  if (strict && chatModels.length === 0) {
    return [];
  }
  if (strict && pricing.status === "rejected") {
    throw pricing.reason;
  }
  const prices = pricing.status === "fulfilled" ? pricing.value : undefined;
  const models = chatModels.map(chatSurfaceModelToModelDefinition);
  if (!strict) {
    const discovered = new Set(models.map((model) => model.id));
    models.push(...DEEPINFRA_MODEL_CATALOG.filter((model) => !discovered.has(model.id)));
  }
  const unknownPrices = models.filter((model) => !prices?.has(model.id)).length;
  if (unknownPrices > 0) {
    log.warn(
      `Native pricing unavailable or qualified for ${unknownPrices} models; keeping metadata with unknown estimates. Configure explicit model costs if needed.`,
    );
  }
  // Runtime requires zeros for unknown prices; this is not evidence of free billing.
  return models.map((model) =>
    buildDeepInfraModelDefinition({
      ...model,
      cost: prices?.get(model.id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  );
}

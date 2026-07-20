// Deepinfra provider module implements model/runtime integration.

import { withTrustedEnvProxyGuardedFetchMode } from "openclaw/plugin-sdk/fetch-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import {
  getCachedLiveProviderModelRows,
  LiveModelCatalogHttpError,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { asPositiveSafeInteger } from "openclaw/plugin-sdk/string-coerce-runtime";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const log = createSubsystemLogger("deepinfra-models");

const DEEPINFRA_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: "deepinfra",
  catalog: manifest.modelCatalog.providers.deepinfra,
});

export const DEEPINFRA_BASE_URL = DEEPINFRA_MANIFEST_PROVIDER.baseUrl;
const DEEPINFRA_MODELS_URL = `${DEEPINFRA_BASE_URL}/models?sort_by=openclaw&filter=with_meta`;

const DEEPINFRA_DEFAULT_MODEL_ID = "deepseek-ai/DeepSeek-V4-Flash";
export const DEEPINFRA_DEFAULT_MODEL_REF = `deepinfra/${DEEPINFRA_DEFAULT_MODEL_ID}`;

const DEEPINFRA_DEFAULT_CONTEXT_WINDOW = 128000;
const DEEPINFRA_DEFAULT_MAX_TOKENS = 8192;

export const DEEPINFRA_MODEL_CATALOG: ModelDefinitionConfig[] = DEEPINFRA_MANIFEST_PROVIDER.models;

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

type DeepInfraAuthConfig = {
  secrets?: { defaults?: { env?: string; file?: string; exec?: string } };
  models?: { providers?: Record<string, { apiKey?: unknown } | undefined> };
};

// Wire format — mirrors deepapi/agent_models_api.AgentOpenAIModelsOut.
interface DeepInfraAgentModelPricing {
  // chat / vlm / embed
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  // image-gen
  per_image_unit?: number;
  // video-gen
  output_seconds?: number;
  // tts
  input_characters?: number;
  // stt
  input_seconds?: number;
}

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

export interface DeepInfraSurfaceModel {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  contextWindow?: number;
  maxTokens?: number;
  pricing: DeepInfraAgentModelPricing;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultIterations?: number;
}

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
  if (!metadata) {
    return null;
  }
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((t): t is string => typeof t === "string")
    : [];
  const pricing: DeepInfraAgentModelPricing = metadata.pricing ?? {};
  return {
    id,
    name: id,
    description: metadata.description ?? undefined,
    tags,
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

function hasDeepInfraSurfaceModelRows(rows: readonly unknown[]): boolean {
  return rows.some((entry) => entryToSurfaceModel(entry as DeepInfraAgentModelEntry) !== null);
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
  // tts — Kokoro first so the shipped default voice (af_bella) pairs with
  // the chosen default model; the rest are alternative TTS providers
  // currently served by DeepInfra. Qwen3-TTS / chatterbox-turbo / csm-1b
  // each require their own voice; they ship as discoverable alternatives,
  // not the implicit default.
  {
    id: "hexgrad/Kokoro-82M",
    name: "hexgrad/Kokoro-82M",
    tags: ["tts"],
    pricing: { input_characters: 0.65 },
  },
  {
    id: "Qwen/Qwen3-TTS",
    name: "Qwen/Qwen3-TTS",
    tags: ["tts"],
    pricing: { input_characters: 0.65 },
  },
  {
    id: "ResembleAI/chatterbox-turbo",
    name: "ResembleAI/chatterbox-turbo",
    tags: ["tts"],
    pricing: { input_characters: 1 },
  },
  {
    id: "sesame/csm-1b",
    name: "sesame/csm-1b",
    tags: ["tts"],
    pricing: { input_characters: 7 },
  },
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
// register with these defaults; live discovery feeds the chat surface via
// augmentModelCatalog and the catalog seams for image/video-gen.
export function getDeepInfraSurfaceFallbackCatalog(): DeepInfraDiscoveredCatalog {
  return manifestFallbackCatalog();
}

export function buildDeepInfraModelDefinition(model: ModelDefinitionConfig): ModelDefinitionConfig {
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsUsageInStreaming: model.compat?.supportsUsageInStreaming ?? true,
    },
  };
}

function chatSurfaceModelToModelDefinition(model: DeepInfraSurfaceModel): ModelDefinitionConfig {
  const input: Array<"text" | "image"> = model.tags.includes("vlm") ? ["text", "image"] : ["text"];
  const reasoning = model.tags.includes("reasoning") || model.tags.includes("reasoning_effort");
  return buildDeepInfraModelDefinition({
    id: model.id,
    name: model.name,
    reasoning,
    input,
    contextWindow: model.contextWindow ?? DEEPINFRA_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEEPINFRA_DEFAULT_MAX_TOKENS,
    cost: {
      input: model.pricing.input_tokens ?? 0,
      output: model.pricing.output_tokens ?? 0,
      cacheRead: model.pricing.cache_read_tokens ?? 0,
      cacheWrite: 0,
    },
  });
}

// Gate dynamic discovery on key presence: pre-auth keeps the picker tight and
// avoids a useless network call. The endpoint itself is unauthenticated.
// Accepts env-var keys and auth-profile-store keys via the shared
// `isProviderApiKeyConfigured` helper (covers SecretRef / `OPENCLAW_LIVE_*`
// indirection too).
export function hasDeepInfraApiKey(options?: {
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  config?: DeepInfraAuthConfig;
}): boolean {
  const env = options?.env ?? process.env;
  const fromEnv = env.DEEPINFRA_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return true;
  }
  const providers = options?.config?.models?.providers;
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    if (
      providerId.trim().toLowerCase() === "deepinfra" &&
      hasConfiguredSecretInput(provider?.apiKey, options?.config?.secrets?.defaults)
    ) {
      return true;
    }
  }
  return isProviderApiKeyConfigured({ provider: "deepinfra", agentDir: options?.agentDir });
}

// Discover the per-surface catalog. Falls back to the static manifest when
// no key, fetch fails, or running under Vitest. 5-minute cache on success.
export async function discoverDeepInfraSurfaces(options?: {
  hasApiKey?: boolean;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<DeepInfraDiscoveredCatalog> {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return manifestFallbackCatalog();
  }

  const env = options?.env ?? process.env;
  const hasKey = options?.hasApiKey ?? hasDeepInfraApiKey({ env, agentDir: options?.agentDir });
  if (!hasKey) {
    return manifestFallbackCatalog();
  }

  try {
    const data = await getCachedLiveProviderModelRows({
      providerId: "deepinfra",
      endpoint: DEEPINFRA_MODELS_URL,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      buildRequestHeaders: () => ({ Accept: "application/json" }),
      auditContext: "deepinfra-model-discovery",
      shouldCacheRows: hasDeepInfraSurfaceModelRows,
      fetchGuard: (params) => fetchWithSsrFGuard(withTrustedEnvProxyGuardedFetchMode(params)),
    });
    if (data.length === 0) {
      log.warn("No models found from DeepInfra agent-projection endpoint, using static catalog");
      return manifestFallbackCatalog();
    }
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
    if (surfaceModels.length === 0) {
      return manifestFallbackCatalog();
    }
    return bucketBySurface(surfaceModels);
  } catch (error) {
    if (error instanceof LiveModelCatalogHttpError) {
      log.warn(`Failed to discover models: HTTP ${error.status}, using static catalog`);
      return manifestFallbackCatalog();
    }
    log.warn(`Discovery failed: ${String(error)}, using static catalog`);
    return manifestFallbackCatalog();
  }
}

// Chat-only shim for callers that haven't migrated to the per-surface catalog
// (provider-catalog.ts, augmentModelCatalog).
export async function discoverDeepInfraModels(options?: {
  hasApiKey?: boolean;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<ModelDefinitionConfig[]> {
  const catalog = await discoverDeepInfraSurfaces(options);
  const chatModels = catalog.chat.length > 0 ? catalog.chat : [...catalog.chat, ...catalog.vlm];
  if (chatModels.length === 0) {
    // True empty (no manifest entries either) — keep behavior stable.
    return DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition);
  }
  const liveModels = chatModels.map(chatSurfaceModelToModelDefinition);
  const seen = new Set(liveModels.map((model) => model.id));
  const manifestModels = DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition).filter(
    (model) => {
      if (seen.has(model.id)) {
        return false;
      }
      seen.add(model.id);
      return true;
    },
  );
  return [...liveModels, ...manifestModels];
}

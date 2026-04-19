// Manual facade. Keep loader boundary explicit.
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  OpenClawConfig,
} from "../config/types.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type LmstudioReasoningCapabilityWire = {
  allowed_options?: unknown;
  default?: unknown;
};

export type LmstudioModelWire = {
  type?: "llm" | "embedding";
  key?: string;
  display_name?: string;
  max_context_length?: number;
  format?: "gguf" | "mlx" | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: LmstudioReasoningCapabilityWire;
  };
  loaded_instances?: Array<{
    id?: string;
    config?: {
      context_length?: number;
    } | null;
  } | null>;
};

export type LmstudioModelBase = {
  id: string;
  displayName: string;
  format: "gguf" | "mlx" | null;
  vision: boolean;
  trainedForToolUse: boolean;
  loaded: boolean;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
};

type FacadeModule = {
  LMSTUDIO_DEFAULT_BASE_URL: string;
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: string;
  LMSTUDIO_DEFAULT_EMBEDDING_MODEL: string;
  LMSTUDIO_PROVIDER_LABEL: string;
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: string;
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER: string;
  LMSTUDIO_MODEL_PLACEHOLDER: string;
  LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH: number;
  LMSTUDIO_DEFAULT_MODEL_ID: string;
  LMSTUDIO_PROVIDER_ID: string;
  resolveLmstudioReasoningCapability: (entry: Pick<LmstudioModelWire, "capabilities">) => boolean;
  resolveLoadedContextWindow: (entry: Pick<LmstudioModelWire, "loaded_instances">) => number | null;
  resolveLmstudioServerBase: (configuredBaseUrl?: string) => string;
  resolveLmstudioInferenceBase: (configuredBaseUrl?: string) => string;
  normalizeLmstudioProviderConfig: (provider: ModelProviderConfig) => ModelProviderConfig;
  fetchLmstudioModels: (params?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }) => Promise<unknown>;
  mapLmstudioWireEntry: (entry: LmstudioModelWire) => LmstudioModelBase | null;
  discoverLmstudioModels: (params?: {
    config?: OpenClawConfig;
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
  }) => Promise<ModelDefinitionConfig[]>;
  ensureLmstudioModelLoaded: (params: Record<string, unknown>) => Promise<unknown>;
  buildLmstudioAuthHeaders: (params: {
    apiKey?: string;
    json?: boolean;
    headers?: Record<string, string>;
  }) => Record<string, string> | undefined;
  resolveLmstudioConfiguredApiKey: (params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    path?: string;
  }) => Promise<string | undefined>;
  resolveLmstudioProviderHeaders: (params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    headers?: unknown;
    path?: string;
  }) => Promise<Record<string, string> | undefined>;
  resolveLmstudioRuntimeApiKey: (params: {
    config?: OpenClawConfig;
    agentDir?: string;
    env?: NodeJS.ProcessEnv;
    headers?: unknown;
  }) => Promise<string | undefined>;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "lmstudio",
    artifactBasename: "runtime-api.js",
  });
}

// Keep defaults inline so importing the runtime facade stays cold until a helper
// is actually used. These values are part of the public LM Studio contract.
export const LMSTUDIO_DEFAULT_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_BASE_URL"] =
  "http://localhost:1234";
export const LMSTUDIO_DEFAULT_INFERENCE_BASE_URL: FacadeModule["LMSTUDIO_DEFAULT_INFERENCE_BASE_URL"] = `${LMSTUDIO_DEFAULT_BASE_URL}/v1`;
export const LMSTUDIO_DEFAULT_EMBEDDING_MODEL: FacadeModule["LMSTUDIO_DEFAULT_EMBEDDING_MODEL"] =
  "text-embedding-nomic-embed-text-v1.5";
export const LMSTUDIO_PROVIDER_LABEL: FacadeModule["LMSTUDIO_PROVIDER_LABEL"] = "LM Studio";
export const LMSTUDIO_DEFAULT_API_KEY_ENV_VAR: FacadeModule["LMSTUDIO_DEFAULT_API_KEY_ENV_VAR"] =
  "LM_API_TOKEN";
export const LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER: FacadeModule["LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER"] =
  "lmstudio-local";
export const LMSTUDIO_MODEL_PLACEHOLDER: FacadeModule["LMSTUDIO_MODEL_PLACEHOLDER"] =
  "model-key-from-api-v1-models";
export const LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH: FacadeModule["LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH"] = 64000;
export const LMSTUDIO_DEFAULT_MODEL_ID: FacadeModule["LMSTUDIO_DEFAULT_MODEL_ID"] =
  "qwen/qwen3.5-9b";
export const LMSTUDIO_PROVIDER_ID: FacadeModule["LMSTUDIO_PROVIDER_ID"] = "lmstudio";

export const resolveLmstudioReasoningCapability: FacadeModule["resolveLmstudioReasoningCapability"] =
  createLazyFacadeValue("resolveLmstudioReasoningCapability");
export const resolveLoadedContextWindow: FacadeModule["resolveLoadedContextWindow"] =
  createLazyFacadeValue("resolveLoadedContextWindow");
export const resolveLmstudioServerBase: FacadeModule["resolveLmstudioServerBase"] =
  createLazyFacadeValue("resolveLmstudioServerBase");
export const resolveLmstudioInferenceBase: FacadeModule["resolveLmstudioInferenceBase"] =
  createLazyFacadeValue("resolveLmstudioInferenceBase");
export const normalizeLmstudioProviderConfig: FacadeModule["normalizeLmstudioProviderConfig"] =
  createLazyFacadeValue("normalizeLmstudioProviderConfig");
export const fetchLmstudioModels: FacadeModule["fetchLmstudioModels"] =
  createLazyFacadeValue("fetchLmstudioModels");
export const mapLmstudioWireEntry: FacadeModule["mapLmstudioWireEntry"] =
  createLazyFacadeValue("mapLmstudioWireEntry");
export const discoverLmstudioModels: FacadeModule["discoverLmstudioModels"] =
  createLazyFacadeValue("discoverLmstudioModels");
export const ensureLmstudioModelLoaded: FacadeModule["ensureLmstudioModelLoaded"] =
  createLazyFacadeValue("ensureLmstudioModelLoaded");
export const buildLmstudioAuthHeaders: FacadeModule["buildLmstudioAuthHeaders"] =
  createLazyFacadeValue("buildLmstudioAuthHeaders");
export const resolveLmstudioConfiguredApiKey: FacadeModule["resolveLmstudioConfiguredApiKey"] =
  createLazyFacadeValue("resolveLmstudioConfiguredApiKey");
export const resolveLmstudioProviderHeaders: FacadeModule["resolveLmstudioProviderHeaders"] =
  createLazyFacadeValue("resolveLmstudioProviderHeaders");
export const resolveLmstudioRuntimeApiKey: FacadeModule["resolveLmstudioRuntimeApiKey"] =
  createLazyFacadeValue("resolveLmstudioRuntimeApiKey");

function createLazyFacadeValue<K extends keyof FacadeModule>(key: K): FacadeModule[K] {
  return ((...args: unknown[]) => {
    const value = loadFacadeModule()[key];
    if (typeof value !== "function") {
      return value;
    }
    return (value as (...innerArgs: unknown[]) => unknown)(...args);
  }) as FacadeModule[K];
}

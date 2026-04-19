import type { OpenClawConfig } from "../config/types.js";
import type {
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
} from "../plugins/types.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type {
  OpenClawPluginApi,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderCatalogContext,
  ProviderDiscoveryContext,
  ProviderPrepareDynamicModelContext,
  ProviderRuntimeModel,
} from "../plugins/types.js";
export type { LmstudioModelBase, LmstudioModelWire } from "./lmstudio-runtime.js";
export {
  LMSTUDIO_DEFAULT_API_KEY_ENV_VAR,
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_DEFAULT_EMBEDDING_MODEL,
  LMSTUDIO_DEFAULT_INFERENCE_BASE_URL,
  LMSTUDIO_DEFAULT_LOAD_CONTEXT_LENGTH,
  LMSTUDIO_DEFAULT_MODEL_ID,
  LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER,
  LMSTUDIO_MODEL_PLACEHOLDER,
  LMSTUDIO_PROVIDER_ID,
  LMSTUDIO_PROVIDER_LABEL,
  buildLmstudioAuthHeaders,
  discoverLmstudioModels,
  ensureLmstudioModelLoaded,
  fetchLmstudioModels,
  mapLmstudioWireEntry,
  normalizeLmstudioProviderConfig,
  resolveLoadedContextWindow,
  resolveLmstudioConfiguredApiKey,
  resolveLmstudioInferenceBase,
  resolveLmstudioProviderHeaders,
  resolveLmstudioReasoningCapability,
  resolveLmstudioRuntimeApiKey,
  resolveLmstudioServerBase,
} from "./lmstudio-runtime.js";

import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type LmstudioInteractiveParams = {
  config: OpenClawConfig;
  prompter?: WizardPrompter;
  secretInputMode?: unknown;
  allowSecretRefPrompt?: boolean;
  promptText?: (params: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string | undefined) => string | undefined;
  }) => Promise<string | undefined>;
  note?: (message: string, title?: string) => Promise<void> | void;
};

type FacadeModule = {
  promptAndConfigureLmstudioInteractive: (
    params: LmstudioInteractiveParams,
  ) => Promise<ProviderAuthResult>;
  configureLmstudioNonInteractive: (
    ctx: ProviderAuthMethodNonInteractiveContext,
  ) => Promise<OpenClawConfig | null>;
  discoverLmstudioProvider: (
    ctx: ProviderCatalogContext,
  ) => Promise<{ provider: import("../config/types.js").ModelProviderConfig } | null>;
  prepareLmstudioDynamicModels: (
    ctx: ProviderPrepareDynamicModelContext,
  ) => Promise<ProviderRuntimeModel[]>;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "lmstudio",
    artifactBasename: "api.js",
  });
}

export const promptAndConfigureLmstudioInteractive: FacadeModule["promptAndConfigureLmstudioInteractive"] =
  ((...args) =>
    loadFacadeModule().promptAndConfigureLmstudioInteractive(
      ...args,
    )) as FacadeModule["promptAndConfigureLmstudioInteractive"];
export const configureLmstudioNonInteractive: FacadeModule["configureLmstudioNonInteractive"] = ((
  ...args
) =>
  loadFacadeModule().configureLmstudioNonInteractive(
    ...args,
  )) as FacadeModule["configureLmstudioNonInteractive"];
export const discoverLmstudioProvider: FacadeModule["discoverLmstudioProvider"] = ((...args) =>
  loadFacadeModule().discoverLmstudioProvider(...args)) as FacadeModule["discoverLmstudioProvider"];
export const prepareLmstudioDynamicModels: FacadeModule["prepareLmstudioDynamicModels"] = ((
  ...args
) =>
  loadFacadeModule().prepareLmstudioDynamicModels(
    ...args,
  )) as FacadeModule["prepareLmstudioDynamicModels"];

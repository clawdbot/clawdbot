import fs from "node:fs";
import path from "node:path";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  normalizeModelCatalog,
  normalizeModelCatalogProviderId,
  type ModelCatalog,
  type ModelCatalogAlias,
  type ModelCatalogCost,
  type ModelCatalogDiscovery,
  type ModelCatalogInput,
  type ModelCatalogModel,
  type ModelCatalogProvider,
  type ModelCatalogStatus,
  type ModelCatalogSuppression,
  type ModelCatalogTieredCost,
} from "../model-catalog/index.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  normalizeManifestCommandAliases,
  type PluginManifestCommandAlias,
} from "./manifest-command-aliases.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import { createPluginCacheKey, PluginLruCache } from "./plugin-cache-primitives.js";
import type { PluginKind } from "./plugin-kind.types.js";

export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;
export const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_MANIFEST_LOAD_CACHE_ENTRIES = 512;

type PluginManifestLoadCacheEntry = {
  result: PluginManifestLoadResult;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const pluginManifestLoadCache = new PluginLruCache<PluginManifestLoadCacheEntry>(
  MAX_PLUGIN_MANIFEST_LOAD_CACHE_ENTRIES,
);

export function clearPluginManifestLoadCache(): void {
  pluginManifestLoadCache.clear();
}

export type PluginManifestChannelConfig = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, PluginConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
  label?: string;
  description?: string;
  preferOver?: string[];
  commands?: PluginManifestChannelCommandDefaults;
};

export type PluginManifestChannelCommandDefaults = {
  nativeCommandsAutoEnabled?: boolean;
  nativeSkillsAutoEnabled?: boolean;
};

export type PluginManifestModelSupport = {
  /**
   * Cheap manifest-owned model-id prefixes for transparent provider activation
   * from shorthand model refs such as `gpt-5.4` or `claude-sonnet-4.6`.
   */
  modelPrefixes?: string[];
  /**
   * Regex sources matched against the raw model id after profile suffixes are
   * stripped. Use this when simple prefixes are not expressive enough.
   */
  modelPatterns?: string[];
};

export type PluginManifestModelCatalogInput = ModelCatalogInput;
export type PluginManifestModelCatalogDiscovery = ModelCatalogDiscovery;
export type PluginManifestModelCatalogStatus = ModelCatalogStatus;
export type PluginManifestModelCatalogTieredCost = ModelCatalogTieredCost;
export type PluginManifestModelCatalogCost = ModelCatalogCost;
export type PluginManifestModelCatalogModel = ModelCatalogModel;
export type PluginManifestModelCatalogProvider = ModelCatalogProvider;
export type PluginManifestModelCatalogAlias = ModelCatalogAlias;
export type PluginManifestModelCatalogSuppression = ModelCatalogSuppression;
export type PluginManifestModelCatalog = ModelCatalog;

export type PluginManifestModelPricingModelIdTransform = "version-dots";

export type PluginManifestModelPricingSource = {
  provider?: string;
  passthroughProviderModel?: boolean;
  modelIdTransforms?: PluginManifestModelPricingModelIdTransform[];
};

export type PluginManifestModelPricingProvider = {
  external?: boolean;
  openRouter?: PluginManifestModelPricingSource | false;
  liteLLM?: PluginManifestModelPricingSource | false;
};

export type PluginManifestModelPricing = {
  providers?: Record<string, PluginManifestModelPricingProvider>;
};

export type PluginManifestModelIdPrefixRule = {
  modelPrefix: string;
  prefix: string;
};

export type PluginManifestModelIdNormalizationProvider = {
  aliases?: Record<string, string>;
  stripPrefixes?: string[];
  prefixWhenBare?: string;
  prefixWhenBareAfterAliasStartsWith?: PluginManifestModelIdPrefixRule[];
};

export type PluginManifestModelIdNormalization = {
  providers?: Record<string, PluginManifestModelIdNormalizationProvider>;
};

export type PluginManifestProviderEndpoint = {
  /**
   * Core endpoint class this plugin-owned endpoint should map to. Core must
   * already know the class; manifests own host/baseUrl matching metadata.
   */
  endpointClass: string;
  /** Hostnames that should resolve to this endpoint class. */
  hosts?: string[];
  /** Host suffixes that should resolve to this endpoint class. */
  hostSuffixes?: string[];
  /** Exact normalized base URLs that should resolve to this endpoint class. */
  baseUrls?: string[];
  /** Static Google Vertex region metadata for exact global hosts. */
  googleVertexRegion?: string;
  /** Host suffix whose prefix should be exposed as the Google Vertex region. */
  googleVertexRegionHostSuffix?: string;
};

export type PluginManifestProviderRequestProvider = {
  family?: string;
  compatibilityFamily?: "moonshot";
  openAICompletions?: {
    supportsStreamingUsage?: boolean;
  };
};

export type PluginManifestProviderRequest = {
  providers?: Record<string, PluginManifestProviderRequestProvider>;
};

export type PluginManifestActivationCapability = "provider" | "channel" | "tool" | "hook";

export type PluginManifestActivation = {
  /**
   * Explicit Gateway startup activation. Set true when the plugin must be
   * imported during Gateway startup; set false when narrower activation
   * triggers should load it on demand.
   */
  onStartup?: boolean;
  /**
   * Provider ids that should include this plugin in activation/load plans.
   * This is planner metadata only; runtime behavior still comes from register().
   */
  onProviders?: string[];
  /** Agent harness runtime ids that should include this plugin in activation/load plans. */
  onAgentHarnesses?: string[];
  /** Command ids that should include this plugin in activation/load plans. */
  onCommands?: string[];
  /** Channel ids that should include this plugin in activation/load plans. */
  onChannels?: string[];
  /** Route kinds that should include this plugin in activation/load plans. */
  onRoutes?: string[];
  /** Root-relative config paths that should include this plugin in startup/load plans. */
  onConfigPaths?: string[];
  /** Broad capability hints for activation/load plans. Prefer narrower ownership metadata. */
  onCapabilities?: PluginManifestActivationCapability[];
};

export type PluginManifestDefaultPlatform = NodeJS.Platform;

export type PluginManifestSetupProvider = {
  /** Provider id surfaced during setup/onboarding. */
  id: string;
  /** Setup/auth methods that this provider supports. */
  authMethods?: string[];
  /** Environment variables that can satisfy setup without runtime loading. */
  envVars?: string[];
  /**
   * Cheap local evidence that a provider can authenticate without loading
   * runtime code. Evidence checks must not read secrets, shell out, or call
   * provider APIs.
   */
  authEvidence?: PluginManifestSetupProviderAuthEvidence[];
};

export type PluginManifestSetupProviderAuthEvidence = {
  /** Generic local file evidence gated by required environment metadata. */
  type: "local-file-with-env";
  /** Optional env var containing an explicit credential file path. */
  fileEnvVar?: string;
  /** Optional fallback credential file paths. Supports `${HOME}` and `${APPDATA}`. */
  fallbackPaths?: string[];
  /** At least one of these env vars must be non-empty when provided. */
  requiresAnyEnv?: string[];
  /** Every env var listed here must be non-empty when provided. */
  requiresAllEnv?: string[];
  /** Non-secret marker returned when this evidence is present. */
  credentialMarker: string;
  /** Human-readable auth source label. */
  source?: string;
};

export type PluginManifestSetup = {
  /** Cheap provider setup metadata exposed before runtime loads. */
  providers?: PluginManifestSetupProvider[];
  /** Setup-time backend ids available without full runtime activation. */
  cliBackends?: string[];
  /** Config migration ids owned by this plugin's setup surface. */
  configMigrations?: string[];
  /**
   * Whether setup still needs plugin runtime execution after descriptor lookup.
   * Defaults to false when omitted.
   */
  requiresRuntime?: boolean;
};

export type PluginManifestQaRunner = {
  /** Subcommand mounted beneath `openclaw qa`, for example `matrix`. */
  commandName: string;
  /** Optional user-facing help text for fallback host stubs. */
  description?: string;
};

export type PluginManifestConfigLiteral = string | number | boolean | null;

export type PluginManifestDangerousConfigFlag = {
  /**
   * Dot-separated config path relative to `plugins.entries.<id>.config`.
   * Supports `*` wildcards for map/array segments.
   */
  path: string;
  /** Exact literal that marks this config value as dangerous. */
  equals: PluginManifestConfigLiteral;
};

export type PluginManifestSecretInputPath = {
  /**
   * Dot-separated config path relative to `plugins.entries.<id>.config`.
   * Supports `*` wildcards for map/array segments.
   */
  path: string;
  /** Expected resolved type for SecretRef materialization. */
  expected?: "string";
};

export type PluginManifestSecretInputContracts = {
  /**
   * Override bundled-plugin default enablement when deciding whether this
   * SecretRef surface is active. Use this when the plugin is bundled but the
   * surface should stay inactive until explicitly enabled in config.
   */
  bundledDefaultEnabled?: boolean;
  paths: PluginManifestSecretInputPath[];
};

export type PluginManifestConfigContracts = {
  /**
   * Root-relative config paths that indicate this plugin's setup-time
   * compatibility migrations might apply. Use this to keep generic runtime
   * config reads from loading every plugin setup surface when the config does
   * not reference the plugin at all.
   */
  compatibilityMigrationPaths?: string[];
  /**
   * Root-relative compatibility paths that this plugin can service during
   * runtime before plugin code fully activates. Use this for legacy surfaces
   * that should cheaply narrow bundled candidate sets without importing every
   * compatible plugin runtime.
   */
  compatibilityRuntimePaths?: string[];
  dangerousFlags?: PluginManifestDangerousConfigFlag[];
  secretInputs?: PluginManifestSecretInputContracts;
};

export type PluginManifest = {
  id: string;
  configSchema: JsonSchemaObject;
  enabledByDefault?: boolean;
  enabledByDefaultOnPlatforms?: PluginManifestDefaultPlatform[];
  /** Legacy plugin ids that should normalize to this plugin id. */
  legacyPluginIds?: string[];
  /** Provider ids that should auto-enable this plugin when referenced in auth/config/models. */
  autoEnableWhenConfiguredProviders?: string[];
  kind?: PluginKind | PluginKind[];
  channels?: string[];
  providers?: string[];
  /**
   * Optional lightweight module that exports provider plugin metadata for
   * auth/catalog discovery. It should not import the full plugin runtime.
   */
  providerDiscoveryEntry?: string;
  /**
   * Cheap model-family ownership metadata used before plugin runtime loads.
   * Use this for shorthand model refs that omit an explicit provider prefix.
   */
  modelSupport?: PluginManifestModelSupport;
  /**
   * Declarative model catalog metadata used by future read-only listing,
   * onboarding, and model picker surfaces before provider runtime loads.
   */
  modelCatalog?: PluginManifestModelCatalog;
  /** Manifest-owned external pricing lookup policy for provider refs. */
  modelPricing?: PluginManifestModelPricing;
  /** Manifest-owned model-id normalization used before provider runtime loads. */
  modelIdNormalization?: PluginManifestModelIdNormalization;
  /** Cheap provider endpoint metadata used before provider runtime loads. */
  providerEndpoints?: PluginManifestProviderEndpoint[];
  /** Cheap provider request metadata used before provider runtime loads. */
  providerRequest?: PluginManifestProviderRequest;
  /** Cheap startup activation lookup for plugin-owned CLI inference backends. */
  cliBackends?: string[];
  /**
   * Provider or CLI backend refs whose plugin-owned synthetic auth hook should
   * be probed during cold model discovery before the runtime registry exists.
   */
  syntheticAuthRefs?: string[];
  /**
   * Bundled-plugin-owned placeholder API key values that represent non-secret
   * local, OAuth, or ambient credential state.
   */
  nonSecretAuthMarkers?: string[];
  /**
   * Plugin-owned command aliases that should resolve to this plugin during
   * config diagnostics before runtime loads.
   */
  commandAliases?: PluginManifestCommandAlias[];
  /**
   * Cheap provider-auth env lookup without booting plugin runtime.
   *
   * @deprecated Prefer setup.providers[].envVars for generic setup/status env
   * metadata. This field remains supported through the provider env-var
   * compatibility adapter during the deprecation window.
   */
  providerAuthEnvVars?: Record<string, string[]>;
  /** Provider ids that should reuse another provider id for auth lookup. */
  providerAuthAliases?: Record<string, string>;
  /** Cheap channel env lookup without booting plugin runtime. */
  channelEnvVars?: Record<string, string[]>;
  /**
   * Cheap onboarding/auth-choice metadata used by config validation, CLI help,
   * and non-runtime auth-choice routing before provider runtime loads.
   */
  providerAuthChoices?: PluginManifestProviderAuthChoice[];
  /** Cheap activation planner metadata exposed before plugin runtime loads. */
  activation?: PluginManifestActivation;
  /** Cheap setup/onboarding metadata exposed before plugin runtime loads. */
  setup?: PluginManifestSetup;
  /** Cheap QA runner metadata exposed before plugin runtime loads. */
  qaRunners?: PluginManifestQaRunner[];
  skills?: string[];
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, PluginConfigUiHint>;
  /**
   * Static capability ownership snapshot used for manifest-driven discovery,
   * compat wiring, and contract coverage without importing plugin runtime.
   */
  contracts?: PluginManifestContracts;
  /** Cheap media-understanding provider defaults without importing plugin runtime. */
  mediaUnderstandingProviderMetadata?: Record<
    string,
    PluginManifestMediaUnderstandingProviderMetadata
  >;
  /** Cheap image-generation provider auth metadata without importing plugin runtime. */
  imageGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  /** Cheap video-generation provider auth metadata without importing plugin runtime. */
  videoGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  /** Cheap music-generation provider auth metadata without importing plugin runtime. */
  musicGenerationProviderMetadata?: Record<string, PluginManifestCapabilityProviderMetadata>;
  /** Cheap plugin-tool availability metadata without importing plugin runtime. */
  toolMetadata?: Record<string, PluginManifestToolMetadata>;
  /** Manifest-owned config behavior consumed by generic core helpers. */
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
};

export type PluginManifestContracts = {
  embeddedExtensionFactories?: string[];
  agentToolResultMiddleware?: string[];
  /**
   * Provider ids whose external auth profile hook can contribute runtime-only
   * credentials. Declaring this lets auth-store overlays load only the owning
   * plugin instead of every provider plugin.
   */
  externalAuthProviders?: string[];
  memoryEmbeddingProviders?: string[];
  speechProviders?: string[];
  realtimeTranscriptionProviders?: string[];
  realtimeVoiceProviders?: string[];
  mediaUnderstandingProviders?: string[];
  documentExtractors?: string[];
  imageGenerationProviders?: string[];
  videoGenerationProviders?: string[];
  musicGenerationProviders?: string[];
  webContentExtractors?: string[];
  webFetchProviders?: string[];
  webSearchProviders?: string[];
  migrationProviders?: string[];
  tools?: string[];
};

export type PluginManifestMediaUnderstandingCapability = "image" | "audio" | "video";

export type PluginManifestMediaUnderstandingProviderMetadata = {
  capabilities?: PluginManifestMediaUnderstandingCapability[];
  defaultModels?: Partial<Record<PluginManifestMediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<PluginManifestMediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
};

export type PluginManifestProviderBaseUrlGuard = {
  provider: string;
  defaultBaseUrl?: string;
  allowedBaseUrls: string[];
};

export type PluginManifestCapabilityProviderAuthSignal = {
  provider: string;
  providerBaseUrl?: PluginManifestProviderBaseUrlGuard;
};

export type PluginManifestCapabilityProviderModeConfigSignal = {
  path?: string;
  default?: string;
  allowed?: string[];
  disallowed?: string[];
};

export type PluginManifestCapabilityProviderConfigSignal = {
  rootPath: string;
  overlayPath?: string;
  required?: string[];
  requiredAny?: string[];
  mode?: PluginManifestCapabilityProviderModeConfigSignal;
};

export type PluginManifestCapabilityProviderMetadata = {
  aliases?: string[];
  authProviders?: string[];
  authSignals?: PluginManifestCapabilityProviderAuthSignal[];
  configSignals?: PluginManifestCapabilityProviderConfigSignal[];
};

export type PluginManifestToolMetadata = PluginManifestCapabilityProviderMetadata & {
  optional?: boolean;
};

export type PluginManifestProviderAuthChoice = {
  /** Provider id owned by this manifest entry. */
  provider: string;
  /** Provider auth method id that this choice should dispatch to. */
  method: string;
  /** Stable auth-choice id used by onboarding and other CLI auth flows. */
  choiceId: string;
  /** Optional user-facing choice label/hint for grouped onboarding UI. */
  choiceLabel?: string;
  choiceHint?: string;
  /** Lower values sort earlier in interactive assistant pickers. */
  assistantPriority?: number;
  /** Keep the choice out of interactive assistant pickers while preserving manual CLI support. */
  assistantVisibility?: "visible" | "manual-only";
  /** Legacy choice ids that should point users at this replacement choice. */
  deprecatedChoiceIds?: string[];
  /** Optional grouping metadata for auth-choice pickers. */
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  /** Optional CLI flag metadata for one-flag auth flows such as API keys. */
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  /**
   * Interactive onboarding surfaces where this auth choice should appear.
   * Defaults to `["text-inference"]` when omitted.
   */
  onboardingScopes?: PluginManifestOnboardingScope[];
};

export type PluginManifestOnboardingScope = "text-inference" | "image-generation";

export type PluginManifestLoadResult =
  | { ok: true; manifest: PluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

function normalizeStringListRecord(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, string[]> = Object.create(null);
  for (const [key, rawValues] of Object.entries(value)) {
    const providerId = normalizeOptionalString(key) ?? "";
    if (!providerId || isBlockedObjectKey(providerId)) {
      continue;
    }
    const values = normalizeTrimmedStringList(rawValues);
    if (values.length === 0) {
      continue;
    }
    normalized[providerId] = values;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, string> = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey) ?? "";
    const value = normalizeOptionalString(rawValue) ?? "";
    if (!key || isBlockedObjectKey(key) || !value) {
      continue;
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

const MEDIA_UNDERSTANDING_CAPABILITIES = new Set(["image", "audio", "video"]);

function normalizeMediaUnderstandingCapabilityRecord(
  value: unknown,
): Partial<Record<PluginManifestMediaUnderstandingCapability, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Partial<Record<PluginManifestMediaUnderstandingCapability, string>> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey)) {
      continue;
    }
    const model = normalizeOptionalString(rawValue);
    if (model) {
      normalized[rawKey as PluginManifestMediaUnderstandingCapability] = model;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMediaUnderstandingPriorityRecord(
  value: unknown,
): Partial<Record<PluginManifestMediaUnderstandingCapability, number>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Partial<Record<PluginManifestMediaUnderstandingCapability, number>> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (
      !MEDIA_UNDERSTANDING_CAPABILITIES.has(rawKey) ||
      typeof rawValue !== "number" ||
      !Number.isFinite(rawValue)
    ) {
      continue;
    }
    normalized[rawKey as PluginManifestMediaUnderstandingCapability] = rawValue;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeMediaUnderstandingCapabilities(
  value: unknown,
): PluginManifestMediaUnderstandingCapability[] | undefined {
  const values = normalizeTrimmedStringList(value).filter((entry) =>
    MEDIA_UNDERSTANDING_CAPABILITIES.has(entry),
  ) as PluginManifestMediaUnderstandingCapability[];
  return values.length > 0 ? values : undefined;
}

function normalizeMediaUnderstandingNativeDocumentInputs(value: unknown): Array<"pdf"> | undefined {
  const values = normalizeTrimmedStringList(value).filter((entry) => entry === "pdf");
  return values.length > 0 ? values : undefined;
}

function normalizeMediaUnderstandingProviderMetadata(
  value: unknown,
): Record<string, PluginManifestMediaUnderstandingProviderMetadata> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestMediaUnderstandingProviderMetadata> =
    Object.create(null);
  for (const [rawProviderId, rawMetadata] of Object.entries(value)) {
    const providerId = normalizeOptionalString(rawProviderId) ?? "";
    if (!providerId || isBlockedObjectKey(providerId) || !isRecord(rawMetadata)) {
      continue;
    }
    const capabilities = normalizeMediaUnderstandingCapabilities(rawMetadata.capabilities);
    const defaultModels = normalizeMediaUnderstandingCapabilityRecord(rawMetadata.defaultModels);
    const autoPriority = normalizeMediaUnderstandingPriorityRecord(rawMetadata.autoPriority);
    const nativeDocumentInputs = normalizeMediaUnderstandingNativeDocumentInputs(
      rawMetadata.nativeDocumentInputs,
    );
    const metadata = {
      ...(capabilities ? { capabilities } : {}),
      ...(defaultModels ? { defaultModels } : {}),
      ...(autoPriority ? { autoPriority } : {}),
      ...(nativeDocumentInputs ? { nativeDocumentInputs } : {}),
    } satisfies PluginManifestMediaUnderstandingProviderMetadata;
    if (Object.keys(metadata).length > 0) {
      normalized[providerId] = metadata;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderBaseUrlGuard(
  value: unknown,
): PluginManifestProviderBaseUrlGuard | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = normalizeOptionalString(value.provider);
  const allowedBaseUrls = normalizeTrimmedStringList(value.allowedBaseUrls);
  if (!provider || allowedBaseUrls.length === 0) {
    return undefined;
  }
  const defaultBaseUrl = normalizeOptionalString(value.defaultBaseUrl);
  return {
    provider,
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
    allowedBaseUrls,
  };
}

function normalizeCapabilityProviderAuthSignals(
  value: unknown,
): PluginManifestCapabilityProviderAuthSignal[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const signals: PluginManifestCapabilityProviderAuthSignal[] = [];
  for (const rawSignal of value) {
    if (!isRecord(rawSignal)) {
      continue;
    }
    const provider = normalizeOptionalString(rawSignal.provider);
    if (!provider) {
      continue;
    }
    const providerBaseUrl = normalizeProviderBaseUrlGuard(rawSignal.providerBaseUrl);
    signals.push({
      provider,
      ...(providerBaseUrl ? { providerBaseUrl } : {}),
    });
  }
  return signals.length > 0 ? signals : undefined;
}

function normalizeCapabilityProviderModeConfigSignal(
  value: unknown,
): PluginManifestCapabilityProviderModeConfigSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = normalizeOptionalString(value.path);
  const defaultValue = normalizeOptionalString(value.default);
  const allowed = normalizeTrimmedStringList(value.allowed);
  const disallowed = normalizeTrimmedStringList(value.disallowed);
  const signal = {
    ...(path ? { path } : {}),
    ...(defaultValue ? { default: defaultValue } : {}),
    ...(allowed.length > 0 ? { allowed } : {}),
    ...(disallowed.length > 0 ? { disallowed } : {}),
  } satisfies PluginManifestCapabilityProviderModeConfigSignal;
  return Object.keys(signal).length > 0 ? signal : undefined;
}

function normalizeCapabilityProviderConfigSignals(
  value: unknown,
): PluginManifestCapabilityProviderConfigSignal[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const signals: PluginManifestCapabilityProviderConfigSignal[] = [];
  for (const rawSignal of value) {
    if (!isRecord(rawSignal)) {
      continue;
    }
    const rootPath = normalizeOptionalString(rawSignal.rootPath);
    if (!rootPath) {
      continue;
    }
    const overlayPath = normalizeOptionalString(rawSignal.overlayPath);
    const required = normalizeTrimmedStringList(rawSignal.required);
    const requiredAny = normalizeTrimmedStringList(rawSignal.requiredAny);
    const mode = normalizeCapabilityProviderModeConfigSignal(rawSignal.mode);
    const signal = {
      rootPath,
      ...(overlayPath ? { overlayPath } : {}),
      ...(required.length > 0 ? { required } : {}),
      ...(requiredAny.length > 0 ? { requiredAny } : {}),
      ...(mode ? { mode } : {}),
    } satisfies PluginManifestCapabilityProviderConfigSignal;
    if (required.length > 0 || requiredAny.length > 0 || mode) {
      signals.push(signal);
    }
  }
  return signals.length > 0 ? signals : undefined;
}

function normalizeCapabilityProviderMetadataEntry(
  rawMetadata: Record<string, unknown>,
): PluginManifestCapabilityProviderMetadata | undefined {
  const aliases = normalizeTrimmedStringList(rawMetadata.aliases);
  const authProviders = normalizeTrimmedStringList(rawMetadata.authProviders);
  const authSignals = normalizeCapabilityProviderAuthSignals(rawMetadata.authSignals);
  const configSignals = normalizeCapabilityProviderConfigSignals(rawMetadata.configSignals);
  const metadata = {
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(authProviders.length > 0 ? { authProviders } : {}),
    ...(authSignals ? { authSignals } : {}),
    ...(configSignals ? { configSignals } : {}),
  } satisfies PluginManifestCapabilityProviderMetadata;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function normalizeCapabilityProviderMetadata(
  value: unknown,
): Record<string, PluginManifestCapabilityProviderMetadata> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestCapabilityProviderMetadata> = Object.create(null);
  for (const [rawProviderId, rawMetadata] of Object.entries(value)) {
    const providerId = normalizeOptionalString(rawProviderId) ?? "";
    if (!providerId || isBlockedObjectKey(providerId) || !isRecord(rawMetadata)) {
      continue;
    }
    const metadata = normalizeCapabilityProviderMetadataEntry(rawMetadata);
    if (metadata) {
      normalized[providerId] = metadata;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizePluginToolMetadata(
  value: unknown,
): Record<string, PluginManifestToolMetadata> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestToolMetadata> = Object.create(null);
  for (const [rawToolName, rawMetadata] of Object.entries(value)) {
    const toolName = normalizeOptionalString(rawToolName) ?? "";
    if (!toolName || isBlockedObjectKey(toolName) || !isRecord(rawMetadata)) {
      continue;
    }
    const providerMetadata = normalizeCapabilityProviderMetadataEntry(rawMetadata);
    const metadata = {
      ...providerMetadata,
      ...(rawMetadata.optional === true ? { optional: true } : {}),
    } satisfies PluginManifestToolMetadata;
    if (Object.keys(metadata).length > 0) {
      normalized[toolName] = metadata;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeManifestContracts(value: unknown): PluginManifestContracts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const embeddedExtensionFactories = normalizeTrimmedStringList(value.embeddedExtensionFactories);
  const agentToolResultMiddleware = normalizeTrimmedStringList(value.agentToolResultMiddleware);
  const externalAuthProviders = normalizeTrimmedStringList(value.externalAuthProviders);
  const memoryEmbeddingProviders = normalizeTrimmedStringList(value.memoryEmbeddingProviders);
  const speechProviders = normalizeTrimmedStringList(value.speechProviders);
  const realtimeTranscriptionProviders = normalizeTrimmedStringList(
    value.realtimeTranscriptionProviders,
  );
  const realtimeVoiceProviders = normalizeTrimmedStringList(value.realtimeVoiceProviders);
  const mediaUnderstandingProviders = normalizeTrimmedStringList(value.mediaUnderstandingProviders);
  const documentExtractors = normalizeTrimmedStringList(value.documentExtractors);
  const imageGenerationProviders = normalizeTrimmedStringList(value.imageGenerationProviders);
  const videoGenerationProviders = normalizeTrimmedStringList(value.videoGenerationProviders);
  const musicGenerationProviders = normalizeTrimmedStringList(value.musicGenerationProviders);
  const webContentExtractors = normalizeTrimmedStringList(value.webContentExtractors);
  const webFetchProviders = normalizeTrimmedStringList(value.webFetchProviders);
  const webSearchProviders = normalizeTrimmedStringList(value.webSearchProviders);
  const migrationProviders = normalizeTrimmedStringList(value.migrationProviders);
  const tools = normalizeTrimmedStringList(value.tools);
  const contracts = {
    ...(embeddedExtensionFactories.length > 0 ? { embeddedExtensionFactories } : {}),
    ...(agentToolResultMiddleware.length > 0 ? { agentToolResultMiddleware } : {}),
    ...(externalAuthProviders.length > 0 ? { externalAuthProviders } : {}),
    ...(memoryEmbeddingProviders.length > 0 ? { memoryEmbeddingProviders } : {}),
    ...(speechProviders.length > 0 ? { speechProviders } : {}),
    ...(realtimeTranscriptionProviders.length > 0 ? { realtimeTranscriptionProviders } : {}),
    ...(realtimeVoiceProviders.length > 0 ? { realtimeVoiceProviders } : {}),
    ...(mediaUnderstandingProviders.length > 0 ? { mediaUnderstandingProviders } : {}),
    ...(documentExtractors.length > 0 ? { documentExtractors } : {}),
    ...(imageGenerationProviders.length > 0 ? { imageGenerationProviders } : {}),
    ...(videoGenerationProviders.length > 0 ? { videoGenerationProviders } : {}),
    ...(musicGenerationProviders.length > 0 ? { musicGenerationProviders } : {}),
    ...(webContentExtractors.length > 0 ? { webContentExtractors } : {}),
    ...(webFetchProviders.length > 0 ? { webFetchProviders } : {}),
    ...(webSearchProviders.length > 0 ? { webSearchProviders } : {}),
    ...(migrationProviders.length > 0 ? { migrationProviders } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  } satisfies PluginManifestContracts;

  return Object.keys(contracts).length > 0 ? contracts : undefined;
}

function isManifestConfigLiteral(value: unknown): value is PluginManifestConfigLiteral {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function normalizeManifestDangerousConfigFlags(
  value: unknown,
): PluginManifestDangerousConfigFlag[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestDangerousConfigFlag[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = normalizeOptionalString(entry.path) ?? "";
    if (!path || !isManifestConfigLiteral(entry.equals)) {
      continue;
    }
    normalized.push({ path, equals: entry.equals });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestSecretInputPaths(
  value: unknown,
): PluginManifestSecretInputPath[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestSecretInputPath[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const path = normalizeOptionalString(entry.path) ?? "";
    if (!path) {
      continue;
    }
    const expected = entry.expected === "string" ? entry.expected : undefined;
    normalized.push({
      path,
      ...(expected ? { expected } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestConfigContracts(
  value: unknown,
): PluginManifestConfigContracts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const compatibilityMigrationPaths = normalizeTrimmedStringList(value.compatibilityMigrationPaths);
  const compatibilityRuntimePaths = normalizeTrimmedStringList(value.compatibilityRuntimePaths);
  const rawSecretInputs = isRecord(value.secretInputs) ? value.secretInputs : undefined;
  const dangerousFlags = normalizeManifestDangerousConfigFlags(value.dangerousFlags);
  const secretInputPaths = rawSecretInputs
    ? normalizeManifestSecretInputPaths(rawSecretInputs.paths)
    : undefined;
  const secretInputs =
    secretInputPaths && secretInputPaths.length > 0
      ? ({
          ...(rawSecretInputs?.bundledDefaultEnabled === true
            ? { bundledDefaultEnabled: true }
            : rawSecretInputs?.bundledDefaultEnabled === false
              ? { bundledDefaultEnabled: false }
              : {}),
          paths: secretInputPaths,
        } satisfies PluginManifestSecretInputContracts)
      : undefined;
  const configContracts = {
    ...(compatibilityMigrationPaths.length > 0 ? { compatibilityMigrationPaths } : {}),
    ...(compatibilityRuntimePaths.length > 0 ? { compatibilityRuntimePaths } : {}),
    ...(dangerousFlags ? { dangerousFlags } : {}),
    ...(secretInputs ? { secretInputs } : {}),
  } satisfies PluginManifestConfigContracts;
  return Object.keys(configContracts).length > 0 ? configContracts : undefined;
}

function normalizeManifestModelSupport(value: unknown): PluginManifestModelSupport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const modelPrefixes = normalizeTrimmedStringList(value.modelPrefixes);
  const modelPatterns = normalizeTrimmedStringList(value.modelPatterns);
  const modelSupport = {
    ...(modelPrefixes.length > 0 ? { modelPrefixes } : {}),
    ...(modelPatterns.length > 0 ? { modelPatterns } : {}),
  } satisfies PluginManifestModelSupport;

  return Object.keys(modelSupport).length > 0 ? modelSupport : undefined;
}

function normalizeManifestModelPricingSource(
  value: unknown,
): PluginManifestModelPricingSource | false | undefined {
  if (value === false) {
    return false;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = normalizeModelCatalogProviderId(normalizeOptionalString(value.provider) ?? "");
  const modelIdTransforms = normalizeTrimmedStringList(value.modelIdTransforms).filter(
    (entry): entry is PluginManifestModelPricingModelIdTransform => entry === "version-dots",
  );
  const source = {
    ...(provider ? { provider } : {}),
    ...(value.passthroughProviderModel === true ? { passthroughProviderModel: true } : {}),
    ...(modelIdTransforms.length > 0 ? { modelIdTransforms } : {}),
  } satisfies PluginManifestModelPricingSource;
  return Object.keys(source).length > 0 ? source : undefined;
}

function normalizeManifestModelPricingProvider(
  value: unknown,
): PluginManifestModelPricingProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const openRouter = normalizeManifestModelPricingSource(value.openRouter);
  const liteLLM = normalizeManifestModelPricingSource(value.liteLLM);
  const policy = {
    ...(typeof value.external === "boolean" ? { external: value.external } : {}),
    ...(openRouter !== undefined ? { openRouter } : {}),
    ...(liteLLM !== undefined ? { liteLLM } : {}),
  } satisfies PluginManifestModelPricingProvider;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizeManifestModelPricing(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelPricing | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...params.ownedProviders]
      .map((provider) => normalizeModelCatalogProviderId(provider))
      .filter(Boolean),
  );
  const providers: Record<string, PluginManifestModelPricingProvider> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    if (!providerId || !ownedProviders.has(providerId)) {
      continue;
    }
    const policy = normalizeManifestModelPricingProvider(rawPolicy);
    if (policy) {
      providers[providerId] = policy;
    }
  }
  return Object.keys(providers).length > 0 ? { providers } : undefined;
}

function normalizeManifestModelIdPrefixRules(
  value: unknown,
): PluginManifestModelIdPrefixRule[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rules: PluginManifestModelIdPrefixRule[] = [];
  for (const rawRule of value) {
    if (!isRecord(rawRule)) {
      continue;
    }
    const modelPrefix = normalizeOptionalString(rawRule.modelPrefix);
    const prefix = normalizeOptionalString(rawRule.prefix);
    if (!modelPrefix || !prefix) {
      continue;
    }
    rules.push({ modelPrefix, prefix });
  }
  return rules.length > 0 ? rules : undefined;
}

function normalizeManifestModelIdNormalizationProvider(
  value: unknown,
): PluginManifestModelIdNormalizationProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const aliases: Record<string, string> = {};
  if (isRecord(value.aliases)) {
    for (const [rawAlias, rawCanonical] of Object.entries(value.aliases)) {
      const alias = normalizeModelCatalogProviderId(rawAlias);
      const canonical = normalizeOptionalString(rawCanonical);
      if (alias && canonical) {
        aliases[alias] = canonical;
      }
    }
  }
  const stripPrefixes = normalizeTrimmedStringList(value.stripPrefixes);
  const prefixWhenBare = normalizeOptionalString(value.prefixWhenBare);
  const prefixWhenBareAfterAliasStartsWith = normalizeManifestModelIdPrefixRules(
    value.prefixWhenBareAfterAliasStartsWith,
  );
  const normalization = {
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(stripPrefixes.length > 0 ? { stripPrefixes } : {}),
    ...(prefixWhenBare ? { prefixWhenBare } : {}),
    ...(prefixWhenBareAfterAliasStartsWith ? { prefixWhenBareAfterAliasStartsWith } : {}),
  } satisfies PluginManifestModelIdNormalizationProvider;

  return Object.keys(normalization).length > 0 ? normalization : undefined;
}

function normalizeManifestModelIdNormalization(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelIdNormalization | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...params.ownedProviders]
      .map((provider) => normalizeModelCatalogProviderId(provider))
      .filter(Boolean),
  );
  const providers: Record<string, PluginManifestModelIdNormalizationProvider> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    if (!providerId || !ownedProviders.has(providerId)) {
      continue;
    }
    const policy = normalizeManifestModelIdNormalizationProvider(rawPolicy);
    if (policy) {
      providers[providerId] = policy;
    }
  }
  return Object.keys(providers).length > 0 ? { providers } : undefined;
}

function normalizeManifestProviderEndpoints(
  value: unknown,
): PluginManifestProviderEndpoint[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const endpoints: PluginManifestProviderEndpoint[] = [];
  for (const rawEndpoint of value) {
    if (!isRecord(rawEndpoint)) {
      continue;
    }
    const endpointClass = normalizeOptionalString(rawEndpoint.endpointClass);
    if (!endpointClass) {
      continue;
    }
    const hosts = normalizeTrimmedStringList(rawEndpoint.hosts).map((host) => host.toLowerCase());
    const hostSuffixes = normalizeTrimmedStringList(rawEndpoint.hostSuffixes).map((host) =>
      host.toLowerCase(),
    );
    const baseUrls = normalizeTrimmedStringList(rawEndpoint.baseUrls);
    const googleVertexRegion = normalizeOptionalString(rawEndpoint.googleVertexRegion);
    const googleVertexRegionHostSuffix = normalizeOptionalString(
      rawEndpoint.googleVertexRegionHostSuffix,
    )?.toLowerCase();
    if (hosts.length === 0 && hostSuffixes.length === 0 && baseUrls.length === 0) {
      continue;
    }
    endpoints.push({
      endpointClass,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(hostSuffixes.length > 0 ? { hostSuffixes } : {}),
      ...(baseUrls.length > 0 ? { baseUrls } : {}),
      ...(googleVertexRegion ? { googleVertexRegion } : {}),
      ...(googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {}),
    });
  }

  return endpoints.length > 0 ? endpoints : undefined;
}

function normalizeManifestProviderRequestProvider(
  value: unknown,
): PluginManifestProviderRequestProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const family = normalizeOptionalString(value.family);
  const compatibilityFamily =
    normalizeOptionalString(value.compatibilityFamily) === "moonshot" ? "moonshot" : undefined;
  const supportsStreamingUsage = isRecord(value.openAICompletions)
    ? value.openAICompletions.supportsStreamingUsage
    : undefined;
  const openAICompletions =
    typeof supportsStreamingUsage === "boolean" ? { supportsStreamingUsage } : undefined;
  const providerRequest = {
    ...(family ? { family } : {}),
    ...(compatibilityFamily ? { compatibilityFamily } : {}),
    ...(openAICompletions && Object.keys(openAICompletions).length > 0
      ? { openAICompletions }
      : {}),
  } satisfies PluginManifestProviderRequestProvider;
  return Object.keys(providerRequest).length > 0 ? providerRequest : undefined;
}

function normalizeManifestProviderRequest(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestProviderRequest | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...params.ownedProviders]
      .map((provider) => normalizeModelCatalogProviderId(provider))
      .filter(Boolean),
  );
  const providers: Record<string, PluginManifestProviderRequestProvider> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    if (!providerId || !ownedProviders.has(providerId)) {
      continue;
    }
    const policy = normalizeManifestProviderRequestProvider(rawPolicy);
    if (policy) {
      providers[providerId] = policy;
    }
  }
  return Object.keys(providers).length > 0 ? { providers } : undefined;
}

function normalizeManifestActivation(value: unknown): PluginManifestActivation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const onProviders = normalizeTrimmedStringList(value.onProviders);
  const onAgentHarnesses = normalizeTrimmedStringList(value.onAgentHarnesses);
  const onCommands = normalizeTrimmedStringList(value.onCommands);
  const onChannels = normalizeTrimmedStringList(value.onChannels);
  const onRoutes = normalizeTrimmedStringList(value.onRoutes);
  const onConfigPaths = normalizeTrimmedStringList(value.onConfigPaths);
  const onStartup = typeof value.onStartup === "boolean" ? value.onStartup : undefined;
  const onCapabilities = normalizeTrimmedStringList(value.onCapabilities).filter(
    (capability): capability is PluginManifestActivationCapability =>
      capability === "provider" ||
      capability === "channel" ||
      capability === "tool" ||
      capability === "hook",
  );

  const activation = {
    ...(onStartup !== undefined ? { onStartup } : {}),
    ...(onProviders.length > 0 ? { onProviders } : {}),
    ...(onAgentHarnesses.length > 0 ? { onAgentHarnesses } : {}),
    ...(onCommands.length > 0 ? { onCommands } : {}),
    ...(onChannels.length > 0 ? { onChannels } : {}),
    ...(onRoutes.length > 0 ? { onRoutes } : {}),
    ...(onConfigPaths.length > 0 ? { onConfigPaths } : {}),
    ...(onCapabilities.length > 0 ? { onCapabilities } : {}),
  } satisfies PluginManifestActivation;

  return Object.keys(activation).length > 0 ? activation : undefined;
}

const MANIFEST_DEFAULT_ENABLEMENT_PLATFORMS = new Set<PluginManifestDefaultPlatform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

function normalizeManifestDefaultPlatforms(value: unknown): PluginManifestDefaultPlatform[] {
  return normalizeTrimmedStringList(value).filter(
    (platform): platform is PluginManifestDefaultPlatform =>
      MANIFEST_DEFAULT_ENABLEMENT_PLATFORMS.has(platform as PluginManifestDefaultPlatform),
  );
}

function normalizeManifestSetupProviders(
  value: unknown,
): PluginManifestSetupProvider[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestSetupProvider[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = normalizeOptionalString(entry.id) ?? "";
    if (!id) {
      continue;
    }
    const authMethods = normalizeTrimmedStringList(entry.authMethods);
    const envVars = normalizeTrimmedStringList(entry.envVars);
    const authEvidence = normalizeManifestSetupProviderAuthEvidence(entry.authEvidence);
    normalized.push({
      id,
      ...(authMethods.length > 0 ? { authMethods } : {}),
      ...(envVars.length > 0 ? { envVars } : {}),
      ...(authEvidence ? { authEvidence } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestSetupProviderAuthEvidence(
  value: unknown,
): PluginManifestSetupProviderAuthEvidence[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestSetupProviderAuthEvidence[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== "local-file-with-env") {
      continue;
    }
    const credentialMarker = normalizeOptionalString(entry.credentialMarker);
    if (!credentialMarker) {
      continue;
    }
    const fileEnvVar = normalizeOptionalString(entry.fileEnvVar);
    const fallbackPaths = normalizeTrimmedStringList(entry.fallbackPaths);
    if (!fileEnvVar && fallbackPaths.length === 0) {
      continue;
    }
    const requiresAnyEnv = normalizeTrimmedStringList(entry.requiresAnyEnv);
    const requiresAllEnv = normalizeTrimmedStringList(entry.requiresAllEnv);
    const source = normalizeOptionalString(entry.source);
    normalized.push({
      type: "local-file-with-env",
      ...(fileEnvVar ? { fileEnvVar } : {}),
      ...(fallbackPaths.length > 0 ? { fallbackPaths } : {}),
      ...(requiresAnyEnv.length > 0 ? { requiresAnyEnv } : {}),
      ...(requiresAllEnv.length > 0 ? { requiresAllEnv } : {}),
      credentialMarker,
      ...(source ? { source } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestSetup(value: unknown): PluginManifestSetup | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providers = normalizeManifestSetupProviders(value.providers);
  const cliBackends = normalizeTrimmedStringList(value.cliBackends);
  const configMigrations = normalizeTrimmedStringList(value.configMigrations);
  const requiresRuntime =
    typeof value.requiresRuntime === "boolean" ? value.requiresRuntime : undefined;
  const setup = {
    ...(providers ? { providers } : {}),
    ...(cliBackends.length > 0 ? { cliBackends } : {}),
    ...(configMigrations.length > 0 ? { configMigrations } : {}),
    ...(requiresRuntime !== undefined ? { requiresRuntime } : {}),
  } satisfies PluginManifestSetup;
  return Object.keys(setup).length > 0 ? setup : undefined;
}

function normalizeManifestQaRunners(value: unknown): PluginManifestQaRunner[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestQaRunner[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const commandName = normalizeOptionalString(entry.commandName) ?? "";
    if (!commandName) {
      continue;
    }
    const description = normalizeOptionalString(entry.description) ?? "";
    normalized.push({
      commandName,
      ...(description ? { description } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderAuthChoices(
  value: unknown,
): PluginManifestProviderAuthChoice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: PluginManifestProviderAuthChoice[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const provider = normalizeOptionalString(entry.provider) ?? "";
    const method = normalizeOptionalString(entry.method) ?? "";
    const choiceId = normalizeOptionalString(entry.choiceId) ?? "";
    if (!provider || !method || !choiceId) {
      continue;
    }
    const choiceLabel = normalizeOptionalString(entry.choiceLabel) ?? "";
    const choiceHint = normalizeOptionalString(entry.choiceHint) ?? "";
    const assistantPriority =
      typeof entry.assistantPriority === "number" && Number.isFinite(entry.assistantPriority)
        ? entry.assistantPriority
        : undefined;
    const assistantVisibility =
      entry.assistantVisibility === "manual-only" || entry.assistantVisibility === "visible"
        ? entry.assistantVisibility
        : undefined;
    const deprecatedChoiceIds = normalizeTrimmedStringList(entry.deprecatedChoiceIds);
    const groupId = normalizeOptionalString(entry.groupId) ?? "";
    const groupLabel = normalizeOptionalString(entry.groupLabel) ?? "";
    const groupHint = normalizeOptionalString(entry.groupHint) ?? "";
    const optionKey = normalizeOptionalString(entry.optionKey) ?? "";
    const cliFlag = normalizeOptionalString(entry.cliFlag) ?? "";
    const cliOption = normalizeOptionalString(entry.cliOption) ?? "";
    const cliDescription = normalizeOptionalString(entry.cliDescription) ?? "";
    const onboardingScopes = normalizeTrimmedStringList(entry.onboardingScopes).filter(
      (scope): scope is PluginManifestOnboardingScope =>
        scope === "text-inference" || scope === "image-generation",
    );
    normalized.push({
      provider,
      method,
      choiceId,
      ...(choiceLabel ? { choiceLabel } : {}),
      ...(choiceHint ? { choiceHint } : {}),
      ...(assistantPriority !== undefined ? { assistantPriority } : {}),
      ...(assistantVisibility ? { assistantVisibility } : {}),
      ...(deprecatedChoiceIds.length > 0 ? { deprecatedChoiceIds } : {}),
      ...(groupId ? { groupId } : {}),
      ...(groupLabel ? { groupLabel } : {}),
      ...(groupHint ? { groupHint } : {}),
      ...(optionKey ? { optionKey } : {}),
      ...(cliFlag ? { cliFlag } : {}),
      ...(cliOption ? { cliOption } : {}),
      ...(cliDescription ? { cliDescription } : {}),
      ...(onboardingScopes.length > 0 ? { onboardingScopes } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeChannelConfigs(
  value: unknown,
): Record<string, PluginManifestChannelConfig> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestChannelConfig> = Object.create(null);
  for (const [key, rawEntry] of Object.entries(value)) {
    const channelId = normalizeOptionalString(key) ?? "";
    if (!channelId || isBlockedObjectKey(channelId) || !isRecord(rawEntry)) {
      continue;
    }
    const schema = isRecord(rawEntry.schema) ? rawEntry.schema : null;
    if (!schema) {
      continue;
    }
    const uiHints = isRecord(rawEntry.uiHints)
      ? (rawEntry.uiHints as Record<string, PluginConfigUiHint>)
      : undefined;
    const runtime =
      isRecord(rawEntry.runtime) && typeof rawEntry.runtime.safeParse === "function"
        ? (rawEntry.runtime as ChannelConfigRuntimeSchema)
        : undefined;
    const label = normalizeOptionalString(rawEntry.label) ?? "";
    const description = normalizeOptionalString(rawEntry.description) ?? "";
    const preferOver = normalizeTrimmedStringList(rawEntry.preferOver);
    const commandDefaults = normalizeManifestChannelCommandDefaults(rawEntry.commands);
    normalized[channelId] = {
      schema,
      ...(uiHints ? { uiHints } : {}),
      ...(runtime ? { runtime } : {}),
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver.length > 0 ? { preferOver } : {}),
      ...(commandDefaults ? { commands: commandDefaults } : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeManifestChannelCommandDefaults(
  value: unknown,
): PluginManifestChannelCommandDefaults | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const nativeCommandsAutoEnabled =
    typeof value.nativeCommandsAutoEnabled === "boolean"
      ? value.nativeCommandsAutoEnabled
      : undefined;
  const nativeSkillsAutoEnabled =
    typeof value.nativeSkillsAutoEnabled === "boolean" ? value.nativeSkillsAutoEnabled : undefined;
  return nativeCommandsAutoEnabled !== undefined || nativeSkillsAutoEnabled !== undefined
    ? {
        ...(nativeCommandsAutoEnabled !== undefined ? { nativeCommandsAutoEnabled } : {}),
        ...(nativeSkillsAutoEnabled !== undefined ? { nativeSkillsAutoEnabled } : {}),
      }
    : undefined;
}

export function resolvePluginManifestPath(rootDir: string): string {
  for (const filename of PLUGIN_MANIFEST_FILENAMES) {
    const candidate = path.join(rootDir, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}

function buildPluginManifestLoadCacheKey(params: {
  manifestPath: string;
  rejectHardlinks: boolean;
  rootRealPath?: string;
  stats: fs.Stats;
}): string {
  return createPluginCacheKey([
    [
      path.resolve(params.manifestPath),
      params.rejectHardlinks,
      params.rootRealPath ?? "",
      params.stats.dev,
      params.stats.ino,
    ],
    params.stats.size,
    params.stats.mtimeMs,
    params.stats.ctimeMs,
  ]);
}

function getCachedPluginManifestLoadResult(
  key: string,
  stats: fs.Stats,
): PluginManifestLoadResult | undefined {
  const entry = pluginManifestLoadCache.get(key);
  if (
    !entry ||
    entry.size !== stats.size ||
    entry.mtimeMs !== stats.mtimeMs ||
    entry.ctimeMs !== stats.ctimeMs
  ) {
    return undefined;
  }
  return entry.result;
}

function setCachedPluginManifestLoadResult(
  key: string,
  stats: fs.Stats,
  result: PluginManifestLoadResult,
): void {
  pluginManifestLoadCache.set(key, {
    result,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  });
}

function parsePluginKind(raw: unknown): PluginKind | PluginKind[] | undefined {
  if (typeof raw === "string") {
    return raw as PluginKind;
  }
  if (Array.isArray(raw) && raw.length > 0 && raw.every((k) => typeof k === "string")) {
    return raw.length === 1 ? (raw[0] as PluginKind) : (raw as PluginKind[]);
  }
  return undefined;
}

export function loadPluginManifest(
  rootDir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PluginManifestLoadResult {
  const manifestPath = resolvePluginManifestPath(rootDir);
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: rootDir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    boundaryLabel: "plugin root",
    maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    rejectHardlinks,
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      path: () => ({
        ok: false,
        error: `plugin manifest not found: ${manifestPath}`,
        manifestPath,
      }),
      fallback: (failure) => ({
        ok: false,
        error: `unsafe plugin manifest path: ${manifestPath} (${failure.reason})`,
        manifestPath,
      }),
    });
  }
  const stats = opened.stat;
  const cacheKey = buildPluginManifestLoadCacheKey({
    manifestPath,
    rejectHardlinks,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    stats,
  });
  const cached = getCachedPluginManifestLoadResult(cacheKey, stats);
  if (cached) {
    fs.closeSync(opened.fd);
    return cached;
  }
  const cacheResult = (result: PluginManifestLoadResult): PluginManifestLoadResult => {
    setCachedPluginManifestLoadResult(cacheKey, stats, result);
    return result;
  };
  let raw: unknown;
  try {
    raw = parseJsonWithJson5Fallback(fs.readFileSync(opened.fd, "utf-8"));
  } catch (err) {
    return cacheResult({
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    });
  } finally {
    fs.closeSync(opened.fd);
  }
  if (!isRecord(raw)) {
    return cacheResult({ ok: false, error: "plugin manifest must be an object", manifestPath });
  }
  const id = normalizeOptionalString(raw.id) ?? "";
  if (!id) {
    return cacheResult({ ok: false, error: "plugin manifest requires id", manifestPath });
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return cacheResult({ ok: false, error: "plugin manifest requires configSchema", manifestPath });
  }

  const kind = parsePluginKind(raw.kind);
  const enabledByDefault = raw.enabledByDefault === true;
  const enabledByDefaultOnPlatforms = normalizeManifestDefaultPlatforms(
    raw.enabledByDefaultOnPlatforms,
  );
  const legacyPluginIds = normalizeTrimmedStringList(raw.legacyPluginIds);
  const autoEnableWhenConfiguredProviders = normalizeTrimmedStringList(
    raw.autoEnableWhenConfiguredProviders,
  );
  const name = normalizeOptionalString(raw.name);
  const description = normalizeOptionalString(raw.description);
  const version = normalizeOptionalString(raw.version);
  const channels = normalizeTrimmedStringList(raw.channels);
  const providers = normalizeTrimmedStringList(raw.providers);
  const providerDiscoveryEntry = normalizeOptionalString(raw.providerDiscoveryEntry);
  const modelSupport = normalizeManifestModelSupport(raw.modelSupport);
  const modelCatalog = normalizeModelCatalog(raw.modelCatalog, {
    ownedProviders: new Set(providers),
  });
  const modelPricing = normalizeManifestModelPricing(raw.modelPricing, {
    ownedProviders: new Set(providers),
  });
  const modelIdNormalization = normalizeManifestModelIdNormalization(raw.modelIdNormalization, {
    ownedProviders: new Set(providers),
  });
  const providerEndpoints = normalizeManifestProviderEndpoints(raw.providerEndpoints);
  const providerRequest = normalizeManifestProviderRequest(raw.providerRequest, {
    ownedProviders: new Set(providers),
  });
  const cliBackends = normalizeTrimmedStringList(raw.cliBackends);
  const syntheticAuthRefs = normalizeTrimmedStringList(raw.syntheticAuthRefs);
  const nonSecretAuthMarkers = normalizeTrimmedStringList(raw.nonSecretAuthMarkers);
  const commandAliases = normalizeManifestCommandAliases(raw.commandAliases);
  const providerAuthEnvVars = normalizeStringListRecord(raw.providerAuthEnvVars);
  const providerAuthAliases = normalizeStringRecord(raw.providerAuthAliases);
  const channelEnvVars = normalizeStringListRecord(raw.channelEnvVars);
  const providerAuthChoices = normalizeProviderAuthChoices(raw.providerAuthChoices);
  const activation = normalizeManifestActivation(raw.activation);
  const setup = normalizeManifestSetup(raw.setup);
  const qaRunners = normalizeManifestQaRunners(raw.qaRunners);
  const skills = normalizeTrimmedStringList(raw.skills);
  const contracts = normalizeManifestContracts(raw.contracts);
  const mediaUnderstandingProviderMetadata = normalizeMediaUnderstandingProviderMetadata(
    raw.mediaUnderstandingProviderMetadata,
  );
  const imageGenerationProviderMetadata = normalizeCapabilityProviderMetadata(
    raw.imageGenerationProviderMetadata,
  );
  const videoGenerationProviderMetadata = normalizeCapabilityProviderMetadata(
    raw.videoGenerationProviderMetadata,
  );
  const musicGenerationProviderMetadata = normalizeCapabilityProviderMetadata(
    raw.musicGenerationProviderMetadata,
  );
  const toolMetadata = normalizePluginToolMetadata(raw.toolMetadata);
  const configContracts = normalizeManifestConfigContracts(raw.configContracts);
  const channelConfigs = normalizeChannelConfigs(raw.channelConfigs);

  let uiHints: Record<string, PluginConfigUiHint> | undefined;
  if (isRecord(raw.uiHints)) {
    uiHints = raw.uiHints as Record<string, PluginConfigUiHint>;
  }

  return cacheResult({
    ok: true,
    manifest: {
      id,
      configSchema,
      ...(enabledByDefault ? { enabledByDefault } : {}),
      ...(enabledByDefaultOnPlatforms.length > 0 ? { enabledByDefaultOnPlatforms } : {}),
      ...(legacyPluginIds.length > 0 ? { legacyPluginIds } : {}),
      ...(autoEnableWhenConfiguredProviders.length > 0
        ? { autoEnableWhenConfiguredProviders }
        : {}),
      kind,
      channels,
      providers,
      providerDiscoveryEntry,
      modelSupport,
      modelCatalog,
      modelPricing,
      modelIdNormalization,
      providerEndpoints,
      providerRequest,
      cliBackends,
      syntheticAuthRefs,
      nonSecretAuthMarkers,
      commandAliases,
      providerAuthEnvVars,
      providerAuthAliases,
      channelEnvVars,
      providerAuthChoices,
      activation,
      setup,
      qaRunners,
      skills,
      name,
      description,
      version,
      uiHints,
      contracts,
      mediaUnderstandingProviderMetadata,
      imageGenerationProviderMetadata,
      videoGenerationProviderMetadata,
      musicGenerationProviderMetadata,
      toolMetadata,
      configContracts,
      channelConfigs,
    },
    manifestPath,
  });
}

// package.json "openclaw" metadata (used for setup/catalog)
export type PluginPackageChannel = {
  id?: string;
  label?: string;
  selectionLabel?: string;
  detailLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
  aliases?: readonly string[];
  preferOver?: readonly string[];
  systemImage?: string;
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: readonly string[];
  markdownCapable?: boolean;
  exposure?: {
    configured?: boolean;
    setup?: boolean;
    docs?: boolean;
  };
  showConfigured?: boolean;
  showInSetup?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
  commands?: PluginManifestChannelCommandDefaults;
  configuredState?: {
    specifier?: string;
    exportName?: string;
    env?: {
      allOf?: readonly string[];
      anyOf?: readonly string[];
    };
  };
  persistedAuthState?: {
    specifier?: string;
    exportName?: string;
  };
  doctorCapabilities?: PluginPackageChannelDoctorCapabilities;
  cliAddOptions?: readonly PluginPackageChannelCliOption[];
};

export type PluginPackageChannelDoctorCapabilities = {
  dmAllowFromMode?: "topOnly" | "topOrNested" | "nestedOnly";
  groupModel?: "sender" | "route" | "hybrid";
  groupAllowFromFallbackToAllowFrom?: boolean;
  warnOnEmptyGroupSenderAllowlist?: boolean;
};

export type PluginPackageChannelCliOption = {
  flags: string;
  description: string;
  defaultValue?: boolean | string;
};

export type PluginPackageInstall = {
  clawhubSpec?: string;
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "clawhub" | "npm" | "local";
  minHostVersion?: string;
  expectedIntegrity?: string;
  allowInvalidConfigRecovery?: boolean;
};

export type OpenClawPackageStartup = {
  /**
   * Opt-in for channel plugins whose `setupEntry` fully covers the gateway
   * startup surface needed before the server starts listening.
   */
  deferConfiguredChannelFullLoadUntilAfterListen?: boolean;
};

export type OpenClawPackageSetupFeatures = {
  configPromotion?: boolean;
  legacyStateMigrations?: boolean;
  legacySessionSurfaces?: boolean;
};

export type OpenClawPackageManifest = {
  extensions?: string[];
  runtimeExtensions?: string[];
  setupEntry?: string;
  runtimeSetupEntry?: string;
  setupFeatures?: OpenClawPackageSetupFeatures;
  plugin?: {
    id?: string;
    label?: string;
  };
  channel?: PluginPackageChannel;
  install?: PluginPackageInstall;
  startup?: OpenClawPackageStartup;
};

export const DEFAULT_PLUGIN_ENTRY_CANDIDATES = [
  "index.ts",
  "index.js",
  "index.mjs",
  "index.cjs",
] as const;

export type PackageExtensionResolution =
  | { status: "ok"; entries: string[] }
  | { status: "missing"; entries: [] }
  | { status: "empty"; entries: [] };

export type ManifestKey = typeof MANIFEST_KEY;

export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
} & Partial<Record<ManifestKey, OpenClawPackageManifest>>;

export function getPackageManifestMetadata(
  manifest: PackageManifest | undefined,
): OpenClawPackageManifest | undefined {
  if (!manifest) {
    return undefined;
  }
  return manifest[MANIFEST_KEY];
}

export function resolvePackageExtensionEntries(
  manifest: PackageManifest | undefined,
): PackageExtensionResolution {
  const raw = getPackageManifestMetadata(manifest)?.extensions;
  if (!Array.isArray(raw)) {
    return { status: "missing", entries: [] };
  }
  const entries = raw.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
  if (entries.length === 0) {
    return { status: "empty", entries: [] };
  }
  return { status: "ok", entries };
}

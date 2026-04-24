import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { ChannelConfigRuntimeSchema } from "../channels/plugins/types.config.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../shared/string-normalization.js";
import { isRecord } from "../utils.js";
import {
  normalizeManifestCommandAliases,
  type PluginManifestCommandAlias,
} from "./manifest-command-aliases.js";
import type { PluginConfigUiHint } from "./manifest-types.js";
import type { PluginKind } from "./plugin-kind.types.js";

export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;
export const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;

export type PluginManifestChannelConfig = {
  schema: JsonSchemaObject;
  uiHints?: Record<string, PluginConfigUiHint>;
  runtime?: ChannelConfigRuntimeSchema;
  label?: string;
  description?: string;
  preferOver?: string[];
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

export type PluginManifestProviderEndpoint = {
  /**
   * Core endpoint class this plugin-owned endpoint should map to. Core must
   * already know the class; manifests own host/baseUrl matching metadata.
   */
  endpointClass: string;
  /** Hostnames that should resolve to this endpoint class. */
  hosts?: string[];
  /** Exact normalized base URLs that should resolve to this endpoint class. */
  baseUrls?: string[];
};

export type PluginManifestActivationCapability = "provider" | "channel" | "tool" | "hook";

export type PluginManifestActivation = {
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
  /** Broad capability hints for activation/load plans. Prefer narrower ownership metadata. */
  onCapabilities?: PluginManifestActivationCapability[];
};

export type PluginManifestSetupProvider = {
  /** Provider id surfaced during setup/onboarding. */
  id: string;
  /** Setup/auth methods that this provider supports. */
  authMethods?: string[];
  /** Environment variables that can satisfy setup without runtime loading. */
  envVars?: string[];
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
  /** Cheap provider endpoint metadata used before provider runtime loads. */
  providerEndpoints?: PluginManifestProviderEndpoint[];
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
  /** Cheap provider-auth env lookup without booting plugin runtime. */
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
  /** Manifest-owned config behavior consumed by generic core helpers. */
  configContracts?: PluginManifestConfigContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
};

export type PluginManifestContracts = {
  embeddedExtensionFactories?: string[];
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
  imageGenerationProviders?: string[];
  videoGenerationProviders?: string[];
  musicGenerationProviders?: string[];
  webFetchProviders?: string[];
  webSearchProviders?: string[];
  tools?: string[];
};

export type PluginManifestMediaUnderstandingCapability = "image" | "audio" | "video";

export type PluginManifestMediaUnderstandingProviderMetadata = {
  capabilities?: PluginManifestMediaUnderstandingCapability[];
  defaultModels?: Partial<Record<PluginManifestMediaUnderstandingCapability, string>>;
  autoPriority?: Partial<Record<PluginManifestMediaUnderstandingCapability, number>>;
  nativeDocumentInputs?: Array<"pdf">;
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
  const normalized: Record<string, string[]> = {};
  for (const [key, rawValues] of Object.entries(value)) {
    const providerId = normalizeOptionalString(key) ?? "";
    if (!providerId) {
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
  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey) ?? "";
    const value = normalizeOptionalString(rawValue) ?? "";
    if (!key || !value) {
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
  const normalized: Record<string, PluginManifestMediaUnderstandingProviderMetadata> = {};
  for (const [rawProviderId, rawMetadata] of Object.entries(value)) {
    const providerId = normalizeOptionalString(rawProviderId) ?? "";
    if (!providerId || !isRecord(rawMetadata)) {
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

function normalizeManifestContracts(value: unknown): PluginManifestContracts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const embeddedExtensionFactories = normalizeTrimmedStringList(value.embeddedExtensionFactories);
  const externalAuthProviders = normalizeTrimmedStringList(value.externalAuthProviders);
  const memoryEmbeddingProviders = normalizeTrimmedStringList(value.memoryEmbeddingProviders);
  const speechProviders = normalizeTrimmedStringList(value.speechProviders);
  const realtimeTranscriptionProviders = normalizeTrimmedStringList(
    value.realtimeTranscriptionProviders,
  );
  const realtimeVoiceProviders = normalizeTrimmedStringList(value.realtimeVoiceProviders);
  const mediaUnderstandingProviders = normalizeTrimmedStringList(value.mediaUnderstandingProviders);
  const imageGenerationProviders = normalizeTrimmedStringList(value.imageGenerationProviders);
  const videoGenerationProviders = normalizeTrimmedStringList(value.videoGenerationProviders);
  const musicGenerationProviders = normalizeTrimmedStringList(value.musicGenerationProviders);
  const webFetchProviders = normalizeTrimmedStringList(value.webFetchProviders);
  const webSearchProviders = normalizeTrimmedStringList(value.webSearchProviders);
  const tools = normalizeTrimmedStringList(value.tools);
  const contracts = {
    ...(embeddedExtensionFactories.length > 0 ? { embeddedExtensionFactories } : {}),
    ...(externalAuthProviders.length > 0 ? { externalAuthProviders } : {}),
    ...(memoryEmbeddingProviders.length > 0 ? { memoryEmbeddingProviders } : {}),
    ...(speechProviders.length > 0 ? { speechProviders } : {}),
    ...(realtimeTranscriptionProviders.length > 0 ? { realtimeTranscriptionProviders } : {}),
    ...(realtimeVoiceProviders.length > 0 ? { realtimeVoiceProviders } : {}),
    ...(mediaUnderstandingProviders.length > 0 ? { mediaUnderstandingProviders } : {}),
    ...(imageGenerationProviders.length > 0 ? { imageGenerationProviders } : {}),
    ...(videoGenerationProviders.length > 0 ? { videoGenerationProviders } : {}),
    ...(musicGenerationProviders.length > 0 ? { musicGenerationProviders } : {}),
    ...(webFetchProviders.length > 0 ? { webFetchProviders } : {}),
    ...(webSearchProviders.length > 0 ? { webSearchProviders } : {}),
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
    const baseUrls = normalizeTrimmedStringList(rawEndpoint.baseUrls);
    if (hosts.length === 0 && baseUrls.length === 0) {
      continue;
    }
    endpoints.push({
      endpointClass,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(baseUrls.length > 0 ? { baseUrls } : {}),
    });
  }

  return endpoints.length > 0 ? endpoints : undefined;
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
  const onCapabilities = normalizeTrimmedStringList(value.onCapabilities).filter(
    (capability): capability is PluginManifestActivationCapability =>
      capability === "provider" ||
      capability === "channel" ||
      capability === "tool" ||
      capability === "hook",
  );

  const activation = {
    ...(onProviders.length > 0 ? { onProviders } : {}),
    ...(onAgentHarnesses.length > 0 ? { onAgentHarnesses } : {}),
    ...(onCommands.length > 0 ? { onCommands } : {}),
    ...(onChannels.length > 0 ? { onChannels } : {}),
    ...(onRoutes.length > 0 ? { onRoutes } : {}),
    ...(onCapabilities.length > 0 ? { onCapabilities } : {}),
  } satisfies PluginManifestActivation;

  return Object.keys(activation).length > 0 ? activation : undefined;
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
    normalized.push({
      id,
      ...(authMethods.length > 0 ? { authMethods } : {}),
      ...(envVars.length > 0 ? { envVars } : {}),
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
  const normalized: Record<string, PluginManifestChannelConfig> = {};
  for (const [key, rawEntry] of Object.entries(value)) {
    const channelId = normalizeOptionalString(key) ?? "";
    if (!channelId || !isRecord(rawEntry)) {
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
    normalized[channelId] = {
      schema,
      ...(uiHints ? { uiHints } : {}),
      ...(runtime ? { runtime } : {}),
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(preferOver.length > 0 ? { preferOver } : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
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
): PluginManifestLoadResult {
  const manifestPath = resolvePluginManifestPath(rootDir);
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: rootDir,
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
  let raw: unknown;
  try {
    raw = JSON5.parse(fs.readFileSync(opened.fd, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      error: `failed to parse plugin manifest: ${String(err)}`,
      manifestPath,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
  if (!isRecord(raw)) {
    return { ok: false, error: "plugin manifest must be an object", manifestPath };
  }
  const id = normalizeOptionalString(raw.id) ?? "";
  if (!id) {
    return { ok: false, error: "plugin manifest requires id", manifestPath };
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return { ok: false, error: "plugin manifest requires configSchema", manifestPath };
  }

  const kind = parsePluginKind(raw.kind);
  const enabledByDefault = raw.enabledByDefault === true;
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
  const providerEndpoints = normalizeManifestProviderEndpoints(raw.providerEndpoints);
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
  const configContracts = normalizeManifestConfigContracts(raw.configContracts);
  const channelConfigs = normalizeChannelConfigs(raw.channelConfigs);

  let uiHints: Record<string, PluginConfigUiHint> | undefined;
  if (isRecord(raw.uiHints)) {
    uiHints = raw.uiHints as Record<string, PluginConfigUiHint>;
  }

  return {
    ok: true,
    manifest: {
      id,
      configSchema,
      ...(enabledByDefault ? { enabledByDefault } : {}),
      ...(legacyPluginIds.length > 0 ? { legacyPluginIds } : {}),
      ...(autoEnableWhenConfiguredProviders.length > 0
        ? { autoEnableWhenConfiguredProviders }
        : {}),
      kind,
      channels,
      providers,
      providerDiscoveryEntry,
      modelSupport,
      providerEndpoints,
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
      configContracts,
      channelConfigs,
    },
    manifestPath,
  };
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
  configuredState?: {
    specifier?: string;
    exportName?: string;
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
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "npm" | "local";
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

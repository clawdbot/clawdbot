import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isRecord } from "../utils.js";
import type {
  PluginManifestCapabilityProviderAuthSignal,
  PluginManifestCapabilityProviderConfigSignal,
  PluginManifestCapabilityProviderMetadata,
  PluginManifestCapabilityProviderModeConfigSignal,
  PluginManifestCatalog,
  PluginManifestConfigContracts,
  PluginManifestConfigLiteral,
  PluginManifestContracts,
  PluginManifestDangerousConfigFlag,
  PluginManifestMcpServer,
  PluginManifestMediaUnderstandingCapability,
  PluginManifestMediaUnderstandingProviderMetadata,
  PluginManifestProviderBaseUrlGuard,
  PluginManifestSecretInputContracts,
  PluginManifestSecretInputPath,
  PluginManifestToolMetadata,
} from "./manifest-types.js";

export function normalizeStringListRecord(value: unknown): Record<string, string[]> | undefined {
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

export function normalizeManifestStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, string> = Object.create(null);
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeOptionalString(rawKey) ?? "";
    const valueLocal = normalizeOptionalString(rawValue) ?? "";
    if (!key || isBlockedObjectKey(key) || !valueLocal) {
      continue;
    }
    normalized[key] = valueLocal;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeManifestMcpServers(
  value: unknown,
): Record<string, PluginManifestMcpServer> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestMcpServer> = Object.create(null);
  for (const [rawName, rawServer] of Object.entries(value)) {
    const name = normalizeOptionalString(rawName) ?? "";
    if (!name || isBlockedObjectKey(name) || !isRecord(rawServer)) {
      continue;
    }
    normalized[name] = { ...rawServer };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeNamedMetadataRecord<T>(
  value: unknown,
  normalizeEntry: (entry: Record<string, unknown>) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, T> = Object.create(null);
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = normalizeOptionalString(rawId) ?? "";
    const entry =
      !id || isBlockedObjectKey(id) || !isRecord(rawEntry) ? undefined : normalizeEntry(rawEntry);
    if (entry) {
      normalized[id] = entry;
    }
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

function normalizeMediaUnderstandingDocumentModels(
  value: unknown,
): PluginManifestMediaUnderstandingProviderMetadata["documentModels"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pdfRaw = value.pdf;
  if (!isRecord(pdfRaw)) {
    return undefined;
  }
  const textExtraction = normalizeOptionalString(pdfRaw.textExtraction);
  const image: string | false | undefined =
    pdfRaw.image === false ? false : normalizeOptionalString(pdfRaw.image);
  const pdf = {
    ...(textExtraction ? { textExtraction } : {}),
    ...(image !== undefined ? { image } : {}),
  };
  return Object.keys(pdf).length > 0 ? { pdf } : undefined;
}

export function normalizeMediaUnderstandingProviderMetadata(
  value: unknown,
): Record<string, PluginManifestMediaUnderstandingProviderMetadata> | undefined {
  return normalizeNamedMetadataRecord(value, (rawMetadata) => {
    const capabilities = normalizeMediaUnderstandingCapabilities(rawMetadata.capabilities);
    const defaultModels = normalizeMediaUnderstandingCapabilityRecord(rawMetadata.defaultModels);
    const autoPriority = normalizeMediaUnderstandingPriorityRecord(rawMetadata.autoPriority);
    const nativeDocumentInputs = normalizeMediaUnderstandingNativeDocumentInputs(
      rawMetadata.nativeDocumentInputs,
    );
    const documentModels = normalizeMediaUnderstandingDocumentModels(rawMetadata.documentModels);
    const metadata = {
      ...(capabilities ? { capabilities } : {}),
      ...(defaultModels ? { defaultModels } : {}),
      ...(autoPriority ? { autoPriority } : {}),
      ...(nativeDocumentInputs ? { nativeDocumentInputs } : {}),
      ...(documentModels ? { documentModels } : {}),
    } satisfies PluginManifestMediaUnderstandingProviderMetadata;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  });
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
  const pathResult = normalizeOptionalString(value.path);
  const defaultValue = normalizeOptionalString(value.default);
  const allowed = normalizeTrimmedStringList(value.allowed);
  const disallowed = normalizeTrimmedStringList(value.disallowed);
  const signal = {
    ...(pathResult ? { path: pathResult } : {}),
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
    const overlayMapPath = normalizeOptionalString(rawSignal.overlayMapPath);
    const required = normalizeTrimmedStringList(rawSignal.required);
    const requiredAny = normalizeTrimmedStringList(rawSignal.requiredAny);
    const mode = normalizeCapabilityProviderModeConfigSignal(rawSignal.mode);
    const signal = {
      rootPath,
      ...(overlayPath ? { overlayPath } : {}),
      ...(overlayMapPath ? { overlayMapPath } : {}),
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
  const referenceAudioInputs = rawMetadata.referenceAudioInputs === true ? true : undefined;
  const metadata = {
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(authProviders.length > 0 ? { authProviders } : {}),
    ...(authSignals ? { authSignals } : {}),
    ...(configSignals ? { configSignals } : {}),
    ...(referenceAudioInputs ? { referenceAudioInputs } : {}),
  } satisfies PluginManifestCapabilityProviderMetadata;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function normalizeCapabilityProviderMetadata(
  value: unknown,
): Record<string, PluginManifestCapabilityProviderMetadata> | undefined {
  return normalizeNamedMetadataRecord(value, normalizeCapabilityProviderMetadataEntry);
}

export function normalizePluginToolMetadata(
  value: unknown,
): Record<string, PluginManifestToolMetadata> | undefined {
  return normalizeNamedMetadataRecord(value, (rawMetadata) => {
    const providerMetadata = normalizeCapabilityProviderMetadataEntry(rawMetadata);
    const metadata = {
      ...providerMetadata,
      ...(rawMetadata.optional === true ? { optional: true } : {}),
      ...(rawMetadata.replaySafe === true ? { replaySafe: true } : {}),
    } satisfies PluginManifestToolMetadata;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  });
}

export function normalizeManifestCatalog(value: unknown): PluginManifestCatalog | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const featured = typeof value.featured === "boolean" ? value.featured : undefined;
  const order =
    typeof value.order === "number" && Number.isFinite(value.order) ? value.order : undefined;
  if (featured === undefined && order === undefined) {
    return undefined;
  }
  return {
    ...(featured !== undefined ? { featured } : {}),
    ...(order !== undefined ? { order } : {}),
  };
}

const MANIFEST_CONTRACT_KEYS = [
  "embeddedExtensionFactories",
  "agentToolResultMiddleware",
  "trustedToolPolicies",
  "externalAuthProviders",
  "embeddingProviders",
  "memoryEmbeddingProviders",
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
  "mediaUnderstandingProviders",
  "transcriptSourceProviders",
  "documentExtractors",
  "imageGenerationProviders",
  "videoGenerationProviders",
  "musicGenerationProviders",
  "webContentExtractors",
  "webFetchProviders",
  "webSearchProviders",
  "workerProviders",
  "usageProviders",
  "migrationProviders",
  "gatewayMethodDispatch",
  "tools",
] as const satisfies readonly (keyof PluginManifestContracts)[];

export function normalizeManifestContracts(value: unknown): PluginManifestContracts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const contracts: PluginManifestContracts = {};
  for (const key of MANIFEST_CONTRACT_KEYS) {
    const entries = normalizeTrimmedStringList(value[key]);
    if (entries.length > 0) {
      contracts[key] = entries;
    }
  }
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
    const pathValue = normalizeOptionalString(entry.path) ?? "";
    if (!pathValue || !isManifestConfigLiteral(entry.equals)) {
      continue;
    }
    normalized.push({ path: pathValue, equals: entry.equals });
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
    const pathLocal = normalizeOptionalString(entry.path) ?? "";
    if (!pathLocal) {
      continue;
    }
    const expected = entry.expected === "string" ? entry.expected : undefined;
    const ownerKind = entry.ownerKind === "route" ? entry.ownerKind : undefined;
    normalized.push({
      path: pathLocal,
      ...(expected ? { expected } : {}),
      ...(ownerKind ? { ownerKind } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeManifestConfigContracts(
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

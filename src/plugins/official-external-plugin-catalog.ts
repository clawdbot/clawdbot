import { isRecord } from "@openclaw/normalization-core/record-coerce";
/** Reads official external plugin/channel/provider catalogs into manifest-like metadata. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { resolvePluginInstallSources, type PluginInstallSource } from "./install-channel-specs.js";
import { BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES } from "./official-external-plugin-bundled-catalogs.js";
import {
  DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG,
  getFeedEntryInstallCandidateRecords,
  getOfficialExternalPluginCatalogManifest,
  hasKnownCatalogSourceRef,
  resolveOfficialExternalPluginCatalogEntryKey,
  resolveOfficialExternalPluginCatalogProfileConfig,
  resolveOfficialExternalPluginId,
} from "./official-external-plugin-catalog-source.js";
import type {
  OfficialExternalChannelSecretContract,
  OfficialExternalPluginCatalogEntry,
  OfficialExternalPluginCatalogInstallCandidate,
  OfficialExternalPluginCatalogSourceProfile,
  OfficialExternalPluginCatalogProfileConfig,
  HostedOfficialExternalPluginCatalogLoadResult,
} from "./official-external-plugin-catalog.types.js";
import type { PluginPackageInstall } from "./package-manifest.types.js";
import { normalizePluginInstallDefaultChoice } from "./plugin-install-default-choice.js";

export type {
  OfficialExternalProviderAuthChoice,
  OfficialExternalWebSearchProvider,
  OfficialExternalPluginCatalogEntry,
  OfficialExternalPluginCatalogFeed,
  HostedOfficialExternalPluginCatalogMetadata,
  HostedOfficialExternalPluginCatalogSnapshot,
  HostedOfficialExternalPluginCatalogSnapshotStore,
  HostedOfficialExternalPluginCatalogTrustState,
  HostedOfficialExternalPluginCatalogSnapshotMonotonicState,
  HostedOfficialExternalPluginCatalogLoadResult,
} from "./official-external-plugin-catalog.types.js";

export {
  HostedCatalogSignedFeedMonotonicityError,
  isOfficialExternalPluginCatalogFeed,
  isOfficialExternalPluginCatalogSequence,
  parseOfficialExternalPluginCatalogTimestamp,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginId,
} from "./official-external-plugin-catalog-source.js";

type OfficialExternalProviderContract =
  | "embeddingProviders"
  | "mediaUnderstandingProviders"
  | "speechProviders"
  | "webFetchProviders";

function getFeedEntryInstallCandidates(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogInstallCandidate[] {
  const state = normalizeOptionalString(entry.state);
  if (state !== "available") {
    return [];
  }
  const publisherTrust = normalizeOptionalString(entry.publisher?.trust);
  if (publisherTrust !== "official") {
    return [];
  }
  return getFeedEntryInstallCandidateRecords(entry);
}

const BUNDLED_CATALOG_SOURCE_REFS = new Set(
  Object.keys(DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_PROFILE_CONFIG.sources ?? {}),
);

function* bundledOfficialExternalPluginCatalogEntries(): Generator<OfficialExternalPluginCatalogEntry> {
  const seen = new Set<string>();
  for (const entry of BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES) {
    const install = isRecord(entry.install) ? entry.install : undefined;
    const candidates = install?.candidates;
    if (
      Array.isArray(candidates) &&
      candidates.some((candidate) => {
        if (!isRecord(candidate)) {
          return false;
        }
        return !hasKnownCatalogSourceRef(candidate, BUNDLED_CATALOG_SOURCE_REFS);
      })
    ) {
      continue;
    }
    const key = resolveOfficialExternalPluginCatalogEntryKey(entry);
    if (key && !seen.has(key)) {
      seen.add(key);
      yield entry;
    }
  }
}

function findBundledOfficialExternalPluginCatalogEntry(
  matches: (entry: OfficialExternalPluginCatalogEntry) => boolean,
): OfficialExternalPluginCatalogEntry | undefined {
  for (const entry of bundledOfficialExternalPluginCatalogEntries()) {
    if (matches(entry)) {
      return entry;
    }
  }
  return undefined;
}

function formatFeedInstallCandidateSpec(
  candidate: OfficialExternalPluginCatalogInstallCandidate,
): string | undefined {
  const packageName = normalizeOptionalString(candidate.package);
  if (!packageName) {
    return undefined;
  }
  const version = normalizeOptionalString(candidate.version);
  if (!version || packageName.endsWith(`@${version}`)) {
    return packageName;
  }
  return `${packageName}@${version}`;
}

function getFeedEntryCandidateSourceType(
  candidate: OfficialExternalPluginCatalogInstallCandidate,
  config?: OfficialExternalPluginCatalogProfileConfig,
): OfficialExternalPluginCatalogSourceProfile["type"] | undefined {
  const sourceRef = normalizeOptionalString(candidate.sourceRef);
  if (!sourceRef) {
    return undefined;
  }
  return resolveOfficialExternalPluginCatalogProfileConfig(config).sources[sourceRef]?.type;
}

function resolveFeedEntryInstallSources(params: {
  entry: OfficialExternalPluginCatalogEntry;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
}): PluginInstallSource[] {
  const candidates = getFeedEntryInstallCandidates(params.entry);
  return (["npm", "clawhub"] as const).flatMap((source) => {
    const candidate = candidates.find(
      (entry) =>
        getFeedEntryCandidateSourceType(entry, params.catalogConfig) === source &&
        Boolean(normalizeOptionalString(entry.package)),
    );
    const spec = candidate && formatFeedInstallCandidateSpec(candidate);
    if (!candidate || !spec) {
      return [];
    }
    const expectedIntegrity =
      source === "npm"
        ? normalizeNpmExpectedIntegrity(candidate.integrity)
        : normalizeClawHubSha256ExpectedIntegrity(candidate.integrity);
    return [
      {
        source,
        spec: source === "clawhub" ? `clawhub:${spec}` : spec,
        ...(expectedIntegrity ? { expectedIntegrity } : {}),
      },
    ];
  });
}

function resolveFeedEntryInstallCandidate(params: {
  entry: OfficialExternalPluginCatalogEntry;
  catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
}): PluginPackageInstall | null {
  const source = resolveFeedEntryInstallSources(params)[0];
  return source
    ? {
        ...(source.source === "npm" ? { npmSpec: source.spec } : { clawhubSpec: source.spec }),
        defaultChoice: source.source,
        ...(source.expectedIntegrity ? { expectedIntegrity: source.expectedIntegrity } : {}),
      }
    : null;
}

/** Source-specific catalog pins stay attached to the artifact they authenticate. */
export function resolveOfficialExternalPluginInstallSources(
  entry: OfficialExternalPluginCatalogEntry,
  params?: {
    catalogConfig?: OfficialExternalPluginCatalogProfileConfig;
    resolvedInstall?: PluginPackageInstall | null;
  },
): PluginInstallSource[] {
  const install =
    params?.resolvedInstall === undefined
      ? resolveOfficialExternalPluginInstall(entry, params)
      : params.resolvedInstall;
  if (!install) {
    return [];
  }
  const candidates = resolveFeedEntryInstallSources({
    entry,
    catalogConfig: params?.catalogConfig,
  });
  return candidates.length > 0 ? candidates : resolvePluginInstallSources(install);
}

function normalizeClawHubSha256ExpectedIntegrity(value: unknown): string | undefined {
  const integrity = normalizeOptionalString(value);
  return integrity ? (normalizeClawHubSha256Integrity(integrity) ?? undefined) : undefined;
}

function normalizeNpmExpectedIntegrity(value: unknown): string | undefined {
  const integrity = normalizeOptionalString(value);
  if (!integrity || !/^[a-z0-9]+-[A-Za-z0-9+/=]+$/i.test(integrity)) {
    return undefined;
  }
  return integrity;
}

/** Returns manifest metadata from an official external catalog entry when present. */
/** Returns legacy plugin ids used only for trusted update migrations. */
export function resolveOfficialExternalPluginLegacyIds(
  entry: OfficialExternalPluginCatalogEntry,
): string[] {
  return uniqueStrings(
    (getOfficialExternalPluginCatalogManifest(entry)?.legacyPluginIds ?? [])
      .map((pluginId) => normalizeOptionalString(pluginId))
      .filter((pluginId): pluginId is string => Boolean(pluginId)),
  );
}

/** Returns former npm package names accepted only for trusted update migrations. */
export function resolveOfficialExternalPluginLegacyNpmPackageNames(
  entry: OfficialExternalPluginCatalogEntry,
): string[] {
  return uniqueStrings(
    (getOfficialExternalPluginCatalogManifest(entry)?.legacyNpmPackageNames ?? [])
      .map((packageName) => normalizeOptionalString(packageName))
      .filter((packageName): packageName is string => Boolean(packageName)),
  );
}

/** Returns the host-owned setup migration selected for an external channel cutover. */
export function resolveOfficialExternalChannelCompatibilityMigration(
  channelId: string,
): string | undefined {
  const entry = getOfficialExternalPluginCatalogEntry(channelId);
  return normalizeOptionalString(
    getOfficialExternalPluginCatalogManifest(entry ?? {})?.channelHostConfig
      ?.compatibilityMigration,
  );
}

export function resolveOfficialExternalPluginLookupIds(
  entry: OfficialExternalPluginCatalogEntry,
): string[] {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const lookupIds = [
    normalizeOptionalString(manifest?.plugin?.id),
    normalizeOptionalString(manifest?.channel?.id),
  ];
  for (const provider of manifest?.providers ?? []) {
    lookupIds.push(normalizeOptionalString(provider.id));
    for (const alias of provider.aliases ?? []) {
      lookupIds.push(normalizeOptionalString(alias));
    }
  }
  return uniqueStrings(lookupIds.filter((value): value is string => Boolean(value)));
}

export function resolveOfficialExternalPluginLabel(
  entry: OfficialExternalPluginCatalogEntry,
): string {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.label) ??
    normalizeOptionalString(manifest?.channel?.label) ??
    normalizeOptionalString(manifest?.providers?.[0]?.name) ??
    normalizeOptionalString(entry.title) ??
    normalizeOptionalString(entry.name) ??
    resolveOfficialExternalPluginId(entry) ??
    "plugin"
  );
}

export function resolveOfficialExternalPluginInstall(
  entry: OfficialExternalPluginCatalogEntry,
  params?: { catalogConfig?: OfficialExternalPluginCatalogProfileConfig },
): PluginPackageInstall | null {
  const state = normalizeOptionalString(entry.state);
  const publisherTrust = normalizeOptionalString(entry.publisher?.trust);
  // Legacy schema-v1 entries inherit the feed's trust. Hosted schema-v2 parsing strips install
  // authority from incomplete entries; also fail closed if an unversioned entry declares one field.
  if ((state || publisherTrust) && (state !== "available" || publisherTrust !== "official")) {
    return null;
  }
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const install = manifest?.install;
  const clawhubSpec = normalizeOptionalString(install?.clawhubSpec);
  const manifestNpmSpec = normalizeOptionalString(install?.npmSpec);
  const localPath = normalizeOptionalString(install?.localPath);
  const candidateInstall = resolveFeedEntryInstallCandidate({
    entry,
    catalogConfig: params?.catalogConfig,
  });
  if (candidateInstall) {
    return {
      ...candidateInstall,
      ...(install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
      ...(install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
    };
  }
  const hasFeedInstallCandidates = getFeedEntryInstallCandidateRecords(entry).length > 0;
  const npmSpec =
    manifestNpmSpec ??
    (hasFeedInstallCandidates || clawhubSpec ? undefined : normalizeOptionalString(entry.name));
  const defaultChoice =
    normalizePluginInstallDefaultChoice(install?.defaultChoice) ??
    (npmSpec ? "npm" : clawhubSpec ? "clawhub" : localPath ? "local" : undefined);
  if (!clawhubSpec && !npmSpec && !localPath) {
    return null;
  }
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
    ...(install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    ...(install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
  };
}

export async function loadConfiguredHostedOfficialExternalPluginCatalogEntries(
  params?: Parameters<
    typeof import("./official-external-plugin-catalog-hosted.js").loadHostedOfficialExternalPluginCatalogEntries
  >[0],
): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  const { loadHostedOfficialExternalPluginCatalogEntries } =
    await import("./official-external-plugin-catalog-hosted.js");
  return await loadHostedOfficialExternalPluginCatalogEntries(params);
}

export function listOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return [...bundledOfficialExternalPluginCatalogEntries()];
}

/** Returns whether an id is the canonical id of an official external plugin. */
export function isOfficialExternalPluginId(pluginId: string): boolean {
  const normalized = normalizeOptionalString(pluginId)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    findBundledOfficialExternalPluginCatalogEntry(
      (entry) => resolveOfficialExternalPluginId(entry)?.toLowerCase() === normalized,
    ) !== undefined
  );
}

/** Resolves official external plugin owners for configured capability provider ids. */
export function resolveOfficialExternalProviderContractPluginIds(params: {
  contract: OfficialExternalProviderContract;
  providerIds: ReadonlySet<string>;
}): string[] {
  const configuredProviderIds = new Set(
    [...params.providerIds]
      .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  if (configuredProviderIds.size === 0) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of bundledOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providerIds =
      getOfficialExternalPluginCatalogManifest(entry)?.contracts?.[params.contract];
    if (
      pluginId &&
      providerIds?.some((providerId) => {
        const normalized = normalizeOptionalString(providerId)?.toLowerCase();
        return normalized ? configuredProviderIds.has(normalized) : false;
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official web provider owners from matching documented environment credentials. */
export function resolveOfficialExternalWebProviderContractPluginIdsForEnv(params: {
  contract: OfficialExternalProviderContract;
  env: NodeJS.ProcessEnv;
}): string[] {
  const pluginIds = new Set<string>();
  for (const entry of bundledOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const contractProviderIds = new Set(
      (manifest?.contracts?.[params.contract] ?? [])
        .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
        .filter((providerId): providerId is string => Boolean(providerId)),
    );
    if (
      pluginId &&
      contractProviderIds.size > 0 &&
      manifest?.webSearchProviders?.some((provider) => {
        const providerId = normalizeOptionalString(provider.id)?.toLowerCase();
        return (
          providerId !== undefined &&
          contractProviderIds.has(providerId) &&
          provider.envVars?.some((envVar) => Boolean(params.env[envVar]?.trim()))
        );
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official external plugin owners for configured model provider ids. */
export function resolveOfficialExternalProviderPluginIds(params: {
  providerIds: ReadonlySet<string>;
}): string[] {
  const configuredProviderIds = new Set(
    [...params.providerIds]
      .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  if (configuredProviderIds.size === 0) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providers = getOfficialExternalPluginCatalogManifest(entry)?.providers;
    if (
      pluginId &&
      providers?.some((provider) =>
        [provider.id, ...(provider.aliases ?? [])].some((providerId) => {
          const normalized = normalizeOptionalString(providerId)?.toLowerCase();
          return normalized ? configuredProviderIds.has(normalized) : false;
        }),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official external provider owners with configured environment credentials. */
export function resolveOfficialExternalProviderPluginIdsForEnv(env: NodeJS.ProcessEnv): string[] {
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providers = getOfficialExternalPluginCatalogManifest(entry)?.providers;
    if (
      pluginId &&
      providers?.some((provider) =>
        provider.envVars?.some((envVar) => Boolean(env[envVar]?.trim())),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function listOfficialExternalChannelCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter((entry) =>
    Boolean(getOfficialExternalPluginCatalogManifest(entry)?.channel),
  );
}

export function listOfficialExternalChannelEnvVars(): Array<{
  channelId: string;
  envVars: readonly string[];
}> {
  return listOfficialExternalChannelCatalogEntries().flatMap((entry) => {
    const channel = getOfficialExternalPluginCatalogManifest(entry)?.channel;
    const channelId = normalizeOptionalString(channel?.id)?.toLowerCase();
    const envVars = uniqueStrings(
      [
        ...(channel?.envVars ?? []),
        ...(channel?.configuredState?.env?.allOf ?? []),
        ...(channel?.configuredState?.env?.anyOf ?? []),
      ]
        .map((envVar) => normalizeOptionalString(envVar))
        .filter((envVar): envVar is string => Boolean(envVar)),
    );
    return channelId && envVars.length > 0 ? [{ channelId, envVars }] : [];
  });
}

const CHANNEL_SECRET_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;
const CHANNEL_SECRET_ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Returns a validated host fallback secret contract for one external channel. */
export function getOfficialExternalChannelSecretContract(
  channelId: string,
): OfficialExternalChannelSecretContract | undefined {
  const normalizedChannelId = normalizeOptionalString(channelId)?.toLowerCase();
  if (!normalizedChannelId) {
    return undefined;
  }
  const entry = listOfficialExternalChannelCatalogEntries().find((candidate) => {
    const id = normalizeOptionalString(
      getOfficialExternalPluginCatalogManifest(candidate)?.channel?.id,
    )?.toLowerCase();
    return id === normalizedChannelId;
  });
  const fields = getOfficialExternalPluginCatalogManifest(entry ?? {})?.channelSecrets?.fields;
  if (!fields) {
    return undefined;
  }
  const normalizedFields = fields.flatMap((field) => {
    const fieldName = normalizeOptionalString(field.field);
    const activationField = normalizeOptionalString(field.activationField);
    const activationEnv = normalizeOptionalString(field.activationEnv);
    if (
      !fieldName ||
      !CHANNEL_SECRET_FIELD_PATTERN.test(fieldName) ||
      (activationField !== undefined && !CHANNEL_SECRET_FIELD_PATTERN.test(activationField)) ||
      (activationEnv !== undefined && !CHANNEL_SECRET_ENV_PATTERN.test(activationEnv))
    ) {
      return [];
    }
    return [
      {
        field: fieldName,
        ...(activationField ? { activationField } : {}),
        ...(activationEnv ? { activationEnv } : {}),
      },
    ];
  });
  return normalizedFields.length > 0
    ? { channelId: normalizedChannelId, fields: normalizedFields }
    : undefined;
}

/** Returns trusted host validation clauses for one official external channel. */
export function getOfficialExternalChannelHostSchemaAllOf(
  channelId: string,
): readonly Record<string, unknown>[] {
  const normalizedChannelId = normalizeOptionalString(channelId)?.toLowerCase();
  if (!normalizedChannelId) {
    return [];
  }
  const entry = listOfficialExternalChannelCatalogEntries().find((candidate) => {
    const id = normalizeOptionalString(
      getOfficialExternalPluginCatalogManifest(candidate)?.channel?.id,
    )?.toLowerCase();
    return id === normalizedChannelId;
  });
  const clauses = getOfficialExternalPluginCatalogManifest(entry ?? {})?.channelHostConfig
    ?.schemaAllOf;
  return Array.isArray(clauses) ? clauses.filter(isRecord) : [];
}

export function listOfficialExternalProviderCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter(
    (entry) => (getOfficialExternalPluginCatalogManifest(entry)?.providers?.length ?? 0) > 0,
  );
}

export function getOfficialExternalPluginCatalogEntry(
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = pluginId.trim();
  if (!normalized) {
    return undefined;
  }
  return findBundledOfficialExternalPluginCatalogEntry((entry) =>
    resolveOfficialExternalPluginLookupIds(entry).includes(normalized),
  );
}

export function getOfficialExternalPluginCatalogEntryForPackage(
  packageName: string | undefined,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = packageName?.trim();
  if (!normalized) {
    return undefined;
  }
  return findBundledOfficialExternalPluginCatalogEntry(
    (entry) => normalizeOptionalString(entry.name) === normalized,
  );
}

/** Source discovery alone does not make an external package part of the core distribution. */
export function isExternallyDistributedPlugin(plugin: {
  pluginId: string;
  packageName?: string;
  packageBuild?: { bundledDist?: boolean };
}): boolean {
  const entry = getOfficialExternalPluginCatalogEntryForPackage(plugin.packageName);
  return (
    plugin.packageBuild?.bundledDist === false ||
    (entry !== undefined && resolveOfficialExternalPluginId(entry) === plugin.pluginId)
  );
}

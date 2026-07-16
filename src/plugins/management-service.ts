// Structured plugin catalog and lifecycle operations shared by Gateway-facing surfaces.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { collectChangedPaths } from "../config/io.write-prepare.js";
import { resolveIsNixMode } from "../config/paths.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createAsyncLock } from "../infra/json-files.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { RuntimeEnv } from "../runtime.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { installPluginFromNpmSpec } from "./install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields } from "./installs.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
  type HostedOfficialExternalPluginCatalogLoadResult,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
} from "./uninstall.js";

type ManagedPluginCatalogEntry = {
  id: string;
  name: string;
  packageName?: string;
  description?: string;
  version?: string;
  kind?: string[];
  origin?: string;
  installed: boolean;
  enabled: boolean;
  state: "enabled" | "disabled" | "not-installed" | "error";
  featured?: boolean;
  order?: number;
  install?: { source: "clawhub"; packageName: string } | { source: "official"; pluginId: string };
  error?: string;
  category?: string;
  removable?: boolean;
};

type ManagedPluginCatalog = {
  plugins: ManagedPluginCatalogEntry[];
  diagnostics: unknown[];
  mutationAllowed: boolean;
};

type ManagedPluginInstallRequest =
  | {
      source: "clawhub";
      packageName: string;
      version?: string;
      acknowledgeClawHubRisk?: boolean;
    }
  | { source: "official"; pluginId: string };

export class ManagedPluginLifecycleError extends Error {
  readonly kind: "invalid-request" | "unavailable";
  readonly code?: string;
  readonly version?: string;
  readonly warning?: string;

  constructor(
    message: string,
    details?: {
      kind?: "invalid-request" | "unavailable";
      code?: string;
      version?: string;
      warning?: string;
      cause?: unknown;
    },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ManagedPluginLifecycleError";
    this.kind = details?.kind ?? "invalid-request";
    this.code = details?.code;
    this.version = details?.version;
    this.warning = details?.warning;
  }
}

type OfficialCatalogResult = Pick<HostedOfficialExternalPluginCatalogLoadResult, "entries"> & {
  error?: string;
};

let officialCatalogCache:
  | { key: string; result: Promise<HostedOfficialExternalPluginCatalogLoadResult> }
  | undefined;

function officialCatalogCacheKey(config: OpenClawConfig): string {
  return JSON.stringify(config.marketplaces ?? null);
}

/** Clear the process-stable hosted catalog snapshot after an explicit owner reload. */
export function clearManagedPluginOfficialCatalogCache(): void {
  officialCatalogCache = undefined;
}

function mergeCatalogMetadata(
  hosted: OfficialExternalPluginCatalogEntry,
  bundled: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogEntry {
  const hostedManifest = getOfficialExternalPluginCatalogManifest(hosted);
  const bundledManifest = getOfficialExternalPluginCatalogManifest(bundled);
  const bundledCatalog = bundledManifest?.catalog;
  const bundledPlugin = bundledManifest?.plugin;
  const bundledName = normalizeOptionalString(bundled.name);
  const bundledDescription = normalizeOptionalString(bundled.description);
  const bundledKind = normalizeOptionalString(bundled.kind);
  const bundledSource = normalizeOptionalString(bundled.source);
  if (!bundledCatalog && !bundledPlugin) {
    return hosted;
  }
  return {
    ...hosted,
    ...(!normalizeOptionalString(hosted.name) && bundledName ? { name: bundledName } : {}),
    ...(!normalizeOptionalString(hosted.description) && bundledDescription
      ? { description: bundledDescription }
      : {}),
    ...(!normalizeOptionalString(hosted.kind) && bundledKind ? { kind: bundledKind } : {}),
    ...(!normalizeOptionalString(hosted.source) && bundledSource ? { source: bundledSource } : {}),
    [MANIFEST_KEY]: {
      ...hostedManifest,
      ...(bundledPlugin ? { plugin: { ...hostedManifest?.plugin, ...bundledPlugin } } : {}),
      ...(bundledCatalog ? { catalog: { ...hostedManifest?.catalog, ...bundledCatalog } } : {}),
    },
  };
}

function resolveCatalogPackageSourceIdentities(
  entry: OfficialExternalPluginCatalogEntry,
): Set<string> {
  const install = resolveOfficialExternalPluginInstall(entry);
  const clawhubPackage = install?.clawhubSpec
    ? parseClawHubPluginSpec(install.clawhubSpec)?.name
    : undefined;
  const npmPackage = install?.npmSpec ? parseRegistryNpmSpec(install.npmSpec)?.name : undefined;
  return new Set([
    ...(clawhubPackage ? [`clawhub:${clawhubPackage}`] : []),
    ...(npmPackage ? [`npm:${npmPackage}`] : []),
  ]);
}

function matchesBundledCatalogIdentity(params: {
  hosted: OfficialExternalPluginCatalogEntry;
  bundled: OfficialExternalPluginCatalogEntry;
}): boolean {
  const hostedSources = resolveCatalogPackageSourceIdentities(params.hosted);
  const bundledSources = resolveCatalogPackageSourceIdentities(params.bundled);
  return [...hostedSources].some((identity) => bundledSources.has(identity));
}

/** Overlay local runtime identity and editorial hints after an exact package/source match. */
function overlayBundledOfficialPluginCatalogMetadata(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  bundledEntries: readonly OfficialExternalPluginCatalogEntry[] = listOfficialExternalPluginCatalogEntries(),
): OfficialExternalPluginCatalogEntry[] {
  return entries.map((entry) => {
    const matches = bundledEntries.filter((bundled) =>
      matchesBundledCatalogIdentity({ hosted: entry, bundled }),
    );
    const bundled = matches.length === 1 ? matches[0] : undefined;
    return bundled ? mergeCatalogMetadata(entry, bundled) : entry;
  });
}

async function loadOfficialCatalog(config: OpenClawConfig): Promise<OfficialCatalogResult> {
  const key = officialCatalogCacheKey(config);
  if (officialCatalogCache?.key !== key) {
    officialCatalogCache = {
      key,
      result: loadConfiguredHostedOfficialExternalPluginCatalogEntries(config),
    };
  }
  const result = await officialCatalogCache.result;
  return {
    entries: overlayBundledOfficialPluginCatalogMetadata(result.entries),
    ...("error" in result ? { error: result.error } : {}),
  };
}

function normalizeKinds(kind: string | readonly string[] | undefined): string[] | undefined {
  const values = (typeof kind === "string" ? [kind] : (kind ?? []))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeCatalogMetadata(
  value: unknown,
): { featured?: boolean; order?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const featured = typeof record.featured === "boolean" ? record.featured : undefined;
  const order =
    typeof record.order === "number" && Number.isFinite(record.order) ? record.order : undefined;
  return featured === undefined && order === undefined
    ? undefined
    : {
        ...(featured !== undefined ? { featured } : {}),
        ...(order !== undefined ? { order } : {}),
      };
}

function resolveCatalogInstallAction(params: {
  config: OpenClawConfig;
  entry: OfficialExternalPluginCatalogEntry;
  pluginId: string;
}): ManagedPluginCatalogEntry["install"] {
  const install = resolveOfficialExternalPluginInstall(params.entry, {
    catalogConfig: params.config.marketplaces,
  });
  const clawhub = install?.clawhubSpec ? parseClawHubPluginSpec(install.clawhubSpec) : undefined;
  if (clawhub && !clawhub.version) {
    return { source: "clawhub", packageName: clawhub.name };
  }
  return install ? { source: "official", pluginId: params.pluginId } : undefined;
}

/** Coarse manifest-derived grouping so catalog UIs can shelve a large inventory. */
function derivePluginCategory(manifest: PluginManifestRecord | undefined): string | undefined {
  if (!manifest) {
    return undefined;
  }
  if (manifest.channels.length > 0 || Object.keys(manifest.channelConfigs ?? {}).length > 0) {
    return "channel";
  }
  const mediaProvider =
    Object.keys(manifest.imageGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.videoGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.musicGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.mediaUnderstandingProviderMetadata ?? {}).length > 0;
  if (
    manifest.providers.length > 0 ||
    manifest.providerEndpoints?.length ||
    manifest.modelCatalog ||
    mediaProvider
  ) {
    return "provider";
  }
  const kinds = normalizeKinds(manifest.kind);
  if (kinds?.includes("memory")) {
    return "memory";
  }
  if (kinds?.includes("context-engine")) {
    return "context-engine";
  }
  if (
    manifest.contracts?.tools?.length ||
    Object.keys(manifest.toolMetadata ?? {}).length > 0 ||
    manifest.skills.length > 0
  ) {
    return "tool";
  }
  return undefined;
}

function firstPluginError(
  diagnostics: readonly PluginDiagnostic[],
  pluginId: string,
): string | undefined {
  return diagnostics.find(
    (diagnostic) => diagnostic.level === "error" && diagnostic.pluginId === pluginId,
  )?.message;
}

function compareCatalogEntries(
  left: ManagedPluginCatalogEntry,
  right: ManagedPluginCatalogEntry,
): number {
  const featured = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
  if (featured !== 0) {
    return featured;
  }
  const order = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
  return order !== 0 ? order : left.name.localeCompare(right.name);
}

/** Build cold installed state merged with the hosted official catalog and bundled curation. */
export async function listManagedPlugins(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  officialCatalog?: OfficialCatalogResult;
}): Promise<ManagedPluginCatalog> {
  const env = params.env ?? process.env;
  const metadata = loadPluginMetadataSnapshot({ config: params.config, env });
  const officialCatalog = params.officialCatalog ?? (await loadOfficialCatalog(params.config));
  const plugins = metadata.index.plugins.map((record): ManagedPluginCatalogEntry => {
    const manifest = metadata.byPluginId.get(record.pluginId);
    const catalog = normalizeCatalogMetadata(manifest?.catalog);
    const error = firstPluginError(metadata.diagnostics, record.pluginId);
    const kind = normalizeKinds(manifest?.kind);
    const category = derivePluginCategory(manifest);
    // Only externally installed plugins (tracked install record, non-bundled) can be removed.
    const removable =
      record.origin !== "bundled" && Boolean(metadata.index.installRecords[record.pluginId]);
    // Prefer human labels over package specifiers: the registry backfills a
    // missing manifest name with the npm package name, which is an install
    // spec rather than a display name.
    const manifestName =
      manifest?.name && manifest.name !== record.packageName ? manifest.name : undefined;
    const name = manifestName ?? manifest?.channelCatalogMeta?.label ?? record.pluginId;
    const description =
      manifest?.description ?? manifest?.channelCatalogMeta?.blurb ?? manifest?.packageDescription;
    return {
      id: record.pluginId,
      name,
      ...(record.packageName ? { packageName: record.packageName } : {}),
      ...(description ? { description } : {}),
      ...(record.packageVersion || manifest?.version
        ? { version: record.packageVersion ?? manifest?.version }
        : {}),
      ...(kind ? { kind } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      installed: true,
      enabled: record.enabled,
      state: error ? "error" : record.enabled ? "enabled" : "disabled",
      ...(catalog?.featured !== undefined ? { featured: catalog.featured } : {}),
      ...(catalog?.order !== undefined ? { order: catalog.order } : {}),
      ...(error ? { error } : {}),
      ...(category ? { category } : {}),
      removable,
    };
  });
  const installedIds = new Set(plugins.map((plugin) => plugin.id));
  const installedPackageNames = new Set(
    plugins.flatMap((plugin) => (plugin.packageName ? [plugin.packageName] : [])),
  );
  // Hosted rows without a declared runtime id fall back to their package name,
  // so id matching alone would keep them visible after a successful install.
  const entryPackageInstalled = (entry: OfficialExternalPluginCatalogEntry) =>
    [...resolveCatalogPackageSourceIdentities(entry)].some((identity) =>
      installedPackageNames.has(identity.slice(identity.indexOf(":") + 1)),
    );
  for (const entry of officialCatalog.entries) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const catalog = normalizeCatalogMetadata(manifest?.catalog);
    if (!pluginId || !catalog || installedIds.has(pluginId) || entryPackageInstalled(entry)) {
      continue;
    }
    const kind = normalizeKinds(entry.kind);
    const install = resolveCatalogInstallAction({ config: params.config, entry, pluginId });
    const description = normalizeOptionalString(entry.description);
    const version = normalizeOptionalString(entry.version);
    plugins.push({
      id: pluginId,
      name: resolveOfficialExternalPluginLabel(entry),
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(kind ? { kind } : {}),
      origin: "official",
      installed: false,
      enabled: false,
      state: "not-installed",
      ...(catalog.featured !== undefined ? { featured: catalog.featured } : {}),
      ...(catalog.order !== undefined ? { order: catalog.order } : {}),
      ...(install ? { install } : {}),
    });
  }
  const diagnostics: unknown[] = [...metadata.diagnostics];
  if (officialCatalog.error) {
    diagnostics.push({
      level: "warn",
      message: `Official plugin catalog fallback: ${officialCatalog.error}`,
    });
  }
  return {
    plugins: plugins.toSorted(compareCatalogEntries),
    diagnostics,
    mutationAllowed: !resolveIsNixMode(env),
  };
}

const withManagedPluginMutationLock = createAsyncLock();

function assertValidConfigSnapshot(
  prepared: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
): ConfigSnapshotForInstallPersist {
  const { snapshot, writeOptions } = prepared;
  if (!snapshot.valid) {
    throw new ManagedPluginLifecycleError(
      "Config invalid; run `openclaw doctor --fix` before managing plugins.",
    );
  }
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  const { pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed: (snapshot.parsed ?? {}) as Record<string, unknown>,
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  if (pluginMutation.mode === "blocked") {
    throw new ManagedPluginLifecycleError(pluginMutation.reason);
  }
  return {
    config: snapshot.sourceConfig,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
  };
}

async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
  return assertValidConfigSnapshot(await readConfigFileSnapshotForWrite());
}

function createSilentRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new ManagedPluginLifecycleError(`plugin lifecycle exited with code ${code}`);
    },
  };
}

function createInstallLogger(warnings: string[]) {
  return {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
  };
}

function resolveOfficialEntryById(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => resolveOfficialExternalPluginId(entry) === pluginId);
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  config: OpenClawConfig,
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  return [...listOfficialExternalPluginCatalogEntries(), ...entries].find((entry) => {
    const install = resolveOfficialExternalPluginInstall(entry, {
      catalogConfig: config.marketplaces,
    });
    return parseClawHubPluginSpec(install?.clawhubSpec ?? "")?.name === packageName;
  });
}

function resolveHostedOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  config: OpenClawConfig,
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => {
    const install = resolveOfficialExternalPluginInstall(entry, {
      catalogConfig: config.marketplaces,
    });
    return parseClawHubPluginSpec(install?.clawhubSpec ?? "")?.name === packageName;
  });
}

function buildClawHubSpec(packageName: string, version?: string): string {
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return `clawhub:${packageName}${version ? `@${version}` : ""}`;
}

function throwInstallFailure(result: {
  error: string;
  code?: string;
  version?: string;
  warning?: string;
}): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    kind: unavailable ? "unavailable" : "invalid-request",
    code: result.code,
    version: result.version,
    warning: result.warning,
    cause: result,
  });
}

function installRecordOwnsTarget(
  record: PluginInstallRecord | undefined,
  targetDir: string,
): boolean {
  return Boolean(
    record?.installPath && path.resolve(record.installPath) === path.resolve(targetDir),
  );
}

async function cleanupFailedManagedPluginInstall(params: {
  pluginId: string;
  install: PluginInstallRecord;
  targetDir: string;
  extensionsDir: string;
}): Promise<string[]> {
  let installRecords: Record<string, PluginInstallRecord>;
  try {
    installRecords = await loadInstalledPluginIndexInstallRecords();
  } catch (error) {
    return [
      `Could not verify whether the failed plugin install was committed; retained ${params.targetDir}: ${formatErrorMessage(error)}`,
    ];
  }
  if (installRecordOwnsTarget(installRecords[params.pluginId], params.targetDir)) {
    return [
      `Plugin install persistence reported an error after ${params.targetDir} was recorded; retained the managed target.`,
    ];
  }

  const plan = planPluginUninstall({
    config: {
      plugins: { installs: { [params.pluginId]: params.install } },
    },
    pluginId: params.pluginId,
    deleteFiles: true,
    extensionsDir: params.extensionsDir,
  });
  if (!plan.ok) {
    return [`Could not plan cleanup for failed plugin install: ${plan.error}`];
  }
  if (!plan.directoryRemoval) {
    return [
      `Could not resolve a managed cleanup target for failed plugin install ${params.pluginId}.`,
    ];
  }
  if (path.resolve(plan.directoryRemoval.target) !== path.resolve(params.targetDir)) {
    return [
      `Refused cleanup for failed plugin install ${params.pluginId}: planned target does not match the newly installed target.`,
    ];
  }
  try {
    const cleanup = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    return cleanup.warnings;
  } catch (error) {
    return [
      `Failed to remove the newly installed target after plugin persistence failed: ${formatErrorMessage(error)}`,
    ];
  }
}

function throwPersistenceFailureWithCleanupWarnings(error: unknown, warnings: string[]): never {
  if (warnings.length === 0) {
    throw error;
  }
  const cleanupWarning = [...new Set(warnings)].join("\n");
  if (error instanceof ManagedPluginLifecycleError) {
    throw new ManagedPluginLifecycleError(error.message, {
      kind: error.kind,
      code: error.code,
      version: error.version,
      warning: [error.warning, cleanupWarning].filter(Boolean).join("\n"),
      cause: error,
    });
  }
  throw new ManagedPluginLifecycleError(formatErrorMessage(error), {
    kind: "unavailable",
    warning: cleanupWarning,
    cause: error,
  });
}

async function persistManagedPluginInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: PluginInstallRecord;
  targetDir: string;
  extensionsDir: string;
}): Promise<OpenClawConfig> {
  try {
    return await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: params.pluginId,
      install: params.install,
      invalidateRuntimeCache: false,
      runtime: createSilentRuntime(),
    });
  } catch (error) {
    const cleanupWarnings = await cleanupFailedManagedPluginInstall({
      pluginId: params.pluginId,
      install: params.install,
      targetDir: params.targetDir,
      extensionsDir: params.extensionsDir,
    });
    return throwPersistenceFailureWithCleanupWarnings(error, cleanupWarnings);
  }
}

async function installFromClawHub(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  snapshot: ConfigSnapshotForInstallPersist;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
  expectedIntegrity?: string;
}): Promise<{ pluginId: string; config: OpenClawConfig }> {
  const packageName = params.request.packageName.trim();
  const official = resolveOfficialEntryByClawHubPackage(
    params.officialEntries,
    params.snapshot.config,
    packageName,
  );
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs,
  // while a declared id must stay enforced even if it equals the package name.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveHostedOfficialEntryByClawHubPackage(
    params.officialEntries,
    params.snapshot.config,
    packageName,
  );
  const hostedInstall = hostedOfficial
    ? resolveOfficialExternalPluginInstall(hostedOfficial, {
        catalogConfig: params.snapshot.config.marketplaces,
      })
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedInstall?.clawhubSpec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedInstall?.expectedIntegrity : undefined);
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const spec = buildClawHubSpec(packageName, version);
  const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
  const result = await installPluginFromClawHub({
    spec,
    config: params.snapshot.config,
    extensionsDir,
    logger: createInstallLogger(params.warnings),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
    ...(params.request.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
  });
  if (!result.ok) {
    return throwInstallFailure(result);
  }
  if (expectedPluginId && result.pluginId !== expectedPluginId) {
    throw new ManagedPluginLifecycleError(
      `official catalog plugin id mismatch: expected ${expectedPluginId}, got ${result.pluginId}`,
    );
  }
  const install: PluginInstallRecord = {
    ...buildClawHubPluginInstallRecordFields(result.clawhub),
    spec,
    installPath: result.targetDir,
  };
  const config = await persistManagedPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install,
    targetDir: result.targetDir,
    extensionsDir,
  });
  return { pluginId: result.pluginId, config };
}

async function installFromOfficialCatalog(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  snapshot: ConfigSnapshotForInstallPersist;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
}): Promise<{ pluginId: string; config: OpenClawConfig }> {
  const entry = resolveOfficialEntryById(params.officialEntries, params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry, {
    catalogConfig: params.snapshot.config.marketplaces,
  });
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const clawhub = install.clawhubSpec ? parseClawHubPluginSpec(install.clawhubSpec) : undefined;
  if (clawhub) {
    return await installFromClawHub({
      request: {
        source: "clawhub",
        packageName: clawhub.name,
        ...(clawhub.version ? { version: clawhub.version } : {}),
      },
      snapshot: params.snapshot,
      officialEntries: params.officialEntries,
      env: params.env,
      warnings: params.warnings,
      ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    });
  }
  if (!install.npmSpec) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
  const result = await installPluginFromNpmSpec({
    spec: install.npmSpec,
    config: params.snapshot.config,
    extensionsDir,
    expectedPluginId: pluginId,
    ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    trustedSourceLinkedOfficialInstall: true,
    logger: createInstallLogger(params.warnings),
  });
  if (!result.ok) {
    return throwInstallFailure(result);
  }
  if (result.pluginId !== pluginId) {
    throw new ManagedPluginLifecycleError(
      `official catalog plugin id mismatch: expected ${pluginId}, got ${result.pluginId}`,
    );
  }
  const installRecord: PluginInstallRecord = {
    source: "npm",
    spec: install.npmSpec,
    installPath: result.targetDir,
    ...(result.version ? { version: result.version } : {}),
    ...buildNpmResolutionInstallFields(result.npmResolution),
  };
  const config = await persistManagedPluginInstall({
    snapshot: params.snapshot,
    pluginId,
    install: installRecord,
    targetDir: result.targetDir,
    extensionsDir,
  });
  return { pluginId, config };
}

/** Install a ClawHub or curated official plugin through the canonical install pipeline. */
export async function installManagedPlugin(params: {
  request: ManagedPluginInstallRequest;
  env?: NodeJS.ProcessEnv;
}): Promise<{ plugin: ManagedPluginCatalogEntry; warnings?: string[] }> {
  return await withManagedPluginMutationLock(async () => {
    const env = params.env ?? process.env;
    const snapshot = await readPluginMutationSnapshot(env);
    const officialCatalog = await loadOfficialCatalog(snapshot.config);
    const warnings: string[] = [];
    const installed =
      params.request.source === "clawhub"
        ? await installFromClawHub({
            request: params.request,
            snapshot,
            officialEntries: officialCatalog.entries,
            env,
            warnings,
          })
        : await installFromOfficialCatalog({
            request: params.request,
            snapshot,
            officialEntries: officialCatalog.entries,
            env,
            warnings,
          });
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
    });
    const plugin = catalog.plugins.find((entry) => entry.id === installed.pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    return {
      plugin,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}

/** Persist desired plugin policy while preserving allow/deny, slot, include, and hash guards. */
export async function setManagedPluginEnabled(params: {
  pluginId: string;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
}> {
  return await withManagedPluginMutationLock(async () => {
    const env = params.env ?? process.env;
    const snapshot = await readPluginMutationSnapshot(env);
    const metadata = loadPluginMetadataSnapshot({ config: snapshot.config, env });
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    if (!metadata.index.plugins.some((plugin) => plugin.pluginId === pluginId)) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    let next = snapshot.config;
    const warnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // The admin-scoped enable RPC is an explicit trust action. Preserve the
      // existing inventory while admitting only the selected installed plugin.
      if ((next.plugins?.allow?.length ?? 0) > 0) {
        next = ensurePluginAllowlisted(next, pluginId);
      }
      const enableResult = enableExplicitlySelectedPluginInConfig(next, pluginId, {
        updateChannelConfig: false,
      });
      if (!enableResult.enabled) {
        throw new ManagedPluginLifecycleError(
          `plugin "${pluginId}" could not be enabled (${enableResult.reason ?? "unknown reason"})`,
        );
      }
      next = enableResult.config;
      policyPluginId = enableResult.pluginId;
      const slotResult = applySlotSelectionForPlugin(next, pluginId);
      next = slotResult.config;
      warnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    await replaceConfigFile({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
    });
    const catalog = await listManagedPlugins({ config: next, env });
    const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `updated plugin missing from refreshed registry: ${pluginId}`,
      );
    }
    return {
      plugin,
      changedPaths: [...changedPaths].filter(Boolean).toSorted(),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/** Remove an installed plugin: config references, install record, and managed files. */
export async function uninstallManagedPlugin(params: {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pluginId: string; removed: string[]; warnings?: string[] }> {
  return await withManagedPluginMutationLock(async () => {
    const env = params.env ?? process.env;
    const snapshot = await readPluginMutationSnapshot(env);
    const installRecords = await loadInstalledPluginIndexInstallRecords();
    // Mirror the CLI uninstall flow: plan against config carrying install records
    // so managed npm/git directories resolve, then persist the stripped config.
    const configWithRecords = withPluginInstallRecords(snapshot.config, installRecords);
    const metadata = loadPluginMetadataSnapshot({ config: configWithRecords, env });
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const record = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (record?.origin === "bundled") {
      throw new ManagedPluginLifecycleError(
        `bundled plugin cannot be uninstalled: ${pluginId}; disable it instead`,
      );
    }
    const manifest = metadata.byPluginId.get(pluginId);
    // Mirror the CLI cold path: pass channel ownership only when declared so
    // planPluginUninstall keeps its plugin-id fallback for channel config keys.
    const channelIds = manifest && manifest.channels.length > 0 ? manifest.channels : undefined;
    const extensionsDir = resolveDefaultPluginExtensionsDir(env);
    const plan = planPluginUninstall({
      config: configWithRecords,
      pluginId,
      ...(channelIds ? { channelIds } : {}),
      deleteFiles: true,
      extensionsDir,
    });
    if (!plan.ok) {
      throw new ManagedPluginLifecycleError(plan.error);
    }
    const nextConfig = withoutPluginInstallRecords(plan.config);
    const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: installRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    const directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    const warnings = [...directoryResult.warnings];
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: false,
      logger: { warn: (message) => warnings.push(message) },
    });
    const removed = formatUninstallActionLabels({
      ...plan.actions,
      directory: directoryResult.directoryRemoved,
    });
    return {
      pluginId,
      removed,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}

/** Normalize unexpected lifecycle failures for Gateway response adapters. */
export function formatManagedPluginLifecycleError(error: unknown): string {
  return formatErrorMessage(error);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

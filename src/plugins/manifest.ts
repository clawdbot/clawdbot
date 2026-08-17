/** Loads and normalizes OpenClaw plugin manifests, including contracts and config schemas. */
import fs from "node:fs";
import path from "node:path";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import { matchRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { coerceDoctorSessionRouteStateOwners } from "./doctor-session-route-state-owner-types.js";
import * as capabilityNormalizers from "./manifest-capability-normalizers.js";
import { normalizeManifestCommandAliases } from "./manifest-command-aliases.js";
import * as modelProviderNormalizers from "./manifest-model-provider-normalizers.js";
import * as setupNormalizers from "./manifest-setup-normalizers.js";
import type { PluginManifest, PluginManifestDoctorContract } from "./manifest-types.js";
import { createPluginCacheKey, PluginLruCache } from "./plugin-cache-primitives.js";
import type { PluginKind } from "./plugin-kind.types.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

export type * from "./manifest-types.js";
export * from "./package-manifest.js";
export {
  normalizeManifestActivation,
  normalizeManifestChannelCommandDefaults,
} from "./manifest-setup-normalizers.js";

/** Canonical plugin manifest filename inside plugin roots. */
export const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const MAX_PLUGIN_MANIFEST_LOAD_CACHE_ENTRIES = 512;
const CORE_RESERVED_PLUGIN_IDS = new Set(["node-mcp"]);
const VALID_PLUGIN_KINDS: ReadonlySet<string> = new Set<PluginKind>(["memory", "context-engine"]);

export function isCoreReservedPluginId(id: string): boolean {
  return CORE_RESERVED_PLUGIN_IDS.has(normalizePluginPolicyId(id));
}

type PluginManifestLoadResult =
  | { ok: true; manifest: PluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

type PluginManifestLoadCacheEntry = {
  result: PluginManifestLoadResult;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const pluginManifestLoadCache = new PluginLruCache<PluginManifestLoadCacheEntry>(
  MAX_PLUGIN_MANIFEST_LOAD_CACHE_ENTRIES,
);

function resolvePluginManifestPath(rootDir: string): string {
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
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const kinds: PluginKind[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !VALID_PLUGIN_KINDS.has(value)) {
      continue;
    }
    const kind = value as PluginKind;
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return kinds.length === 0 ? undefined : kinds.length === 1 ? kinds[0] : kinds;
}

export function loadPluginManifest(
  rootDir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PluginManifestLoadResult {
  const manifestPath = resolvePluginManifestPath(rootDir);
  const opened = openRootFileSync({
    absolutePath: manifestPath,
    rootPath: rootDir,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    boundaryLabel: "plugin root",
    maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    rejectHardlinks,
  });
  if (!opened.ok) {
    return matchRootFileOpenFailure(opened, {
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
  if (isCoreReservedPluginId(id)) {
    return cacheResult({
      ok: false,
      error: `plugin manifest id "${id}" is reserved by OpenClaw core`,
      manifestPath,
    });
  }
  const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
  if (!configSchema) {
    return cacheResult({ ok: false, error: "plugin manifest requires configSchema", manifestPath });
  }

  const requiresPlugins = normalizeTrimmedStringList(raw.requiresPlugins);
  const enabledByDefaultOnPlatforms = setupNormalizers.normalizeManifestDefaultPlatforms(
    raw.enabledByDefaultOnPlatforms,
  );
  const legacyPluginIds = normalizeTrimmedStringList(raw.legacyPluginIds);
  const autoEnableWhenConfiguredProviders = normalizeTrimmedStringList(
    raw.autoEnableWhenConfiguredProviders,
  );
  const providers = normalizeTrimmedStringList(raw.providers);
  const cliBackends = normalizeTrimmedStringList(raw.cliBackends);
  const rawDoctorContract = isRecord(raw.doctorContract) ? raw.doctorContract : undefined;
  const doctorContract = rawDoctorContract
    ? (Object.fromEntries(
        [
          "configRepair",
          "resolveSessionStoreAgentIds",
          "sessionRouteStateOwners",
          "stateMigrations",
        ].flatMap((key) =>
          typeof rawDoctorContract[key] === "boolean" ? [[key, rawDoctorContract[key]]] : [],
        ),
      ) as PluginManifestDoctorContract)
    : undefined;
  const manifestBeforeDashboard = {
    id,
    configSchema,
    ...(requiresPlugins.length > 0 ? { requiresPlugins } : {}),
    ...(raw.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(enabledByDefaultOnPlatforms.length > 0 ? { enabledByDefaultOnPlatforms } : {}),
    ...(legacyPluginIds.length > 0 ? { legacyPluginIds } : {}),
    ...(autoEnableWhenConfiguredProviders.length > 0 ? { autoEnableWhenConfiguredProviders } : {}),
    kind: parsePluginKind(raw.kind),
    channels: normalizeTrimmedStringList(raw.channels),
    providers,
    providerCatalogEntry: normalizeOptionalString(raw.providerCatalogEntry),
    modelSupport: modelProviderNormalizers.normalizeManifestModelSupport(raw.modelSupport),
    modelCatalog: normalizeModelCatalog(raw.modelCatalog, {
      ownedProviders: new Set([...providers, ...cliBackends]),
    }),
    modelPricing: modelProviderNormalizers.normalizeManifestModelPricing(raw.modelPricing, {
      ownedProviders: new Set(providers),
    }),
    modelIdNormalization: modelProviderNormalizers.normalizeManifestModelIdNormalization(
      raw.modelIdNormalization,
      { ownedProviders: new Set(providers) },
    ),
    providerEndpoints: modelProviderNormalizers.normalizeManifestProviderEndpoints(
      raw.providerEndpoints,
    ),
    providerRequest: modelProviderNormalizers.normalizeManifestProviderRequest(
      raw.providerRequest,
      { ownedProviders: new Set(providers) },
    ),
    secretProviderIntegrations:
      modelProviderNormalizers.normalizeManifestSecretProviderIntegrations(
        raw.secretProviderIntegrations,
      ),
    cliBackends,
    syntheticAuthRefs: normalizeTrimmedStringList(raw.syntheticAuthRefs),
    nonSecretAuthMarkers: normalizeTrimmedStringList(raw.nonSecretAuthMarkers),
    commandAliases: normalizeManifestCommandAliases(raw.commandAliases),
    cliCommands: setupNormalizers.normalizeManifestCliCommands(raw.cliCommands),
    providerUsageAuthEnvVars: capabilityNormalizers.normalizeStringListRecord(
      raw.providerUsageAuthEnvVars,
    ),
    providerAuthAliases: capabilityNormalizers.normalizeManifestStringRecord(
      raw.providerAuthAliases,
    ),
    providerAuthChoices: setupNormalizers.normalizeProviderAuthChoices(raw.providerAuthChoices),
    activation: setupNormalizers.normalizeManifestActivation(raw.activation),
    setup: setupNormalizers.normalizeManifestSetup(raw.setup),
    doctorContract,
    sessionRouteStateOwners:
      raw.sessionRouteStateOwners === undefined
        ? undefined
        : coerceDoctorSessionRouteStateOwners(raw.sessionRouteStateOwners),
    qaRunners: setupNormalizers.normalizeManifestQaRunners(raw.qaRunners),
  };
  const dashboardResult = setupNormalizers.normalizeManifestDashboard(raw.dashboard);
  if (!dashboardResult.ok) {
    return cacheResult({
      ok: false,
      error: `invalid plugin manifest dashboard: ${dashboardResult.error}`,
      manifestPath,
    });
  }

  return cacheResult({
    ok: true,
    manifest: {
      ...manifestBeforeDashboard,
      dashboard: dashboardResult.dashboard,
      mcpServers: capabilityNormalizers.normalizeManifestMcpServers(raw.mcpServers),
      skills: normalizeTrimmedStringList(raw.skills),
      name: normalizeOptionalString(raw.name),
      description: normalizeOptionalString(raw.description),
      catalog: capabilityNormalizers.normalizeManifestCatalog(raw.catalog),
      icon: normalizeOptionalString(raw.icon),
      version: normalizeOptionalString(raw.version),
      uiHints: setupNormalizers.normalizeConfigUiHints(raw.uiHints),
      contracts: capabilityNormalizers.normalizeManifestContracts(raw.contracts),
      mediaUnderstandingProviderMetadata:
        capabilityNormalizers.normalizeMediaUnderstandingProviderMetadata(
          raw.mediaUnderstandingProviderMetadata,
        ),
      imageGenerationProviderMetadata: capabilityNormalizers.normalizeCapabilityProviderMetadata(
        raw.imageGenerationProviderMetadata,
      ),
      videoGenerationProviderMetadata: capabilityNormalizers.normalizeCapabilityProviderMetadata(
        raw.videoGenerationProviderMetadata,
      ),
      musicGenerationProviderMetadata: capabilityNormalizers.normalizeCapabilityProviderMetadata(
        raw.musicGenerationProviderMetadata,
      ),
      toolMetadata: capabilityNormalizers.normalizePluginToolMetadata(raw.toolMetadata),
      configContracts: capabilityNormalizers.normalizeManifestConfigContracts(raw.configContracts),
      channelConfigs: setupNormalizers.normalizeChannelConfigs(raw.channelConfigs),
    },
    manifestPath,
  });
}

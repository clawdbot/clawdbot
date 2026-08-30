/** Loads and normalizes OpenClaw plugin manifests, including contracts and config schemas. */
import path from "node:path";
import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import { matchRootFileOpenFailure } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { coerceDoctorSessionRouteStateOwners } from "./doctor-session-route-state-owner-types.js";
import * as capabilityNormalizers from "./manifest-capability-normalizers.js";
import { normalizeManifestCommandAliases } from "./manifest-command-aliases.js";
import * as modelProviderNormalizers from "./manifest-model-provider-normalizers.js";
import * as setupNormalizers from "./manifest-setup-normalizers.js";
import type {
  PluginManifestBackupResource,
  PluginManifestDoctorContract,
} from "./manifest-types.js";
import { parsePluginCacheJson, readPluginCacheFile } from "./plugin-cache-files.js";
import type { CachedPluginManifestResult as PluginManifestLoadResult } from "./plugin-cache-files.types.js";
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
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const CORE_RESERVED_PLUGIN_IDS = new Set(["node-mcp"]);
const VALID_PLUGIN_KINDS: ReadonlySet<string> = new Set<PluginKind>(["memory", "context-engine"]);

export function isCoreReservedPluginId(id: string): boolean {
  return CORE_RESERVED_PLUGIN_IDS.has(normalizePluginPolicyId(id));
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

function parseManifestBackupResources(
  raw: unknown,
): { ok: true; resources?: PluginManifestBackupResource[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: "backupResources must be an array" };
  }
  const resources = new Map<string, PluginManifestBackupResource>();
  for (const [index, entry] of raw.entries()) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 3 ||
      !("disposition" in entry) ||
      !("scope" in entry) ||
      !("relativePath" in entry)
    ) {
      return {
        ok: false,
        error: `backupResources[${index}] must contain only disposition, scope, and relativePath`,
      };
    }
    const { disposition, scope, relativePath } = entry;
    if (disposition !== "include" && disposition !== "regenerable") {
      return { ok: false, error: `backupResources[${index}].disposition is invalid` };
    }
    if (scope !== "state" && scope !== "agent") {
      return { ok: false, error: `backupResources[${index}].scope is invalid` };
    }
    if (
      typeof relativePath !== "string" ||
      !relativePath ||
      relativePath.includes("\\") ||
      relativePath.includes("\0") ||
      path.posix.isAbsolute(relativePath) ||
      path.win32.isAbsolute(relativePath) ||
      /^[A-Za-z][A-Za-z\d+.-]*:/.test(relativePath) ||
      relativePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
      return {
        ok: false,
        error: `backupResources[${index}].relativePath must be a strict relative POSIX path`,
      };
    }
    const resource: PluginManifestBackupResource = { disposition, scope, relativePath };
    resources.set(`${scope}\0${relativePath}\0${disposition}`, resource);
  }
  return {
    ok: true,
    resources: [...resources.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, resource]) => resource),
  };
}

export function loadPluginManifest(
  rootDir: string,
  rejectHardlinks = true,
  rootRealPath?: string,
): PluginManifestLoadResult {
  const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
  const file = readPluginCacheFile({
    rootDir,
    relativePath: PLUGIN_MANIFEST_FILENAME,
    ...(rootRealPath !== undefined ? { rootRealPath } : {}),
    maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
    rejectHardlinks,
  });
  if (!file.ok) {
    return matchRootFileOpenFailure(file.failure, {
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
  if (file.manifest) {
    return file.manifest;
  }
  const cacheResult = (result: PluginManifestLoadResult): PluginManifestLoadResult => {
    return (file.manifest = result);
  };
  const parsed = parsePluginCacheJson(file, { json5: true });
  if (!parsed.ok) {
    return cacheResult({
      ok: false,
      error: `failed to parse plugin manifest: ${String(parsed.error)}`,
      manifestPath,
    });
  }
  const raw = parsed.value;
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
  const backupResources = parseManifestBackupResources(raw.backupResources);
  if (!backupResources.ok) {
    return cacheResult({
      ok: false,
      error: `invalid plugin manifest backupResources: ${backupResources.error}`,
      manifestPath,
      diagnosticCode: "backup-resource-declaration-invalid",
    });
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
    ...(backupResources.resources !== undefined
      ? { backupResources: backupResources.resources }
      : {}),
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
    doctorHealthChecks: raw.doctorHealthChecks === true ? true : undefined,
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

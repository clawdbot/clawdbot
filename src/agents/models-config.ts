/**
 * Ensures agent-local models.json and the SQLite-backed plugin model catalog
 * match runtime config, discovered providers, auth-profile state, and
 * generated catalog ownership.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import {
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
  resolveDefaultAgentDir,
} from "./agent-scope.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  MODELS_JSON_STATE,
  type ModelsJsonReadyResult,
  type ModelsJsonReadyState,
} from "./models-config-state.js";
import { planOpenClawModelsJson, type PreparedModelsConfigContext } from "./models-config.plan.js";
import { repairPluginModelCatalogTransportMetadata } from "./plugin-model-catalog-repair.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogs,
  loadPersistedPluginModelCatalogsReadOnly,
  replacePersistedPluginModelCatalogs,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";

type PreparedOpenClawModelsJsonSource = ModelsJsonReadyResult & {
  fingerprint: string;
  workspaceDir?: string;
};

type ModelsConfigPluginMetadataSnapshot = Pick<
  PluginMetadataSnapshot,
  "index" | "manifestRegistry" | "owners" | "pluginIds"
>;

type EnsureOpenClawModelsJsonOptions = {
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: ModelsConfigPluginMetadataSnapshot;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  workspaceDir?: string;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  onProviderCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
};

type PlanOpenClawModelsJsonSourceOptions = EnsureOpenClawModelsJsonOptions & {
  authStore?: AuthProfileStore;
};

type PlannedOpenClawModelsJsonSource = Readonly<{
  agentDir: string;
  modelsJsonContents: string | null;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
}>;

function listPreparedPluginModelCatalogs(agentDir: string) {
  const { catalogs, warnings } = loadPersistedPluginModelCatalogs(agentDir);
  if (warnings.length > 0) {
    throw new Error(
      `Cannot safely prepare provider models until legacy catalog migration succeeds: ${warnings.join("; ")}. Run openclaw doctor --fix.`,
    );
  }
  return catalogs;
}

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

async function buildModelsJsonFingerprint(context: PreparedModelsConfigContext): Promise<string> {
  const authProfilesSqlitePath = resolveAuthProfileDatabasePath(context.agentDir);
  const authProfilesMtimeMs = await readFileMtimeMs(authProfilesSqlitePath);
  const authProfilesWalMtimeMs = await readFileMtimeMs(`${authProfilesSqlitePath}-wal`);
  const modelsFileMtimeMs = await readFileMtimeMs(path.join(context.agentDir, "models.json"));
  const pluginCatalogFingerprint = createHash("sha256")
    .update(stableStringify(listPreparedPluginModelCatalogs(context.agentDir)))
    .digest("base64url");
  const pluginMetadataSnapshotIndexFingerprint = context.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(context.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: context.cfg,
    discoveryAuthConfigHash: hashRuntimeConfigValue(context.discoveryAuthConfig),
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    envShape: context.envFingerprint,
    authProfilesMtimeMs,
    authProfilesWalMtimeMs,
    modelsFileMtimeMs,
    pluginCatalogFingerprint,
    workspaceDir: context.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    pluginMetadataSnapshotPluginIds:
      context.pluginMetadataSnapshot?.pluginIds === undefined
        ? null
        : context.pluginMetadataSnapshot.pluginIds.toSorted(),
    providerDiscoveryProviderIds: context.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: context.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: context.providerDiscoveryEntriesOnly === true,
  });
}

function modelsJsonReadyCacheKey(targetPath: string, fingerprint: string): string {
  return `${targetPath}\0${fingerprint}`;
}

async function readExistingModelsFile(pathname: string): Promise<{
  raw: string;
  parsed: unknown;
}> {
  try {
    const raw = await privateFileStore(path.dirname(pathname)).readTextIfExists(
      path.basename(pathname),
    );
    if (raw === null) {
      return {
        raw: "",
        parsed: null,
      };
    }
    return {
      raw,
      parsed: JSON.parse(raw) as unknown,
    };
  } catch {
    return {
      raw: "",
      parsed: null,
    };
  }
}

/** Best-effort chmod for the user-visible generated models.json file. */
async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

/** Atomic private-file-store write used by models.json generation. */
async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  await privateFileStore(path.dirname(targetPath)).writeText(path.basename(targetPath), contents);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.modelsConfigTestApi")] = {
    ensureModelsFileModeForModelsJson,
    writeModelsFileAtomicForModelsJson,
  };
}

async function mergeGeneratedPluginCatalogProvidersIntoExistingParsed(params: {
  agentDir: string;
  existingParsed: unknown;
  pluginCatalogs?: readonly PersistedPluginModelCatalog[];
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): Promise<unknown> {
  const root = isRecord(params.existingParsed) ? params.existingParsed : {};
  const providers = isRecord(root.providers) ? { ...root.providers } : {};
  let changed = false;
  const pluginCatalogs = params.pluginCatalogs ?? listPreparedPluginModelCatalogs(params.agentDir);
  for (const { pluginId: catalogPluginId, contents } of pluginCatalogs) {
    let catalog: unknown;
    try {
      catalog = JSON.parse(contents) as unknown;
    } catch {
      continue;
    }
    if (
      !isGeneratedPluginModelCatalog(catalog) ||
      !isRecord(catalog) ||
      !isRecord(catalog.providers)
    ) {
      continue;
    }
    for (const [providerId, provider] of Object.entries(catalog.providers)) {
      const currentOwnerPluginId = resolvePluginModelCatalogOwnerPluginId({
        providerId,
        pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      });
      if (currentOwnerPluginId !== catalogPluginId) {
        continue;
      }
      providers[providerId] = provider;
      changed = true;
    }
  }
  if (!changed) {
    return params.existingParsed;
  }
  return { ...root, providers };
}

function materializePlannedPluginCatalogs(
  pluginCatalogWrites: Readonly<Record<string, string>>,
): PersistedPluginModelCatalog[] {
  return Object.entries(pluginCatalogWrites)
    .map(([relativePath, contents]) => {
      const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
      if (!pluginId) {
        throw new Error(`Invalid generated plugin model catalog key: ${relativePath}`);
      }
      return {
        pluginId,
        contents: repairPluginModelCatalogTransportMetadata(contents).contents,
      };
    })
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

function writePluginCatalogsForModelsJson(params: {
  agentDir: string;
  pluginCatalogWrites?: Record<string, string>;
}): boolean {
  if (!params.pluginCatalogWrites) {
    return false;
  }
  return replacePersistedPluginModelCatalogs({
    agentDir: params.agentDir,
    pluginCatalogWrites: params.pluginCatalogWrites,
  });
}

function resolveModelsConfigInput(config?: OpenClawConfig): {
  config: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!config) {
    const loaded = getRuntimeConfig();
    return {
      config: runtimeSource ?? loaded,
      discoveryAuthConfig: loaded,
      sourceConfigForSecrets: runtimeSource ?? loaded,
    };
  }
  if (!runtimeSource) {
    return {
      config,
      discoveryAuthConfig: config,
      sourceConfigForSecrets: config,
    };
  }
  const projected = projectConfigOntoRuntimeSourceSnapshot(config);
  return {
    config: projected,
    discoveryAuthConfig: config,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? runtimeSource : projected,
  };
}

function prepareModelsConfigContext(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): PreparedModelsConfigContext {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveDefaultAgentDir(cfg);
  const workspaceDir =
    options.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : // Same ambient owner resolveDefaultAgentDir just used for agentDir; resolving it
        // on the deprecated chain here rejected explicit fleets owned by a system agent.
        resolveAgentWorkspaceDir(cfg, resolveAmbientOwnerAgentId(cfg)));
  const fingerprintEnv = createConfigRuntimeEnv(cfg, options.env ?? {});
  const env = options.env ? fingerprintEnv : createConfigRuntimeEnv(cfg);
  const providerScopedDiscovery = Boolean(options.providerDiscoveryProviderIds?.length);
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(providerScopedDiscovery ? { preferPersisted: false } : {}),
    });
  return {
    cfg,
    discoveryAuthConfig: resolved.discoveryAuthConfig,
    // Native readiness belongs to the captured auth inputs, not the catalog's env clone.
    discoveryAuthEnv: options.env ?? process.env,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    env,
    envFingerprint: options.env ? hashRuntimeConfigValue(fingerprintEnv) : fingerprintEnv,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: options.preparedStaticProviderCatalog }
      : {}),
    ...(options.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
      : {}),
    ...(options.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
      : {}),
    ...(options.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
    ...(options.onProviderCatalogOutcome
      ? { onProviderCatalogOutcome: options.onProviderCatalogOutcome }
      : {}),
  };
}

async function withModelsJsonWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  return await MODELS_JSON_STATE.writeQueue.enqueue(targetPath, run);
}

/** Ensures models.json and the agent SQLite catalog cache are current. */
async function prepareOpenClawModelsJsonSource(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<PreparedOpenClawModelsJsonSource> {
  const context = prepareModelsConfigContext(config, agentDirOverride, options);
  const { agentDir, pluginMetadataSnapshot, workspaceDir } = context;
  const targetPath = path.join(agentDir, "models.json");
  const fingerprint = await buildModelsJsonFingerprint(context);
  const cacheKey = modelsJsonReadyCacheKey(targetPath, fingerprint);
  const cached = MODELS_JSON_STATE.readyCache.get(cacheKey);
  if (cached && !options.onProviderCatalogOutcome) {
    const settled = await cached;
    await ensureModelsFileModeForModelsJson(targetPath);
    return {
      ...settled.result,
      fingerprint: settled.fingerprint,
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }

  const pending: Promise<ModelsJsonReadyState> = withModelsJsonWriteLock(targetPath, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // are available to provider discovery without mutating process.env.
    const existingModelsFile = await readExistingModelsFile(targetPath);
    const existingParsedForMerge = await mergeGeneratedPluginCatalogProvidersIntoExistingParsed({
      agentDir,
      existingParsed: existingModelsFile.parsed,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    });
    const plan = await planOpenClawModelsJson({
      context,
      existingRaw: existingModelsFile.raw,
      existingParsed: existingParsedForMerge,
    });

    if (plan.action === "skip") {
      const wrotePluginCatalog = writePluginCatalogsForModelsJson({
        agentDir,
        pluginCatalogWrites: plan.pluginCatalogWrites,
      });
      return { fingerprint, result: { agentDir, wrote: wrotePluginCatalog } };
    }

    if (plan.action === "noop") {
      const wrotePluginCatalog = writePluginCatalogsForModelsJson({
        agentDir,
        pluginCatalogWrites: plan.pluginCatalogWrites,
      });
      await ensureModelsFileModeForModelsJson(targetPath);
      return { fingerprint, result: { agentDir, wrote: wrotePluginCatalog } };
    }

    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    const existingRoot = existingModelsFile.raw;
    const wroteRoot = existingRoot !== plan.contents;
    if (wroteRoot) {
      await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
    }
    await ensureModelsFileModeForModelsJson(targetPath);
    const wrotePluginCatalog = writePluginCatalogsForModelsJson({
      agentDir,
      pluginCatalogWrites: plan.pluginCatalogWrites,
    });
    return { fingerprint, result: { agentDir, wrote: wroteRoot || wrotePluginCatalog } };
  });
  MODELS_JSON_STATE.readyCache.set(cacheKey, pending);
  try {
    const settled = await pending;
    const refreshedFingerprint = await buildModelsJsonFingerprint(context);
    const refreshedCacheKey = modelsJsonReadyCacheKey(targetPath, refreshedFingerprint);
    if (refreshedCacheKey !== cacheKey) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
      MODELS_JSON_STATE.readyCache.set(
        refreshedCacheKey,
        Promise.resolve({ fingerprint: refreshedFingerprint, result: settled.result }),
      );
    }
    return {
      ...settled.result,
      fingerprint: refreshedFingerprint,
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(cacheKey) === pending) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
    }
    throw error;
  }
}

/**
 * Plans the complete root/plugin catalog generation without mutating agent-owned state.
 * Control-plane inventory reads use this when their lifecycle generation may be superseded.
 */
export async function planOpenClawModelsJsonSource(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: PlanOpenClawModelsJsonSourceOptions = {},
): Promise<PlannedOpenClawModelsJsonSource> {
  const context = prepareModelsConfigContext(config, agentDirOverride, options);
  const { agentDir, pluginMetadataSnapshot } = context;
  const existingModelsFile = await readExistingModelsFile(path.join(agentDir, "models.json"));
  const existingPluginCatalogs = loadPersistedPluginModelCatalogsReadOnly(agentDir);
  const existingParsedForMerge = await mergeGeneratedPluginCatalogProvidersIntoExistingParsed({
    agentDir,
    existingParsed: existingModelsFile.parsed,
    pluginCatalogs: existingPluginCatalogs,
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
  });
  const plan = await planOpenClawModelsJson({
    context,
    ...(options.authStore ? { authStore: options.authStore } : {}),
    existingRaw: existingModelsFile.raw,
    existingParsed: existingParsedForMerge,
  });
  return {
    agentDir,
    modelsJsonContents: plan.action === "write" ? plan.contents : existingModelsFile.raw || null,
    // Planned writes share the writer's complete-replacement contract, including intentional
    // stale-catalog deletion. Only a non-authoritative plan omits this field.
    pluginCatalogs:
      plan.pluginCatalogWrites === undefined
        ? existingPluginCatalogs
        : materializePlannedPluginCatalogs(plan.pluginCatalogWrites),
  };
}

/** Ensures models.json and the agent SQLite catalog cache are current. */
export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: EnsureOpenClawModelsJsonOptions = {},
): Promise<ModelsJsonReadyResult> {
  const prepared = await prepareOpenClawModelsJsonSource(config, agentDirOverride, options);
  return { agentDir: prepared.agentDir, wrote: prepared.wrote };
}

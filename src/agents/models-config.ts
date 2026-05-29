import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
} from "./agent-scope.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  isGeneratedPluginModelCatalog,
  isPluginModelCatalogRelativePath,
  listPluginModelCatalogRelativePaths,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";
import { stableStringify } from "./stable-stringify.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

async function readPluginCatalogMtimes(agentDir: string): Promise<Array<[string, number | null]>> {
  const entries = await Promise.all(
    listPluginModelCatalogRelativePaths(agentDir).map(async (relativePath) => {
      return [relativePath, await readFileMtimeMs(path.join(agentDir, relativePath))] satisfies [
        string,
        number | null,
      ];
    }),
  );
  return entries.toSorted(([left], [right]) => left.localeCompare(right));
}

async function buildModelsJsonFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}): Promise<string> {
  const authProfilesMtimeMs = await readFileMtimeMs(
    path.join(params.agentDir, "auth-profiles.json"),
  );
  const modelsFileMtimeMs = await readFileMtimeMs(path.join(params.agentDir, "models.json"));
  const pluginCatalogMtimes = await readPluginCatalogMtimes(params.agentDir);
  const envShape = createConfigRuntimeEnv(params.config, {});
  const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index)
    : undefined;
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesMtimeMs,
    modelsFileMtimeMs,
    pluginCatalogMtimes,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    providerDiscoveryProviderIds: params.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs,
    providerDiscoveryEntriesOnly: params.providerDiscoveryEntriesOnly === true,
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

export async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

export async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  await privateFileStore(path.dirname(targetPath)).writeText(path.basename(targetPath), contents);
}

async function isGeneratedPluginCatalogFile(targetPath: string): Promise<boolean> {
  return (await readGeneratedPluginCatalog(targetPath)) !== undefined;
}

async function readGeneratedPluginCatalog(targetPath: string): Promise<unknown> {
  const existing = await readExistingModelsFile(targetPath);
  const parsed = existing.parsed;
  return isGeneratedPluginModelCatalog(parsed) ? parsed : undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mergeGeneratedPluginCatalogProvidersIntoExistingParsed(params: {
  agentDir: string;
  existingParsed: unknown;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): Promise<unknown> {
  const root = isRecordLike(params.existingParsed) ? params.existingParsed : {};
  const providers = isRecordLike(root.providers) ? { ...root.providers } : {};
  let changed = false;
  for (const relativePath of listPluginModelCatalogRelativePaths(params.agentDir)) {
    const catalogPluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!catalogPluginId) {
      continue;
    }
    const catalog = await readGeneratedPluginCatalog(path.join(params.agentDir, relativePath));
    if (!isRecordLike(catalog) || !isRecordLike(catalog.providers)) {
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

async function removeStalePluginCatalogs(params: {
  agentDir: string;
  activeRelativePaths: ReadonlySet<string>;
}): Promise<boolean> {
  let wrote = false;
  for (const relativePath of listPluginModelCatalogRelativePaths(params.agentDir)) {
    if (params.activeRelativePaths.has(path.normalize(relativePath))) {
      continue;
    }
    const targetPath = path.join(params.agentDir, relativePath);
    if (!(await isGeneratedPluginCatalogFile(targetPath))) {
      continue;
    }
    await fs.unlink(targetPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    });
    wrote = true;
  }
  return wrote;
}

async function writePluginCatalogsForModelsJson(params: {
  agentDir: string;
  pluginCatalogWrites?: Record<string, string>;
}): Promise<boolean> {
  if (!params.pluginCatalogWrites) {
    return false;
  }
  let wrote = false;
  const activeRelativePaths = new Set<string>();
  for (const [relativePath, contents] of Object.entries(params.pluginCatalogWrites)) {
    if (!isPluginModelCatalogRelativePath(relativePath)) {
      continue;
    }
    activeRelativePaths.add(path.normalize(relativePath));
    const targetPath = path.join(params.agentDir, relativePath);
    const existing = await readExistingModelsFile(targetPath);
    if (existing.raw === contents) {
      await ensureModelsFileModeForModelsJson(targetPath);
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeModelsFileAtomicForModelsJson(targetPath, contents);
    await ensureModelsFileModeForModelsJson(targetPath);
    wrote = true;
  }
  const removedStale = await removeStalePluginCatalogs({
    agentDir: params.agentDir,
    activeRelativePaths,
  });
  return wrote || removedStale;
}

function resolveModelsConfigInput(config?: OpenClawConfig): {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!config) {
    const loaded = getRuntimeConfig();
    return {
      config: runtimeSource ?? loaded,
      sourceConfigForSecrets: runtimeSource ?? loaded,
    };
  }
  if (!runtimeSource) {
    return {
      config,
      sourceConfigForSecrets: config,
    };
  }
  const projected = projectConfigOntoRuntimeSourceSnapshot(config);
  return {
    config: projected,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? runtimeSource : projected,
  };
}

async function withModelsJsonWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = MODELS_JSON_STATE.writeLocks.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODELS_JSON_STATE.writeLocks.set(targetPath, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODELS_JSON_STATE.writeLocks.get(targetPath) === pending) {
      MODELS_JSON_STATE.writeLocks.delete(targetPath);
    }
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: {
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    workspaceDir?: string;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  } = {},
): Promise<{ agentDir: string; wrote: boolean }> {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
  const workspaceDir =
    options.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  const providerScopedDiscovery = Boolean(options.providerDiscoveryProviderIds?.length);
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: cfg,
      env: createConfigRuntimeEnv(cfg),
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(providerScopedDiscovery ? { preferPersisted: false } : {}),
    });
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveDefaultAgentDir(cfg);
  const targetPath = path.join(agentDir, "models.json");
  const fingerprint = await buildModelsJsonFingerprint({
    config: cfg,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
      : {}),
    ...(options.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
      : {}),
    ...(options.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
  });
  const cacheKey = modelsJsonReadyCacheKey(targetPath, fingerprint);
  const cached = MODELS_JSON_STATE.readyCache.get(cacheKey);
  if (cached) {
    const settled = await cached;
    await ensureModelsFileModeForModelsJson(targetPath);
    return settled.result;
  }

  const pending = withModelsJsonWriteLock(targetPath, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // are available to provider discovery without mutating process.env.
    const env = createConfigRuntimeEnv(cfg);
    const existingModelsFile = await readExistingModelsFile(targetPath);
    const existingParsedForMerge = await mergeGeneratedPluginCatalogProvidersIntoExistingParsed({
      agentDir,
      existingParsed: existingModelsFile.parsed,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    });
    const plan = await planOpenClawModelsJson({
      cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      existingRaw: existingModelsFile.raw,
      existingParsed: existingParsedForMerge,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    });

    if (plan.action === "skip") {
      const wrotePluginCatalog = await writePluginCatalogsForModelsJson({
        agentDir,
        pluginCatalogWrites: plan.pluginCatalogWrites,
      });
      return { fingerprint, result: { agentDir, wrote: wrotePluginCatalog } };
    }

    if (plan.action === "noop") {
      const wrotePluginCatalog = await writePluginCatalogsForModelsJson({
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
    const wrotePluginCatalog = await writePluginCatalogsForModelsJson({
      agentDir,
      pluginCatalogWrites: plan.pluginCatalogWrites,
    });
    return { fingerprint, result: { agentDir, wrote: wroteRoot || wrotePluginCatalog } };
  });
  MODELS_JSON_STATE.readyCache.set(cacheKey, pending);
  try {
    const settled = await pending;
    const refreshedFingerprint = await buildModelsJsonFingerprint({
      config: cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      ...(workspaceDir ? { workspaceDir } : {}),
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
      ...(options.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    });
    const refreshedCacheKey = modelsJsonReadyCacheKey(targetPath, refreshedFingerprint);
    if (refreshedCacheKey !== cacheKey) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
      MODELS_JSON_STATE.readyCache.set(
        refreshedCacheKey,
        Promise.resolve({ fingerprint: refreshedFingerprint, result: settled.result }),
      );
    }
    return settled.result;
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(cacheKey) === pending) {
      MODELS_JSON_STATE.readyCache.delete(cacheKey);
    }
    throw error;
  }
}

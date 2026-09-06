/** Loads channel secret contract APIs from bundled and external plugin artifacts. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { shouldRejectHardlinkedPluginFiles } from "../plugins/hardlink-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { pluginCacheExistsSync } from "../plugins/plugin-cache-files.js";
import { getPluginCacheRoot } from "../plugins/plugin-cache.js";
import { getCachedPluginModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "../plugins/public-surface-loader.js";
import { loadOfficialExternalChannelSecretContractApi } from "./official-external-channel-secret-contract.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type BundledChannelContractApi = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
};

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type BundledChannelSecretContractApi = Pick<
  BundledChannelContractApi,
  "collectRuntimeConfigAssignments" | "secretTargetRegistryEntries"
>;

/** Loads a bundled channel secret contract from its public artifact bundle. */
function loadBundledChannelSecretContractApi(
  channelId: string,
): BundledChannelSecretContractApi | undefined {
  return (
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<BundledChannelSecretContractApi>({
      dirName: channelId,
      artifactCandidates: ["secret-contract-api.js"],
    }) ?? undefined
  );
}

function orderedContractApiExtensions(): readonly string[] {
  return RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
}

function resolvePluginContractApiPath(rootDir: string): string | null {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = "channel-secret-contract";
  const cached = artifacts.get(key);
  if (cached !== undefined) {
    return cached?.modulePath ?? null;
  }
  // Compiled npm-published plugins place their public artifacts under <rootDir>/dist/
  // (per package.json `openclaw.runtimeExtensions`), while flat-layout plugins keep
  // them at <rootDir>/. Search both, preferring dist/ when running from built openclaw
  // artifacts and rootDir/ when running from source.
  const searchDirs = RUNNING_FROM_BUILT_ARTIFACT
    ? [path.join(rootDir, "dist"), rootDir]
    : [rootDir, path.join(rootDir, "dist")];
  for (const basename of ["secret-contract-api", "contract-api"]) {
    for (const dir of searchDirs) {
      for (const extension of orderedContractApiExtensions()) {
        const candidate = path.join(dir, `${basename}${extension}`);
        if (pluginCacheExistsSync(candidate)) {
          artifacts.set(key, { modulePath: candidate, boundaryRoot: rootDir });
          return candidate;
        }
      }
    }
  }
  artifacts.set(key, null);
  return null;
}

function loadPluginContractModule(modulePath: string): BundledChannelContractApi {
  return getCachedPluginModuleLoader({
    modulePath,
    importerUrl: import.meta.url,
  })(modulePath) as BundledChannelContractApi;
}

function loadExternalChannelSecretContractFromRecord(
  record: PluginManifestRecord,
  env: NodeJS.ProcessEnv = process.env,
  throwOnLoadError = false,
): BundledChannelSecretContractApi | undefined {
  const contractPath = resolvePluginContractApiPath(record.rootDir);
  if (!contractPath) {
    return undefined;
  }
  const artifacts = getPluginCacheRoot(record.rootDir).artifacts;
  const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
    origin: record.origin,
    rootDir: record.rootDir,
    env,
  });
  const boundary = `channel-secret-contract:validated:${rejectHardlinks}`;
  let validated = artifacts.get(boundary);
  if (validated === undefined) {
    const opened = openRootFileSync({
      absolutePath: contractPath,
      rootPath: record.rootDir,
      boundaryLabel: "plugin root",
      rejectHardlinks,
      skipLexicalRootCheck: true,
    });
    if (opened.ok) {
      fs.closeSync(opened.fd);
      validated = { modulePath: opened.path, boundaryRoot: record.rootDir };
    } else {
      validated = null;
    }
    artifacts.set(boundary, validated);
  }
  if (!validated) {
    if (throwOnLoadError) {
      throw new Error(`Unable to open channel secret contract for ${record.id}`);
    }
    return undefined;
  }
  try {
    const mod = loadPluginContractModule(validated.modulePath);
    if (mod.collectRuntimeConfigAssignments || mod.secretTargetRegistryEntries) {
      return mod;
    }
  } catch (error) {
    if (throwOnLoadError) {
      throw error;
    }
    if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[channel-contract-api] failed to load ${record.id} contract ${validated.modulePath}: ${detail}`,
      );
    }
  }
  return undefined;
}

function recordOwnsChannel(record: PluginManifestRecord, channelId: string): boolean {
  return (
    record.channels.includes(channelId) ||
    Object.hasOwn(record.channelConfigs ?? {}, channelId) ||
    record.channelCatalogMeta?.id === channelId ||
    record.packageChannel?.id === channelId
  );
}

function listChannelSecretContractRecords(params: {
  channelId: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): PluginManifestRecord[] {
  const manifestRegistry = resolveConfigWidePluginManifestRegistry({
    config: params.config,
    env: params.env,
  });
  return manifestRegistry.plugins
    .filter((record) => record.origin !== "bundled")
    .filter((record) => recordOwnsChannel(record, params.channelId))
    .filter(
      (record) => !params.loadablePluginOrigins || params.loadablePluginOrigins.has(record.id),
    )
    .toSorted((left, right) => {
      if (left.id === params.channelId && right.id !== params.channelId) {
        return -1;
      }
      if (right.id === params.channelId && left.id !== params.channelId) {
        return 1;
      }
      return left.id.localeCompare(right.id);
    });
}

/** Loads the first channel secret contract for a channel, preferring bundled metadata. */
/** Loads a channel secret contract API for a channel id and current plugin origin policy. */
export function loadChannelSecretContractApi(params: {
  channelId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
  bundledOnly?: boolean;
}): BundledChannelSecretContractApi | undefined {
  const bundled = loadBundledChannelSecretContractApi(params.channelId);
  if (bundled || params.bundledOnly) {
    return bundled;
  }
  // External contracts are considered only after bundled artifacts so core channels keep their
  // shipped metadata stable even when similarly named plugins are installed.
  const env = params.env ?? process.env;
  const officialFallback = loadOfficialExternalChannelSecretContractApi(params.channelId);
  let records: PluginManifestRecord[];
  try {
    records = listChannelSecretContractRecords({
      channelId: params.channelId,
      config: params.config,
      env,
      loadablePluginOrigins: params.loadablePluginOrigins,
    });
  } catch (error) {
    // Catalog contracts are process-stable fallbacks when plugin metadata is unavailable.
    if (officialFallback) {
      return officialFallback;
    }
    throw error;
  }
  for (const record of records) {
    const contract = loadExternalChannelSecretContractFromRecord(record, env);
    if (contract) {
      return contract;
    }
  }
  return officialFallback;
}

/** Loads a channel secret contract directly from a manifest record. */
export function loadChannelSecretContractApiForRecord(
  record: PluginManifestRecord,
  options?: { throwOnLoadError?: boolean },
): BundledChannelSecretContractApi | undefined {
  if (record.origin === "bundled") {
    return loadBundledChannelSecretContractApi(record.id);
  }
  return loadExternalChannelSecretContractFromRecord(
    record,
    process.env,
    options?.throwOnLoadError,
  );
}

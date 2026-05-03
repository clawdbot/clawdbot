import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "../plugins/plugin-module-loader-cache.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

type BundledChannelContractApi = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
  unsupportedSecretRefSurfacePatterns?: readonly string[];
  collectUnsupportedSecretRefConfigCandidates?: (
    raw: Record<string, unknown>,
  ) => UnsupportedSecretRefConfigCandidate[];
};

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

function loadBundledChannelPublicArtifact(
  channelId: string,
  artifactBasenames: readonly string[],
): BundledChannelContractApi | undefined {
  for (const artifactBasename of artifactBasenames) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<BundledChannelContractApi>({
        dirName: channelId,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[channel-contract-api] failed to load ${channelId}/${artifactBasename}: ${detail}\n`,
        );
      }
    }
  }
  return undefined;
}

export type BundledChannelSecretContractApi = Pick<
  BundledChannelContractApi,
  "collectRuntimeConfigAssignments" | "secretTargetRegistryEntries"
>;

export function loadBundledChannelSecretContractApi(
  channelId: string,
): BundledChannelSecretContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["secret-contract-api.js", "contract-api.js"]);
}

function orderedContractApiExtensions(): readonly string[] {
  return RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
}

function resolvePluginContractApiPath(rootDir: string): string | null {
  for (const extension of orderedContractApiExtensions()) {
    const candidate = path.join(rootDir, `secret-contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of orderedContractApiExtensions()) {
    const candidate = path.join(rootDir, `contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadPluginContractModule(modulePath: string): BundledChannelContractApi {
  return getCachedPluginModuleLoader({
    cache: moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
  })(modulePath) as BundledChannelContractApi;
}

function loadExternalChannelSecretContractFromRecord(
  record: PluginManifestRecord,
): BundledChannelSecretContractApi | undefined {
  const contractPath = resolvePluginContractApiPath(record.rootDir);
  if (!contractPath) {
    return undefined;
  }
  const opened = openBoundaryFileSync({
    absolutePath: contractPath,
    rootPath: record.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: record.origin !== "bundled",
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    return undefined;
  }
  const safePath = opened.path;
  fs.closeSync(opened.fd);
  try {
    const mod = loadPluginContractModule(safePath);
    if (mod.collectRuntimeConfigAssignments || mod.secretTargetRegistryEntries) {
      return mod;
    }
  } catch (error) {
    if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[channel-contract-api] failed to load ${record.id} contract ${safePath}: ${detail}\n`,
      );
    }
  }
  return undefined;
}

function recordOwnsChannel(record: PluginManifestRecord, channelId: string): boolean {
  return (
    record.channels.includes(channelId) ||
    Object.prototype.hasOwnProperty.call(record.channelConfigs ?? {}, channelId) ||
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
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
    params.env,
  );
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    workspaceDir,
    env: params.env,
  });
  return snapshot.plugins
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

export function loadChannelSecretContractApi(params: {
  channelId: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): BundledChannelSecretContractApi | undefined {
  const bundled = loadBundledChannelSecretContractApi(params.channelId);
  if (bundled) {
    return bundled;
  }
  const env = params.env ?? process.env;
  for (const record of listChannelSecretContractRecords({
    channelId: params.channelId,
    config: params.config,
    env,
    loadablePluginOrigins: params.loadablePluginOrigins,
  })) {
    const contract = loadExternalChannelSecretContractFromRecord(record);
    if (contract) {
      return contract;
    }
  }
  return undefined;
}

export function loadChannelSecretContractApiForRecord(
  record: PluginManifestRecord,
): BundledChannelSecretContractApi | undefined {
  if (record.origin === "bundled") {
    return loadBundledChannelSecretContractApi(record.id);
  }
  return loadExternalChannelSecretContractFromRecord(record);
}

export type BundledChannelSecurityContractApi = Pick<
  BundledChannelContractApi,
  "unsupportedSecretRefSurfacePatterns" | "collectUnsupportedSecretRefConfigCandidates"
>;

export function loadBundledChannelSecurityContractApi(
  channelId: string,
): BundledChannelSecurityContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["security-contract-api.js"]);
}

// Scans plugin manifest metadata without importing runtime entrypoints.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
  readPluginCacheFile,
} from "./plugin-cache-files.js";

// Plugin manifest files are small metadata descriptors. Bound reads to prevent
// a corrupted or hostile manifest from exhausting memory during metadata scan.
const PLUGIN_MANIFEST_METADATA_MAX_BYTES = 256 * 1024;

const log = createSubsystemLogger("plugins/manifest-metadata-scan");

type PluginManifestMetadataRecord = {
  pluginDir: string;
  manifest: Record<string, unknown>;
  origin?: string;
};

type CandidateDir = {
  pluginDir: string;
  rank: number;
  order: number;
  origin?: string;
};

const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
function listChildPluginDirs(
  root: string | undefined,
  rank: number,
  startOrder: number,
  origin: string,
): CandidateDir[] {
  if (!root || !pluginCacheExistsSync(root)) {
    return [];
  }
  const dirs: CandidateDir[] = [];
  let order = startOrder;
  try {
    const entries = readPluginCacheDirectory(root).toSorted((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push({ pluginDir: path.join(root, entry.name), rank, order: order++, origin });
      }
    }
  } catch {
    return [];
  }
  return dirs;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  const file = readPluginCacheFile({
    rootDir: path.dirname(filePath),
    relativePath: path.basename(filePath),
    rejectHardlinks: false,
    maxBytes: PLUGIN_MANIFEST_METADATA_MAX_BYTES,
  });
  const warn = (message: string) => {
    if (!file.metadataScanWarningEmitted) {
      file.metadataScanWarningEmitted = true;
      log.warn(message);
    }
  };
  if (!file.ok) {
    if (file.failure.reason === "path") {
      return undefined;
    }
    if ((pluginCacheStatSync(filePath)?.size ?? 0) > PLUGIN_MANIFEST_METADATA_MAX_BYTES) {
      warn(
        `Ignoring oversized plugin manifest at ${filePath}: file exceeds the ${PLUGIN_MANIFEST_METADATA_MAX_BYTES}-byte limit`,
      );
    } else {
      warn(
        `Ignoring unreadable plugin manifest at ${filePath}: ${formatErrorMessage(file.failure.error ?? file.failure.reason)}`,
      );
    }
    return undefined;
  }
  const result = parsePluginCacheJson(file, { json5: true });
  if (!result.ok) {
    warn(
      `Ignoring invalid plugin manifest at ${filePath}: failed to parse plugin manifest: ${formatErrorMessage(result.error)}`,
    );
    return undefined;
  }
  const parsed = result.value;
  if (!isRecord(parsed)) {
    warn(`Ignoring invalid plugin manifest at ${filePath}: plugin manifest must be an object`);
    return undefined;
  }
  return parsed;
}

function readManifestObject(pluginDir: string): Record<string, unknown> | undefined {
  return readJsonObject(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
}

function listPersistedIndexPluginDirs(env: NodeJS.ProcessEnv, startOrder: number): CandidateDir[] {
  const index = readPersistedInstalledPluginIndexSync({ env });
  if (!index) {
    return [];
  }

  const dirs: CandidateDir[] = [];
  let order = startOrder;
  for (const plugin of index.plugins) {
    const rootDir = normalizeTrimmedString(plugin.rootDir);
    if (!rootDir) {
      continue;
    }
    dirs.push({
      pluginDir: resolveHomeRelativePath(rootDir, { env }),
      rank: plugin.origin === "bundled" ? 3 : 1,
      order: order++,
      origin: normalizeTrimmedString(plugin.origin),
    });
  }
  return dirs;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    pluginCacheExistsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    pluginCacheExistsSync(path.join(packageRoot, "src")) &&
    pluginCacheExistsSync(path.join(packageRoot, "extensions"))
  );
}

function resolvePackageRootsForSourceManifestMetadata(): string[] {
  const roots: string[] = [];
  for (const params of [
    { argv1: process.argv[1] },
    { moduleUrl: import.meta.url },
  ] satisfies Array<{ argv1?: string; moduleUrl?: string }>) {
    const root = resolveOpenClawPackageRootSync(params);
    if (root && !roots.includes(root)) {
      roots.push(root);
    }
  }
  return roots;
}

function listSourceCheckoutPluginDirs(startOrder: number): CandidateDir[] {
  const dirs: CandidateDir[] = [];
  let order = startOrder;
  for (const packageRoot of resolvePackageRootsForSourceManifestMetadata()) {
    if (!isSourceCheckoutRoot(packageRoot)) {
      continue;
    }
    dirs.push(...listChildPluginDirs(path.join(packageRoot, "extensions"), 3, order, "source"));
    order = startOrder + dirs.length;
  }
  return dirs;
}

function uniqueCandidateDirs(candidates: CandidateDir[]): CandidateDir[] {
  const byPath = new Map<string, CandidateDir>();
  for (const candidate of candidates) {
    const key = pluginCacheRealpathSync(candidate.pluginDir) ?? path.resolve(candidate.pluginDir);
    const existing = byPath.get(key);
    if (!existing || candidate.rank < existing.rank || candidate.order < existing.order) {
      byPath.set(key, candidate);
    }
  }
  return [...byPath.values()].toSorted(
    (left, right) => left.rank - right.rank || left.order - right.order,
  );
}

/** Lists plugin manifest metadata from installed, bundled, and global plugin roots. */
export function listOpenClawPluginManifestMetadata(
  env: NodeJS.ProcessEnv = process.env,
): PluginManifestMetadataRecord[] {
  const snapshot = getGatewayPluginMetadataSnapshot();
  if (snapshot) {
    return [
      ...snapshot.plugins,
      ...(snapshot.bundledManifestRegistry?.plugins ?? []).filter(
        (plugin) => !snapshot.byPluginId.has(plugin.id),
      ),
    ].flatMap((plugin) => {
      const manifest = readManifestObject(plugin.rootDir);
      return manifest ? [{ pluginDir: plugin.rootDir, manifest, origin: plugin.origin }] : [];
    });
  }
  const candidates: CandidateDir[] = [];
  let order = 0;
  candidates.push(...listPersistedIndexPluginDirs(env, order));
  order = candidates.length;
  candidates.push(...listChildPluginDirs(resolveBundledPluginsDir(env), 2, order, "bundled"));
  order = candidates.length;
  candidates.push(...listSourceCheckoutPluginDirs(order));
  order = candidates.length;
  candidates.push(
    ...listChildPluginDirs(resolveDefaultPluginExtensionsDir(env), 4, order, "global"),
  );
  const uniqueCandidates = uniqueCandidateDirs(candidates);
  const byManifestId = new Map<string, CandidateDir>();
  const records: PluginManifestMetadataRecord[] = [];
  for (const candidate of uniqueCandidates) {
    const manifest = readManifestObject(candidate.pluginDir);
    if (!manifest) {
      continue;
    }
    const manifestId = normalizeTrimmedString(manifest.id);
    if (manifestId) {
      const existing = byManifestId.get(manifestId);
      if (existing && existing.rank <= candidate.rank) {
        continue;
      }
      byManifestId.set(manifestId, candidate);
    }
    records.push({ pluginDir: candidate.pluginDir, manifest, origin: candidate.origin });
  }
  return records.slice();
}

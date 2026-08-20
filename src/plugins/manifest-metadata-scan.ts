// Scans plugin manifest metadata without importing runtime entrypoints.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { hasNodeErrorCode, isNotFoundPathError } from "../infra/path-guards.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";

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
let manifestMetadataCache = new WeakMap<NodeJS.ProcessEnv, PluginManifestMetadataRecord[]>();

function clearManifestMetadataCache(): void {
  manifestMetadataCache = new WeakMap();
}

// Manifest metadata is process-stable; install/reload owners refresh it only
// through the shared plugin metadata lifecycle boundary.
registerPluginMetadataProcessMemoLifecycleClear(clearManifestMetadataCache);

function listChildPluginDirs(
  root: string | undefined,
  rank: number,
  startOrder: number,
  origin: string,
): CandidateDir[] {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const dirs: CandidateDir[] = [];
  let order = startOrder;
  try {
    const entries = fs
      .readdirSync(root, { withFileTypes: true })
      .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
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
  let raw: string;
  try {
    const { buffer } = readRegularFileSync({
      filePath,
      maxBytes: PLUGIN_MANIFEST_METADATA_MAX_BYTES,
    });
    raw = buffer.toString("utf-8");
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return undefined;
    }
    if (hasNodeErrorCode(error, "too-large")) {
      log.warn(
        `Ignoring oversized plugin manifest at ${filePath}: file exceeds the ${PLUGIN_MANIFEST_METADATA_MAX_BYTES}-byte limit`,
      );
    } else {
      log.warn(`Ignoring unreadable plugin manifest at ${filePath}: ${String(error)}`);
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonWithJson5Fallback(raw);
  } catch (error) {
    log.warn(
      `Ignoring invalid plugin manifest at ${filePath}: failed to parse plugin manifest: ${String(error)}`,
    );
    return undefined;
  }

  if (!isRecord(parsed)) {
    log.warn(`Ignoring invalid plugin manifest at ${filePath}: plugin manifest must be an object`);
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
    fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
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
    const key = resolveRealpathOrAbsolute(candidate.pluginDir);
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
  const cached = manifestMetadataCache.get(env);
  if (cached) {
    return cached.slice();
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
  manifestMetadataCache.set(env, records);
  return records.slice();
}

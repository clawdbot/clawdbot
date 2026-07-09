// Scans plugin manifest metadata without importing runtime entrypoints.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";

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
let manifestMetadataCache:
  | {
      key: string;
      records: PluginManifestMetadataRecord[];
    }
  | undefined;

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
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
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
  try {
    const parsed = parseJsonWithJson5Fallback(fs.readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readManifestObject(pluginDir: string): Record<string, unknown> | undefined {
  return readJsonObject(path.join(pluginDir, PLUGIN_MANIFEST_FILENAME));
}

function manifestFileFingerprint(pluginDir: string): string {
  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME);
  try {
    const stat = fs.statSync(manifestPath);
    return `${manifestPath}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${manifestPath}:missing`;
  }
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

function resolveComparablePath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function uniqueCandidateDirs(candidates: CandidateDir[]): CandidateDir[] {
  const byPath = new Map<string, CandidateDir>();
  for (const candidate of candidates) {
    const key = resolveComparablePath(candidate.pluginDir);
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
  const candidates: CandidateDir[] = [];
  let order = 0;
  candidates.push(...listPersistedIndexPluginDirs(env, order));
  order = candidates.length;
  candidates.push(...listChildPluginDirs(resolveBundledPluginsDir(env), 2, order, "bundled"));
  order = candidates.length;
  candidates.push(...listSourceCheckoutPluginDirs(order));
  order = candidates.length;
  candidates.push(
    ...listChildPluginDirs(path.join(resolveStateDir(env), "extensions"), 4, order, "global"),
  );

  const uniqueCandidates = uniqueCandidateDirs(candidates);
  const cacheKey = JSON.stringify(
    uniqueCandidates.map((candidate) => [
      candidate.pluginDir,
      candidate.rank,
      candidate.order,
      candidate.origin ?? "",
      manifestFileFingerprint(candidate.pluginDir),
    ]),
  );
  if (manifestMetadataCache?.key === cacheKey) {
    return manifestMetadataCache.records.slice();
  }

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
  manifestMetadataCache = { key: cacheKey, records };
  return records;
}

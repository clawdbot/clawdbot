import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

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

const OPENCLAW_PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveUserPath(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~" || value.startsWith("~/")) {
    const home = env.OPENCLAW_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
    return path.join(home, value.slice(2));
  }
  return path.resolve(value);
}

function resolveStateDir(env: NodeJS.ProcessEnv): string {
  const override = normalizeTrimmedString(env.OPENCLAW_STATE_DIR);
  if (override) {
    return resolveUserPath(override, env);
  }
  const home = env.OPENCLAW_HOME ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.join(home, ".openclaw");
}

function areBundledPluginsDisabled(env: NodeJS.ProcessEnv): boolean {
  const value = normalizeTrimmedString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS)?.toLowerCase();
  return value === "1" || value === "true";
}

function hasManifestDir(root: string | undefined): root is string {
  return Boolean(root && fs.existsSync(root));
}

function resolveBundledPluginRoot(env: NodeJS.ProcessEnv): string | undefined {
  if (areBundledPluginsDisabled(env)) {
    return undefined;
  }

  const override = normalizeTrimmedString(env.OPENCLAW_BUNDLED_PLUGINS_DIR);
  if (override) {
    return resolveUserPath(override, env);
  }

  const sourceRoot = path.join(OPENCLAW_PACKAGE_ROOT, "extensions");
  const runtimeRoot = path.join(OPENCLAW_PACKAGE_ROOT, "dist-runtime", "extensions");
  const distRoot = path.join(OPENCLAW_PACKAGE_ROOT, "dist", "extensions");
  return [sourceRoot, runtimeRoot, distRoot].find(hasManifestDir);
}

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

function listPersistedIndexPluginDirs(env: NodeJS.ProcessEnv, startOrder: number): CandidateDir[] {
  const index = readJsonObject(path.join(resolveStateDir(env), "plugins", "installs.json"));
  if (!index || !Array.isArray(index.plugins)) {
    return [];
  }

  const dirs: CandidateDir[] = [];
  let order = startOrder;
  for (const rawPlugin of index.plugins) {
    if (!isRecord(rawPlugin)) {
      continue;
    }
    const rootDir = normalizeTrimmedString(rawPlugin.rootDir);
    if (!rootDir) {
      continue;
    }
    dirs.push({
      pluginDir: resolveUserPath(rootDir, env),
      rank: rawPlugin.origin === "bundled" ? 3 : 1,
      order: order++,
      origin: normalizeTrimmedString(rawPlugin.origin),
    });
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

export function listOpenClawPluginManifestMetadata(
  env: NodeJS.ProcessEnv = process.env,
): PluginManifestMetadataRecord[] {
  const candidates: CandidateDir[] = [];
  let order = 0;
  candidates.push(...listPersistedIndexPluginDirs(env, order));
  order = candidates.length;
  candidates.push(...listChildPluginDirs(resolveBundledPluginRoot(env), 2, order, "bundled"));
  order = candidates.length;
  candidates.push(
    ...listChildPluginDirs(path.join(resolveStateDir(env), "extensions"), 4, order, "global"),
  );

  const byManifestId = new Map<string, CandidateDir>();
  const records: PluginManifestMetadataRecord[] = [];
  for (const candidate of uniqueCandidateDirs(candidates)) {
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
  return records;
}

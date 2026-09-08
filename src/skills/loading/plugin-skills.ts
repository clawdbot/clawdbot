// Plugin skill loaders discover and normalize skills exposed by plugin packages.
import fs from "node:fs";
import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isMissingPathError } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import {
  pluginCacheExistsSync,
  pluginCacheLstatSync,
  pluginCacheRealpathSync,
  readPluginCacheDirectory,
} from "../../plugins/plugin-cache-files.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { iteratePluginRootContributions } from "../../plugins/plugin-root-contributions.js";
import { isPathInside } from "../../security/scan-paths.js";
import { CONFIG_DIR } from "../../utils.js";

const log = createSubsystemLogger("skills");

type PluginSkillLinkType = "dir" | "junction";

export type PluginSkillRoot = {
  dir: string;
  rejectHardlinks: boolean;
};

// This tracks the generated SDK links we last published, not plugin metadata.
// Config and ACP availability can change the desired links without changing package files.
let lastDefaultPluginSkillsPublication: ReadonlyMap<string, string> | null = null;

registerPluginMetadataProcessMemoLifecycleClear(() => {
  lastDefaultPluginSkillsPublication = null;
});

export function resolvePluginSkillRoots(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  /** Override the plugin skills directory for testing. */
  pluginSkillsDir?: string;
}): PluginSkillRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    publishPluginSkills([], {
      pluginSkillsDir: params.pluginSkillsDir,
    });
    return [];
  }
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    workspaceDir,
    config: params.config,
    env: process.env,
  });
  return resolvePluginSkillRootsFromMetadata({ ...params, metadataSnapshot });
}

export function resolvePluginSkillRootsFromMetadata(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  pluginSkillsDir?: string;
  metadataSnapshot: PluginMetadataSnapshot;
}): PluginSkillRoot[] {
  return withPluginCache(getPluginMetadataSnapshotCache(params.metadataSnapshot), () =>
    resolvePluginSkillRootsInOwner(params),
  );
}

function resolvePluginSkillRootsInOwner(
  params: Parameters<typeof resolvePluginSkillRootsFromMetadata>[0],
): PluginSkillRoot[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    publishPluginSkills([], { pluginSkillsDir: params.pluginSkillsDir });
    return [];
  }
  const config = params.config ?? {};
  const metadataSnapshot = params.metadataSnapshot;
  const registry = metadataSnapshot.manifestRegistry;
  if (registry.plugins.length === 0) {
    publishPluginSkills([], {
      pluginSkillsDir: params.pluginSkillsDir,
    });
    return [];
  }
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config });
  const seen = new Set<string>();
  const resolved: PluginSkillRoot[] = [];

  for (const { record, roots } of iteratePluginRootContributions({
    metadataSnapshot,
    config,
    contribution: "skills",
    // ACP router skills should not be attached unless ACP can actually spawn.
    isAvailable: (candidate) => acpRuntimeAvailable || candidate.id !== "acpx",
  })) {
    const rejectHardlinks = shouldRejectHardlinkedPluginFiles({
      origin: record.origin,
      rootDir: record.rootDir,
    });
    for (const raw of roots) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!pluginCacheExistsSync(candidate)) {
        log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPluginSkillPathInside(record.rootDir, candidate)) {
        log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      const candidates =
        record.bundleFormat === "agent" ? collectAgentSkillTargets(candidate) : [candidate];
      for (const resolvedCandidate of candidates) {
        if (seen.has(resolvedCandidate)) {
          continue;
        }
        seen.add(resolvedCandidate);
        resolved.push({ dir: resolvedCandidate, rejectHardlinks });
      }
    }
  }

  publishPluginSkills(
    resolved.map((root) => root.dir),
    {
      pluginSkillsDir: params.pluginSkillsDir,
    },
  );

  return resolved;
}

function isPluginSkillPathInside(rootDir: string, candidate: string): boolean {
  if (!isPathInside(rootDir, candidate)) {
    return false;
  }
  const rootRealPath = pluginCacheRealpathSync(rootDir);
  const candidateRealPath = pluginCacheRealpathSync(candidate);
  return Boolean(
    rootRealPath && candidateRealPath && isPathInside(rootRealPath, candidateRealPath),
  );
}

function listSkillChildDirectories(dir: string): Array<{ name: string; path: string }> {
  try {
    return readPluginCacheDirectory(dir)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }));
  } catch {
    return [];
  }
}

function collectAgentSkillTargets(skillsRoot: string): string[] {
  const targets: string[] = [];
  for (const entry of listSkillChildDirectories(skillsRoot)) {
    if (hasPublishableSkillFile({ skillDir: entry.path, rootDir: skillsRoot })) {
      targets.push(entry.path);
      continue;
    }
    log.warn(`agent plugin skill skipped because SKILL.md is missing or invalid: ${entry.path}`);
  }
  return targets;
}

function resolveDefaultPluginSkillsDir(): string {
  return path.join(CONFIG_DIR, "plugin-skills");
}

function resolvePluginSkillLinkType(
  platform: NodeJS.Platform = process.platform,
): PluginSkillLinkType {
  return platform === "win32" ? "junction" : "dir";
}

/**
 * Collect skill dir targets from a resolved directory.
 * If the directory contains a direct SKILL.md it is published as-is.
 * Otherwise child subdirectories that contain SKILL.md are expanded.
 */
function collectSkillTargets(dir: string, targets: Map<string, string>): void {
  if (hasPublishableSkillFile({ skillDir: dir, rootDir: dir })) {
    const basename = path.basename(dir);
    const existing = targets.get(basename);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${basename}" resolves to both ${existing} and ${dir}; ` +
          `only the first will be published`,
      );
      return;
    }
    targets.set(basename, dir);
    return;
  }

  for (const entry of listSkillChildDirectories(dir)) {
    const childPath = entry.path;
    if (!hasPublishableSkillFile({ skillDir: childPath, rootDir: dir })) {
      continue;
    }
    const basename = entry.name;
    const existing = targets.get(basename);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${basename}" resolves to both ${existing} and ${childPath}; ` +
          `only the first will be published`,
      );
      continue;
    }
    targets.set(basename, childPath);
  }
}

function hasPublishableSkillFile(params: { skillDir: string; rootDir: string }): boolean {
  const skillMd = path.join(params.skillDir, "SKILL.md");
  const skillMdStat = pluginCacheLstatSync(skillMd);
  if (!skillMdStat) {
    return false;
  }
  if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
    log.warn(`plugin skill SKILL.md is not a regular file: ${skillMd}`);
    return false;
  }
  if (!isPluginSkillPathInside(params.rootDir, skillMd)) {
    log.warn(`plugin skill SKILL.md escapes declared skill root: ${skillMd}`);
    return false;
  }
  return true;
}

/**
 * Creates symlinks from each resolved plugin skill directory into the
 * plugin skills directory (~/.openclaw/plugin-skills/) so the agent SDK can
 * discover them at the conventional file-system path.
 *
 * The plugin-skills directory is fully owned by OpenClaw — every entry is
 * a generated symlink. Cleanup of stale links is therefore safe.
 */
function publishPluginSkills(skillDirs: string[], opts?: { pluginSkillsDir?: string }): void {
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolveDefaultPluginSkillsDir();
  const managedTargets = new Map<string, string>();

  // Collect basename → target mappings, reporting collisions.
  // Directories that contain SKILL.md are published as-is.
  // Parent containers (e.g. ./skills/) are expanded to their child
  // directories that each contain a SKILL.md.
  for (const dir of skillDirs) {
    collectSkillTargets(dir, managedTargets);
  }

  if (
    opts?.pluginSkillsDir === undefined &&
    lastDefaultPluginSkillsPublication?.size === managedTargets.size &&
    [...managedTargets].every(
      ([name, target]) => lastDefaultPluginSkillsPublication?.get(name) === target,
    )
  ) {
    return;
  }

  // Plugin skill symlinks are owned by OpenClaw and publish at extra-dir
  // precedence, so they never shadow managed or bundled skills.
  for (const [name, target] of managedTargets) {
    const linkPath = path.join(pluginSkillsDir, name);
    try {
      fs.mkdirSync(pluginSkillsDir, { recursive: true });
    } catch {
      // best-effort; symlink will fail below if dir is truly unusable
    }
    try {
      const existingEntry = fs.lstatSync(linkPath);
      if (existingEntry.isSymbolicLink()) {
        const existingTarget = fs.readlinkSync(linkPath);
        if (existingTarget === target) {
          continue;
        }
        removeGeneratedPluginSkillEntry(linkPath);
      } else if (isGeneratedPluginSkillEntry(existingEntry)) {
        removeGeneratedPluginSkillEntry(linkPath);
      } else {
        log.warn(`plugin skill entry is not a generated symlink: ${linkPath}`);
        continue;
      }
    } catch (err) {
      if (!isMissingPathError(err)) {
        log.warn(`failed to inspect plugin skill symlink "${linkPath}": ${String(err)}`);
        continue;
      }
    }
    try {
      fs.symlinkSync(target, linkPath, resolvePluginSkillLinkType());
    } catch (err) {
      log.warn(`failed to create plugin skill symlink "${linkPath}" → "${target}": ${String(err)}`);
    }
  }

  // Clean up stale symlinks for plugin skills that are no longer active.
  // The plugin-skills directory is fully owned by OpenClaw: every entry is a
  // generated symlink, so stale-link removal is safe without extra proof.
  let existingEntries: fs.Dirent[];
  try {
    existingEntries = fs.readdirSync(pluginSkillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of existingEntries) {
    if (!isGeneratedPluginSkillEntry(entry)) {
      continue;
    }
    if (managedTargets.has(entry.name)) {
      continue;
    }
    const linkPath = path.join(pluginSkillsDir, entry.name);
    removeGeneratedPluginSkillEntry(linkPath);
  }
  if (opts?.pluginSkillsDir === undefined) {
    lastDefaultPluginSkillsPublication = managedTargets;
  }
}

function isGeneratedPluginSkillEntry(
  entry: Pick<fs.Dirent, "isDirectory" | "isSymbolicLink">,
): boolean {
  // Windows directory symlinks are junctions and lstat reports them as directories.
  return entry.isSymbolicLink() || (process.platform === "win32" && entry.isDirectory());
}

function removeGeneratedPluginSkillEntry(linkPath: string): void {
  try {
    const entry = fs.lstatSync(linkPath);
    if (entry.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      return;
    }
  } catch (err) {
    if (isMissingPathError(err)) {
      return;
    }
  }
  try {
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

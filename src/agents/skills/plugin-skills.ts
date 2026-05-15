import fs from "node:fs";
import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { walkDirectorySync } from "../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../../plugins/config-policy.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { hasKind } from "../../plugins/slots.js";
import { isPathInsideWithRealpath } from "../../security/scan-paths.js";
import { CONFIG_DIR } from "../../utils.js";

const log = createSubsystemLogger("skills");

type PluginSkillLinkType = "dir" | "junction";

export function resolvePluginSkillDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  /** Override the plugin skills directory for testing. */
  pluginSkillsDir?: string;
}): string[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    publishPluginSkills([], {
      pluginSkillsDir: params.pluginSkillsDir,
    });
    return [];
  }
  const config = params.config ?? {};
  const metadataSnapshot =
    getCurrentPluginMetadataSnapshot({
      config,
      env: process.env,
      workspaceDir,
    }) ??
    loadPluginMetadataSnapshot({
      workspaceDir,
      config,
      env: process.env,
    });
  const registry = metadataSnapshot.manifestRegistry;
  if (registry.plugins.length === 0) {
    publishPluginSkills([], {
      pluginSkillsDir: params.pluginSkillsDir,
    });
    return [];
  }
  const normalizedPlugins = normalizePluginsConfigWithResolver(
    config.plugins,
    metadataSnapshot.normalizePluginId,
  );
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config });
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const record of registry.plugins) {
    if (!record.skills || record.skills.length === 0) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: config,
      enabledByDefault: record.enabledByDefault,
    });
    if (!activationState.activated) {
      continue;
    }
    // ACP router skills should not be attached unless ACP can actually spawn.
    if (!acpRuntimeAvailable && record.id === "acpx") {
      continue;
    }
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      continue;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      selectedMemoryPluginId = record.id;
    }
    for (const raw of record.skills) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!fs.existsSync(candidate)) {
        log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPathInsideWithRealpath(record.rootDir, candidate, { requireRealpath: true })) {
        log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push(candidate);
    }
  }

  publishPluginSkills(resolved, {
    pluginSkillsDir: params.pluginSkillsDir,
  });

  return resolved;
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

  const entries = walkDirectorySync(dir, {
    maxDepth: 1,
    symlinks: "skip",
    include: (entry) => entry.kind === "directory",
  }).entries;
  for (const entry of entries) {
    const childPath = entry.path;
    if (!hasPublishableSkillFile({ skillDir: childPath, rootDir: dir })) continue;
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
  let skillMdStat: fs.Stats;
  try {
    skillMdStat = fs.lstatSync(skillMd);
  } catch {
    return false;
  }
  if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
    log.warn(`plugin skill SKILL.md is not a regular file: ${skillMd}`);
    return false;
  }
  if (!isPathInsideWithRealpath(params.rootDir, skillMd, { requireRealpath: true })) {
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
      if (!isNotFoundError(err)) {
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
}

function isGeneratedPluginSkillEntry(
  entry: Pick<fs.Dirent, "isDirectory" | "isSymbolicLink">,
): boolean {
  // Windows directory symlinks are junctions and lstat reports them as directories.
  return entry.isSymbolicLink() || (process.platform === "win32" && entry.isDirectory());
}

function removeGeneratedPluginSkillEntry(linkPath: string): void {
  try {
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as Record<string, unknown>).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export const __testing = {
  isGeneratedPluginSkillEntry,
  publishPluginSkills,
  resolvePluginSkillLinkType,
};

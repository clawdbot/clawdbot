import os from "node:os";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOsHomeDir } from "../../infra/home-dir.js";
import { isPathInside } from "../../infra/path-guards.js";
import { resolveConfigDir } from "../../utils.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import type { Skill } from "./skill-contract.js";
import { tryRealpath } from "./symlink-targets.js";

/** Workspace sync excludes repository internals and installed dependencies at every depth. */
export function shouldSyncSkillPath(filePath: string): boolean {
  const name = path.basename(filePath);
  return name !== ".git" && name !== "node_modules";
}

/** Resolve the effective user home used by skill discovery. */
export function resolveSkillsUserHomeDir(): string | undefined {
  return resolveOsHomeDir(process.env, os.homedir);
}

function resolveNativeUserHomeDir(): string | undefined {
  try {
    return path.resolve(os.homedir());
  } catch {
    return undefined;
  }
}

function resolveCompactHomePrefixes(): string[] {
  const homes = [resolveSkillsUserHomeDir(), resolveNativeUserHomeDir()].filter(
    (home): home is string => Boolean(home),
  );
  const resolvedHomes = homes.map((home) => path.resolve(home));
  const realHomes = resolvedHomes
    .map((home) => tryRealpath(home))
    .filter((home): home is string => Boolean(home));
  return uniqueStrings([...resolvedHomes, ...realHomes])
    .toSorted((a, b) => b.length - a.length)
    .flatMap(compactHomePrefixesForHome);
}

/** Compact prompt-facing skill paths while preserving managed paths that `~` cannot reach. */
export function compactPromptSkills(
  skills: Skill[],
  options: { config?: OpenClawConfig; agentId?: string } = {},
): Skill[] {
  const prefixes = resolveCompactHomePrefixes();
  if (prefixes.length === 0) {
    return skills;
  }
  const preservedRoots = resolvePreservedPromptSkillPathRoots(options);
  const tildeRoots = resolvePromptTildeRoots();
  return skills.map((skill) => ({
    ...skill,
    filePath: shouldPreservePromptSkillPath(skill.filePath, preservedRoots, tildeRoots)
      ? skill.filePath
      : compactHomePath(skill.filePath, prefixes),
  }));
}

function resolvePreservedPromptSkillPathRoots(options: {
  config?: OpenClawConfig;
  agentId?: string;
}): string[] {
  const configDir = resolveConfigDir();
  const promptSkillDirs = [
    ...(options.config && options.agentId
      ? [resolveWorkshopSkillsDir(options.config, options.agentId)]
      : []),
    path.resolve(configDir, "skills"),
    path.resolve(configDir, "plugin-skills"),
  ];
  const realPromptSkillDirs = promptSkillDirs
    .map((dir) => tryRealpath(dir))
    .filter((dir): dir is string => Boolean(dir));
  return uniqueStrings([...promptSkillDirs, ...realPromptSkillDirs]);
}

function resolvePromptTildeRoots(): string[] {
  const nativeHome = resolveNativeUserHomeDir();
  if (!nativeHome) {
    return [];
  }
  const resolvedNativeHome = path.resolve(nativeHome);
  if (isContainerStateHomeWherePromptTildeEscapes(resolvedNativeHome)) {
    return [];
  }
  const realNativeHome = tryRealpath(resolvedNativeHome);
  return uniqueStrings([resolvedNativeHome, ...(realNativeHome ? [realNativeHome] : [])]);
}

function isContainerStateHomeWherePromptTildeEscapes(home: string): boolean {
  const configDir = path.resolve(resolveConfigDir());
  return (
    home === "/data" &&
    (configDir === "/data/.openclaw" || isPathInside("/data/.openclaw", configDir))
  );
}

function shouldPreservePromptSkillPath(
  filePath: string,
  roots: readonly string[],
  tildeRoots: readonly string[],
): boolean {
  const resolvedFilePath = path.resolve(filePath);
  const isManagedPromptSkillPath = roots.some(
    (root) => resolvedFilePath === root || isPathInside(root, resolvedFilePath),
  );
  if (!isManagedPromptSkillPath) {
    return false;
  }
  return !tildeRoots.some(
    (root) => resolvedFilePath === root || isPathInside(root, resolvedFilePath),
  );
}

function compactHomePath(filePath: string, prefixes: readonly string[]): string {
  for (const prefix of prefixes) {
    if (filePath.startsWith(prefix)) {
      return "~/" + normalizeCompactedSkillPath(filePath.slice(prefix.length), prefix);
    }
  }
  return filePath;
}

function compactHomePrefixesForHome(home: string): string[] {
  const prefixes = [home.endsWith(path.sep) ? home : home + path.sep];
  if (home.includes("\\") && !home.endsWith("\\")) {
    prefixes.push(home + "\\");
  }
  return prefixes;
}

function normalizeCompactedSkillPath(filePath: string, matchedHomePrefix: string): string {
  return matchedHomePrefix.includes("\\") ? filePath.replace(/\\/g, "/") : filePath;
}

/** Compact a skill path for console diagnostics. */
export function compactSkillPath(filePath: string): string {
  return compactHomePath(filePath, resolveCompactHomePrefixes());
}

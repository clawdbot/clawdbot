// Workspace skill loading helpers discover and load skills from workspace directories.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { walkDirectorySync } from "../../infra/fs-safe.js";
import { resolveOsHomeDir } from "../../infra/home-dir.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveConfigDir, resolveUserPath } from "../../utils.js";
import {
  resolveEffectiveAgentSkillFilter,
  resolveEffectiveAgentSkillsLimits,
} from "../discovery/agent-filter.js";
import { normalizeSkillFilter } from "../discovery/filter.js";
import { filterPromptVisibleSkillEntries } from "../discovery/skill-index.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { getArchivedSkillFiles } from "../workshop/curator.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { resolveBundledAllowlist, shouldIncludeSkill } from "./config.js";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";
import { loadSkillsFromDirSafe, readSkillFrontmatterSafe } from "./local-loader.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import { serializeByKey } from "./serialize.js";
import { formatSkillsForPrompt, type Skill } from "./skill-contract.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { resolveAllowedSkillSymlinkTargetRealPaths, tryRealpath } from "./symlink-targets.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");
const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const MAX_SKILL_SOURCE_ORIGIN_BYTES = 16 * 1024;

/**
 * Replace OS home directory prefixes with `~` in skill file paths to
 * reduce system prompt token usage while matching host file-tool expansion.
 *
 * Example: `/Users/alice/.bun/.../skills/github/SKILL.md`
 * → `~/.bun/.../skills/github/SKILL.md`
 *
 * Saves ~5–6 tokens per skill path × N skills ≈ 400–600 tokens total.
 */
function resolveUserHomeDir(): string | undefined {
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
  const homes = [resolveUserHomeDir(), resolveNativeUserHomeDir()].filter((home): home is string =>
    Boolean(home),
  );
  const resolvedHomes = homes.map((home) => path.resolve(home));
  const realHomes = resolvedHomes
    .map((home) => tryRealpath(home))
    .filter((home): home is string => Boolean(home));
  return uniqueStrings([...resolvedHomes, ...realHomes]).toSorted((a, b) => b.length - a.length);
}

function compactSkillPaths(skills: Skill[]): Skill[] {
  const homes = resolveCompactHomePrefixes();
  if (homes.length === 0) {
    return skills;
  }
  const preservedRoots = resolvePreservedPromptSkillPathRoots();
  const tildeRoots = resolvePromptTildeRoots();
  return skills.map((s) => ({
    ...s,
    filePath: shouldPreservePromptSkillPath(s.filePath, preservedRoots, tildeRoots)
      ? s.filePath
      : compactHomePath(s.filePath, homes),
  }));
}

function resolvePreservedPromptSkillPathRoots(): string[] {
  const configDir = resolveConfigDir();
  const promptSkillDirs = [
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

function compactHomePath(filePath: string, homes: readonly string[]): string {
  for (const home of homes) {
    for (const prefix of compactHomePrefixesForHome(home)) {
      if (filePath.startsWith(prefix)) {
        return "~/" + normalizeCompactedSkillPath(filePath.slice(prefix.length), prefix);
      }
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

function compactPathForConsoleMessage(filePath: string): string {
  return compactHomePath(filePath, resolveCompactHomePrefixes());
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  const bundledAllowlist = resolveBundledAllowlist(config);
  let filtered = entries.filter((entry) =>
    shouldIncludeSkill({ entry, config, bundledAllowlist, eligibility }),
  );
  // If skillFilter is provided, only include skills in the filter list.
  if (skillFilter !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    if (normalized.length > 0) {
      const allowed = new Set(normalized);
      filtered = filtered.filter((entry) => allowed.has(entry.skill.name));
    } else {
      filtered = [];
    }
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
}

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
const DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN = 1_000;
const DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN = 10_000;
// Match Codex's bounded recursive skills discovery without letting broad
// workspace roots turn into unbounded filesystem walks.
const MAX_GROUPED_SKILL_SCAN_DEPTH = 6;
const MAX_CONFIGURED_ROOT_GROUPED_SKILL_SCAN_DEPTH = 2;

type ResolvedSkillsLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
  maxSkillFileBytes: number;
};

type LoadedSkillRecord = {
  skill: Skill;
  frontmatter?: ParsedSkillFrontmatter;
  syncSourceDir?: string;
  syncDirName?: string;
};

type CandidateSkillDir = {
  skillDir: string;
  skillDirRealPath: string;
  name: string;
  skillMdRealPath: string;
};

type ChildDirectoryScan = {
  dirs: string[];
  scannedEntryCount: number;
  truncated: boolean;
};

type SkillDiscoveryBudget = {
  remainingDirectoryScans: number;
  remainingRawEntries: number;
  truncated: boolean;
};

function resolveSkillsLimits(config?: OpenClawConfig, agentId?: string): ResolvedSkillsLimits {
  const limits = config?.skills?.limits;
  const agentSkillsLimits = resolveEffectiveAgentSkillsLimits(config, agentId);
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars:
      agentSkillsLimits?.maxSkillsPromptChars ??
      limits?.maxSkillsPromptChars ??
      DEFAULT_MAX_SKILLS_PROMPT_CHARS,
    maxSkillFileBytes: limits?.maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  };
}

function listChildDirectories(
  dir: string,
  opts?: {
    followSymlinks?: boolean;
    maxCandidateDirs?: number;
    maxRawEntriesToScan?: number;
  },
): ChildDirectoryScan {
  const maxRawEntriesToScan =
    opts?.maxRawEntriesToScan === undefined
      ? resolveRawEntryScanLimit(opts?.maxCandidateDirs)
      : Math.max(0, opts.maxRawEntriesToScan);
  const scan = walkDirectorySync(dir, {
    maxDepth: 1,
    maxEntries: maxRawEntriesToScan,
    symlinks: opts?.followSymlinks === false ? "skip" : "follow",
    include: (entry) =>
      entry.kind === "directory" && !entry.name.startsWith(".") && entry.name !== "node_modules",
  });
  if (scan.scannedEntryCount === 0 && scan.entries.length === 0) {
    return { dirs: [], scannedEntryCount: 0, truncated: false };
  }
  return {
    dirs: scan.entries.map((entry) => entry.name),
    scannedEntryCount: scan.scannedEntryCount,
    truncated: scan.truncated,
  };
}

function resolveRawEntryScanLimit(maxCandidateDirs: number | undefined): number {
  if (maxCandidateDirs === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = Math.max(0, maxCandidateDirs);
  if (normalized === 0) {
    return 0;
  }
  return Math.min(
    DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN,
    Math.max(DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN, normalized * 10),
  );
}

function createSkillDiscoveryBudget(maxCandidateDirs: number): SkillDiscoveryBudget {
  const normalized = Math.max(0, maxCandidateDirs);
  return {
    remainingDirectoryScans: normalized * MAX_GROUPED_SKILL_SCAN_DEPTH,
    remainingRawEntries: resolveRawEntryScanLimit(normalized) * (normalized + 1),
    truncated: false,
  };
}

function listBudgetedChildDirectories(
  dir: string,
  budget: SkillDiscoveryBudget,
  opts: { followSymlinks?: boolean; maxCandidateDirs: number },
): ChildDirectoryScan {
  if (budget.remainingDirectoryScans <= 0 || budget.remainingRawEntries <= 0) {
    budget.truncated = true;
    return { dirs: [], scannedEntryCount: 0, truncated: false };
  }

  budget.remainingDirectoryScans -= 1;
  const maxRawEntriesToScan = Math.min(
    resolveRawEntryScanLimit(opts.maxCandidateDirs),
    budget.remainingRawEntries,
  );
  const scan = listChildDirectories(dir, {
    followSymlinks: opts.followSymlinks,
    maxCandidateDirs: opts.maxCandidateDirs,
    maxRawEntriesToScan,
  });
  budget.remainingRawEntries = Math.max(0, budget.remainingRawEntries - scan.scannedEntryCount);
  budget.truncated ||= scan.truncated;
  return scan;
}

function containsDiscoverableSkill(
  dir: string,
  opts: {
    maxCandidateDirs: number;
    maxSkillFileBytes?: number;
    skipTopLevelDirName?: string;
  },
): boolean {
  const discoveryBudget = createSkillDiscoveryBudget(opts.maxCandidateDirs);
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  for (const candidate of queue) {
    if (!candidate) {
      continue;
    }
    if (candidate.depth > 0 && fs.existsSync(path.join(candidate.dir, "SKILL.md"))) {
      if (hasLoadableSkillFrontmatter(dir, candidate.dir, opts.maxSkillFileBytes)) {
        return true;
      }
      continue;
    }
    if (candidate.depth >= MAX_GROUPED_SKILL_SCAN_DEPTH) {
      continue;
    }
    if (
      hasCandidateSymlinkChild(
        candidate.dir,
        candidate.depth === 0 ? opts.skipTopLevelDirName : undefined,
        resolveRawEntryScanLimit(opts.maxCandidateDirs),
      )
    ) {
      return true;
    }
    const childDirs = listBudgetedChildDirectories(candidate.dir, discoveryBudget, {
      followSymlinks: false,
      maxCandidateDirs: opts.maxCandidateDirs,
    }).dirs;
    for (const childDir of childDirs.toSorted().slice(0, opts.maxCandidateDirs)) {
      if (candidate.depth === 0 && childDir === opts.skipTopLevelDirName) {
        continue;
      }
      queue.push({ dir: path.join(candidate.dir, childDir), depth: candidate.depth + 1 });
    }
  }
  return false;
}

function hasCandidateSymlinkChild(
  dir: string,
  skipName: string | undefined,
  maxEntriesToScan: number,
): boolean {
  const maxEntries = Math.max(0, maxEntriesToScan);
  if (maxEntries === 0) {
    return false;
  }
  let handle: fs.Dir | undefined;
  try {
    handle = fs.opendirSync(dir);
    for (let scanned = 0; scanned < maxEntries; scanned += 1) {
      const entry = handle.readSync();
      if (!entry) {
        break;
      }
      if (entry.name === skipName || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      if (entry.isSymbolicLink()) {
        return true;
      }
    }
  } catch {
    return false;
  } finally {
    handle?.closeSync();
  }
  return false;
}

function hasLoadableSkillFrontmatter(
  rootDir: string,
  skillDir: string,
  maxSkillFileBytes?: number,
): boolean {
  const frontmatter = readSkillFrontmatterSafe({
    rootDir,
    filePath: path.join(skillDir, "SKILL.md"),
    maxBytes: maxSkillFileBytes ?? DEFAULT_MAX_SKILL_FILE_BYTES,
  });
  const fallbackName = path.basename(skillDir).trim();
  const name = frontmatter?.name?.trim() || fallbackName;
  return Boolean(name) && Boolean(frontmatter?.description?.trim());
}

function isSymlinkPath(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function buildEscapedSkillPathReason(params: { source: string; candidatePath: string }): {
  reason: string;
  consoleHint: string;
} {
  const candidateIsSymlink = isSymlinkPath(params.candidatePath);
  if (params.source === "openclaw-bundled" && candidateIsSymlink) {
    return {
      reason: "bundled-symlink-escape",
      consoleHint:
        "reason=bundled-symlink-escape hint=likely-stray-local-symlink-or-checkout-mutation",
    };
  }
  if (candidateIsSymlink) {
    return {
      reason: "symlink-escape",
      consoleHint: "reason=symlink-escape",
    };
  }
  if (params.source === "openclaw-bundled") {
    return {
      reason: "bundled-root-escape",
      consoleHint:
        "reason=bundled-root-escape hint=likely-stray-local-symlink-or-checkout-mutation",
    };
  }
  return {
    reason: "path-escape",
    consoleHint: "reason=path-escape",
  };
}

function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  const compactRootDir = compactPathForConsoleMessage(params.rootDir);
  const compactRootRealPath = compactPathForConsoleMessage(params.rootRealPath);
  const compactCandidatePath = compactPathForConsoleMessage(params.candidatePath);
  const compactCandidateRealPath = compactPathForConsoleMessage(params.candidateRealPath);
  const rootResolved =
    path.resolve(params.rootDir) === params.rootRealPath
      ? ""
      : ` rootResolved=${compactRootRealPath}`;
  const escapeReason = buildEscapedSkillPathReason({
    source: params.source,
    candidatePath: params.candidatePath,
  });
  skillsLogger.warn("Skipping escaped skill path outside its configured root.", {
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    path: params.candidatePath,
    realPath: params.candidateRealPath,
    reason: escapeReason.reason,
    consoleMessage:
      `Skipping escaped skill path outside its configured root: ` +
      `source=${params.source} root=${compactRootDir}${rootResolved} ` +
      `${escapeReason.consoleHint} requested=${compactCandidatePath} ` +
      `resolved=${compactCandidateRealPath}`,
  });
}

function resolveContainedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  allowedSymlinkTargetRealPaths?: readonly string[];
}): string | null {
  const candidateRealPath = tryRealpath(params.candidatePath);
  if (!candidateRealPath) {
    return null;
  }
  if (
    isPathInside(params.rootRealPath, candidateRealPath) ||
    isPathInsideAnyRoot(params.allowedSymlinkTargetRealPaths ?? [], candidateRealPath)
  ) {
    return candidateRealPath;
  }
  warnEscapedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    candidatePath: path.resolve(params.candidatePath),
    candidateRealPath,
  });
  return null;
}

function resolveNestedSkillsRoot(
  dir: string,
  opts?: {
    maxEntriesToScan?: number;
    maxSkillFileBytes?: number;
  },
): { baseDir: string; note?: string } {
  if (hasLoadableSkillFrontmatter(dir, dir, opts?.maxSkillFileBytes)) {
    return { baseDir: dir };
  }
  const rootSkillMdExists = fs.existsSync(path.join(dir, "SKILL.md"));
  const nested = path.join(dir, "skills");
  try {
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) {
      return { baseDir: dir };
    }
  } catch {
    return { baseDir: dir };
  }

  const scanLimit = Math.max(0, opts?.maxEntriesToScan ?? 100);
  if (
    !rootSkillMdExists &&
    containsDiscoverableSkill(dir, {
      maxCandidateDirs: scanLimit,
      maxSkillFileBytes: opts?.maxSkillFileBytes,
      skipTopLevelDirName: "skills",
    })
  ) {
    return { baseDir: dir };
  }

  // Heuristic: if `dir/skills` contains any discoverable SKILL.md within the
  // bounded skill depth, treat `dir/skills` as the real root. Use the same
  // child-directory filter as discovery so ignored folders cannot re-root.
  const discoveryBudget = createSkillDiscoveryBudget(scanLimit);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: nested, depth: 0 }];
  for (const candidate of queue) {
    if (!candidate) {
      continue;
    }
    if (hasLoadableSkillFrontmatter(nested, candidate.dir, opts?.maxSkillFileBytes)) {
      return { baseDir: nested, note: `Detected nested skills root at ${nested}` };
    }
    if (candidate.depth >= MAX_GROUPED_SKILL_SCAN_DEPTH) {
      continue;
    }
    const childDirs = listBudgetedChildDirectories(candidate.dir, discoveryBudget, {
      followSymlinks: false,
      maxCandidateDirs: scanLimit,
    }).dirs;
    for (const childDir of childDirs.toSorted().slice(0, scanLimit)) {
      queue.push({ dir: path.join(candidate.dir, childDir), depth: candidate.depth + 1 });
    }
  }
  return { baseDir: dir };
}

function unwrapLoadedSkillRecords(loaded: unknown): LoadedSkillRecord[] {
  if (Array.isArray(loaded)) {
    return (loaded as Skill[]).map((skill) => ({ skill }));
  }
  if (loaded && typeof loaded === "object" && "skills" in loaded) {
    const skills = (loaded as { skills?: unknown }).skills;
    if (Array.isArray(skills)) {
      const loadedResult = loaded as { frontmatterByFilePath?: unknown };
      const frontmatterByFilePath =
        loadedResult.frontmatterByFilePath instanceof Map
          ? (loadedResult.frontmatterByFilePath as ReadonlyMap<string, ParsedSkillFrontmatter>)
          : undefined;
      return (skills as Skill[]).map((skill) => ({
        skill,
        frontmatter: frontmatterByFilePath?.get(skill.filePath),
      }));
    }
  }
  return [];
}

function loadContainedSkillRecords(params: {
  skillDir: string;
  source: string;
  maxSkillFileBytes: number;
  canonicalSkillDir?: string;
}): LoadedSkillRecord[] {
  const expectedBaseDir = path.resolve(params.skillDir);
  const loaded = loadSkillsFromDirSafe({
    dir: params.skillDir,
    source: params.source,
    maxBytes: params.maxSkillFileBytes,
  });
  const records = unwrapLoadedSkillRecords(loaded).filter(
    (record) => path.resolve(record.skill.baseDir) === expectedBaseDir,
  );
  const canonicalSkillDir = params.canonicalSkillDir;
  return canonicalSkillDir
    ? records.map((record) => canonicalizeLoadedSkillRecord(record, canonicalSkillDir))
    : records;
}

function readSourceInstallSkillKey(skillDir: string): string | undefined {
  try {
    const sourceOriginPath = path.join(skillDir, SKILL_SOURCE_ORIGIN_RELATIVE_PATH);
    const stat = fs.lstatSync(sourceOriginPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_SOURCE_ORIGIN_BYTES) {
      return undefined;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    const sourceOriginRealPath = tryRealpath(sourceOriginPath);
    if (
      !skillDirRealPath ||
      !sourceOriginRealPath ||
      !isPathInside(skillDirRealPath, sourceOriginRealPath)
    ) {
      return undefined;
    }
    const raw = fs.readFileSync(sourceOriginPath, "utf8");
    const parsed = JSON.parse(raw) as { slug?: unknown };
    return normalizeOptionalString(parsed.slug);
  } catch {
    return undefined;
  }
}

function resolveSkillEntryMetadata(params: {
  frontmatter: ParsedSkillFrontmatter;
  skillDir: string;
}): OpenClawSkillMetadata | undefined {
  const metadata = resolveOpenClawMetadata(params.frontmatter);
  if (metadata?.skillKey) {
    return metadata;
  }
  const sourceInstallSkillKey = readSourceInstallSkillKey(params.skillDir);
  if (!sourceInstallSkillKey) {
    return metadata;
  }
  return {
    ...metadata,
    skillKey: sourceInstallSkillKey,
  };
}

function canonicalizeLoadedSkillRecord(
  record: LoadedSkillRecord,
  canonicalSkillDir: string,
): LoadedSkillRecord {
  const originalBaseDir = path.resolve(record.skill.baseDir);
  const canonicalBaseDir = path.resolve(canonicalSkillDir);
  if (originalBaseDir === canonicalBaseDir) {
    return record;
  }
  const filePath = path.join(
    canonicalBaseDir,
    path.relative(originalBaseDir, record.skill.filePath),
  );
  return {
    ...record,
    syncSourceDir: canonicalBaseDir,
    syncDirName: path.basename(originalBaseDir),
    skill: {
      ...record.skill,
      filePath,
      baseDir: canonicalBaseDir,
      sourceInfo: record.skill.sourceInfo
        ? {
            ...record.skill.sourceInfo,
            path: filePath,
            baseDir: canonicalBaseDir,
          }
        : record.skill.sourceInfo,
    },
  };
}

/**
 * Sets only the sync source directory for a skill record, without modifying
 * the baseDir or filePath. This is used for plugin skills where the symlink
 * path should be preserved for display purposes, but the real path is needed
 * for syncing to the sandbox workspace.
 */
function setSyncSourceForPluginSkill(
  record: LoadedSkillRecord,
  syncSourceDir: string,
): LoadedSkillRecord {
  return {
    ...record,
    syncSourceDir,
    syncDirName: path.basename(record.skill.baseDir),
  };
}

function isPathInsideAnyRoot(rootRealPaths: readonly string[], candidateRealPath: string): boolean {
  return rootRealPaths.some((rootRealPath) => isPathInside(rootRealPath, candidateRealPath));
}

function shouldEnforceConfiguredSkillRootContainment(source: string): boolean {
  return source !== "openclaw-managed" && source !== "agents-skills-personal";
}

function shouldUseConfiguredSymlinkTargets(source: string): boolean {
  return (
    source === "openclaw-workspace" ||
    source === "openclaw-extra" ||
    source === "agents-skills-project"
  );
}

function resolveSkillRootCandidatePath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  allowedSymlinkTargetRealPaths: readonly string[];
}): string | null {
  if (!shouldEnforceConfiguredSkillRootContainment(params.source)) {
    return tryRealpath(params.candidatePath);
  }
  return resolveContainedSkillPath({
    source: params.source,
    rootDir: params.rootDir,
    rootRealPath: params.rootRealPath,
    candidatePath: params.candidatePath,
    allowedSymlinkTargetRealPaths: shouldUseConfiguredSymlinkTargets(params.source)
      ? params.allowedSymlinkTargetRealPaths
      : [],
  });
}

function canonicalSkillDirForSource(source: string, skillDirRealPath: string): string | undefined {
  return shouldEnforceConfiguredSkillRootContainment(source) ? undefined : skillDirRealPath;
}

function resolveSkillFilePath(params: {
  source: string;
  skillDir: string;
  skillDirRealPath: string;
  candidatePath: string;
}): string | null {
  return resolveContainedSkillPath({
    source: params.source,
    rootDir: params.skillDir,
    rootRealPath: params.skillDirRealPath,
    candidatePath: params.candidatePath,
  });
}

function resolvePluginSkillRootRealPaths(pluginSkillDirs: readonly string[]): string[] {
  return uniqueStrings(
    pluginSkillDirs.map((dir) => tryRealpath(dir)).filter((dir): dir is string => Boolean(dir)),
  );
}

function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillDirs: readonly string[];
  source: string;
  limits: ResolvedSkillsLimits;
}): LoadedSkillRecord[] {
  const allowedRootRealPaths = resolvePluginSkillRootRealPaths(params.pluginSkillDirs);
  if (allowedRootRealPaths.length === 0) {
    return [];
  }

  const rootDir = path.resolve(params.pluginSkillsDir);
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const rootRealPath = tryRealpath(rootDir) ?? rootDir;
  const maxCandidatesPerRoot = Math.max(0, params.limits.maxCandidatesPerRoot);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const childDirScan = listChildDirectories(rootDir, {
    maxCandidateDirs: maxCandidatesPerRoot,
  });
  const childDirs =
    maxSkillsLoadedPerSource === 0
      ? []
      : childDirScan.dirs.toSorted().slice(0, maxCandidatesPerRoot);
  const loadedSkills: LoadedSkillRecord[] = [];

  for (const name of childDirs) {
    const skillDir = path.join(rootDir, name);
    if (!isSymlinkPath(skillDir)) {
      continue;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    if (!skillDirRealPath || !isPathInsideAnyRoot(allowedRootRealPaths, skillDirRealPath)) {
      if (skillDirRealPath) {
        warnEscapedSkillPath({
          source: params.source,
          rootDir,
          rootRealPath,
          candidatePath: path.resolve(skillDir),
          candidateRealPath: skillDirRealPath,
        });
      }
      continue;
    }

    const skillMd = path.join(skillDir, "SKILL.md");
    let skillMdStat: fs.Stats;
    try {
      skillMdStat = fs.lstatSync(skillMd);
    } catch {
      continue;
    }
    if (!skillMdStat.isFile() || skillMdStat.isSymbolicLink()) {
      continue;
    }
    const skillMdRealPath = tryRealpath(skillMd);
    if (!skillMdRealPath || !isPathInside(skillDirRealPath, skillMdRealPath)) {
      continue;
    }
    if (skillMdStat.size > params.limits.maxSkillFileBytes) {
      skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
        skill: name,
        filePath: skillMd,
        size: skillMdStat.size,
        maxSkillFileBytes: params.limits.maxSkillFileBytes,
      });
      continue;
    }

    // Plugin skills live as symlinks under ~/.openclaw/plugin-skills/, so
    // skillDir is the symlink path while skillDirRealPath is the real target.
    // We set syncSourceDir to the real path so syncSkillsToWorkspace can copy
    // the actual skill directory into the sandbox workspace, but we preserve
    // the symlink path as baseDir for display purposes.  Without this,
    // sandboxed agents see host-only symlink paths in <available_skills> and
    // every read of the SKILL.md fails with "Path escapes sandbox root".
    // skillDirRealPath is safe to use here because it was already validated
    // against allowedRootRealPaths above.
    const loadedRecords = loadContainedSkillRecords({
      skillDir,
      source: params.source,
      maxSkillFileBytes: params.limits.maxSkillFileBytes,
    });
    loadedSkills.push(
      ...loadedRecords.map((record) => setSyncSourceForPluginSkill(record, skillDirRealPath)),
    );
    if (loadedSkills.length >= maxSkillsLoadedPerSource) {
      break;
    }
  }

  if (loadedSkills.length > maxSkillsLoadedPerSource) {
    return loadedSkills
      .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
      .slice(0, maxSkillsLoadedPerSource);
  }
  return loadedSkills;
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    agentId?: string;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    workspaceOnly?: boolean;
    includeArchived?: boolean;
  },
): SkillEntry[] {
  const limits = resolveSkillsLimits(opts?.config, opts?.agentId);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(opts?.config);

  const loadSkills = (params: { dir: string; source: string }): LoadedSkillRecord[] => {
    const rootDir = path.resolve(params.dir);
    if (!fs.existsSync(rootDir)) {
      return [];
    }
    const rootRealPath = tryRealpath(rootDir) ?? rootDir;
    const resolved = resolveNestedSkillsRoot(params.dir, {
      maxEntriesToScan: limits.maxCandidatesPerRoot,
      maxSkillFileBytes: limits.maxSkillFileBytes,
    });
    const baseDir = resolved.baseDir;
    const baseDirRealPath = resolveSkillRootCandidatePath({
      source: params.source,
      rootDir,
      rootRealPath,
      candidatePath: baseDir,
      allowedSymlinkTargetRealPaths,
    });
    if (!baseDirRealPath) {
      return [];
    }

    // If the root itself is a skill directory, just load it directly (but enforce size cap).
    const rootSkillMd = path.join(baseDir, "SKILL.md");
    if (fs.existsSync(rootSkillMd)) {
      const rootSkillRealPath = resolveSkillFilePath({
        source: params.source,
        skillDir: baseDir,
        skillDirRealPath: baseDirRealPath,
        candidatePath: rootSkillMd,
      });
      if (!rootSkillRealPath) {
        return [];
      }
      try {
        const size = fs.statSync(rootSkillRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skills root due to oversized SKILL.md.", {
            dir: baseDir,
            filePath: rootSkillMd,
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return [];
        }
      } catch {
        return [];
      }

      return loadContainedSkillRecords({
        skillDir: baseDir,
        source: params.source,
        maxSkillFileBytes: limits.maxSkillFileBytes,
        canonicalSkillDir: canonicalSkillDirForSource(params.source, baseDirRealPath),
      });
    }

    const maxCandidatesPerRoot = Math.max(0, limits.maxCandidatesPerRoot);
    const maxSkillsLoadedPerSource = Math.max(0, limits.maxSkillsLoadedPerSource);
    const nestedSkillsRootPath = path.resolve(baseDir, "skills");
    const baseDirIsNestedSkillsRoot = path.resolve(baseDir) === path.resolve(rootDir, "skills");
    const baseDirLooksLikeSkillsRoot = path.basename(baseDir) === "skills";
    const discoveryBudget = createSkillDiscoveryBudget(maxCandidatesPerRoot);
    const childDirScan = listBudgetedChildDirectories(baseDir, discoveryBudget, {
      maxCandidateDirs: maxCandidatesPerRoot,
    });
    const childDirs = childDirScan.dirs;
    const suspicious = childDirScan.truncated;
    const sortedChildDirs = childDirs.toSorted();
    const limitedChildren =
      maxSkillsLoadedPerSource === 0 ? [] : sortedChildDirs.slice(0, maxCandidatesPerRoot);
    if (
      maxSkillsLoadedPerSource > 0 &&
      sortedChildDirs.includes("skills") &&
      !limitedChildren.includes("skills")
    ) {
      limitedChildren.push("skills");
    }

    if (suspicious) {
      skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        scannedEntryCount: childDirScan.scannedEntryCount,
        maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    } else if (childDirs.length > maxCandidatesPerRoot) {
      skillsLogger.warn("Skills root has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        childDirCount: childDirs.length,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
      });
    }

    const loadedSkills: LoadedSkillRecord[] = [];
    const loadCandidateSkill = ({
      skillDir,
      skillDirRealPath,
      name,
      skillMdRealPath,
    }: CandidateSkillDir) => {
      try {
        const size = fs.statSync(skillMdRealPath).size;
        if (size > limits.maxSkillFileBytes) {
          skillsLogger.warn("Skipping skill due to oversized SKILL.md.", {
            skill: name,
            filePath: path.join(skillDir, "SKILL.md"),
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          });
          return;
        }
      } catch {
        return;
      }

      loadedSkills.push(
        ...loadContainedSkillRecords({
          skillDir,
          source: params.source,
          maxSkillFileBytes: limits.maxSkillFileBytes,
          canonicalSkillDir: canonicalSkillDirForSource(params.source, skillDirRealPath),
        }),
      );
    };

    const skillCandidates: CandidateSkillDir[] = [];
    const scanQueue: Array<{ skillDir: string; name: string; depth: number }> = limitedChildren.map(
      (name) => ({
        skillDir: path.join(baseDir, name),
        name,
        depth: name === "skills" && !fs.existsSync(path.join(baseDir, name, "SKILL.md")) ? 0 : 1,
      }),
    );

    for (const candidate of scanQueue) {
      if (!candidate) {
        continue;
      }
      const skillDirRealPath = resolveSkillRootCandidatePath({
        source: params.source,
        rootDir,
        rootRealPath: baseDirRealPath,
        candidatePath: candidate.skillDir,
        allowedSymlinkTargetRealPaths,
      });
      if (!skillDirRealPath) {
        continue;
      }

      const skillMd = path.join(candidate.skillDir, "SKILL.md");
      if (fs.existsSync(skillMd)) {
        const skillMdRealPath = resolveSkillFilePath({
          source: params.source,
          skillDir: candidate.skillDir,
          skillDirRealPath,
          candidatePath: skillMd,
        });
        if (skillMdRealPath) {
          skillCandidates.push({
            skillDir: candidate.skillDir,
            skillDirRealPath,
            name: candidate.name,
            skillMdRealPath,
          });
        }
        continue;
      }

      const candidatePath = path.resolve(candidate.skillDir);
      const maxGroupedDepth =
        params.source === "openclaw-extra" &&
        !baseDirIsNestedSkillsRoot &&
        !baseDirLooksLikeSkillsRoot &&
        candidatePath !== nestedSkillsRootPath &&
        !isPathInside(nestedSkillsRootPath, candidatePath)
          ? MAX_CONFIGURED_ROOT_GROUPED_SKILL_SCAN_DEPTH
          : MAX_GROUPED_SKILL_SCAN_DEPTH;
      if (candidate.depth >= maxGroupedDepth) {
        continue;
      }

      const nestedChildScan = listBudgetedChildDirectories(candidate.skillDir, discoveryBudget, {
        maxCandidateDirs: maxCandidatesPerRoot,
      });
      const nestedChildren = nestedChildScan.dirs;
      const nestedSuspicious = nestedChildScan.truncated;
      if (nestedSuspicious) {
        skillsLogger.warn(
          "Nested skills directory looks suspiciously large, truncating discovery.",
          {
            dir: params.dir,
            baseDir,
            nestedDir: candidate.skillDir,
            nestedChildDirCount: nestedChildren.length,
            scannedEntryCount: nestedChildScan.scannedEntryCount,
            maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
            maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
            maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
            maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH,
          },
        );
      } else if (nestedChildren.length > maxCandidatesPerRoot) {
        skillsLogger.warn("Nested skills directory has many entries, truncating discovery.", {
          dir: params.dir,
          baseDir,
          nestedDir: candidate.skillDir,
          nestedChildDirCount: nestedChildren.length,
          maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
          maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
          maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH,
        });
      }

      for (const nestedName of nestedChildren.toSorted().slice(0, maxCandidatesPerRoot)) {
        scanQueue.push({
          skillDir: path.join(candidate.skillDir, nestedName),
          name: `${candidate.name}/${nestedName}`,
          depth: candidate.depth + 1,
        });
      }
    }

    for (const candidate of skillCandidates.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (loadedSkills.length >= maxSkillsLoadedPerSource) {
        break;
      }
      loadCandidateSkill(candidate);
    }

    if (discoveryBudget.truncated) {
      skillsLogger.warn("Skills root hit recursive discovery budget, truncating discovery.", {
        dir: params.dir,
        baseDir,
        maxCandidatesPerRoot: limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: limits.maxSkillsLoadedPerSource,
        maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH,
      });
    }

    if (loadedSkills.length > maxSkillsLoadedPerSource) {
      return loadedSkills
        .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
        .slice(0, maxSkillsLoadedPerSource);
    }

    return loadedSkills;
  };

  const workspaceOnly = opts?.workspaceOnly === true;
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const workspaceSkillsDir = path.resolve(workspaceDir, "skills");
  const bundledSkillsDir = workspaceOnly
    ? undefined
    : (opts?.bundledSkillsDir ?? resolveBundledSkillsDir());
  const pluginSkillsDir = opts?.pluginSkillsDir ?? path.join(CONFIG_DIR, "plugin-skills");
  const extraDirsRaw = workspaceOnly ? [] : (opts?.config?.skills?.load?.extraDirs ?? []);
  const extraDirs = normalizeTrimmedStringList(extraDirsRaw);
  const pluginSkillDirs = workspaceOnly
    ? []
    : resolvePluginSkillDirs({
        workspaceDir,
        config: opts?.config,
        pluginSkillsDir,
      });
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "openclaw-bundled",
      })
    : [];
  const extraSkills = [
    ...mergedExtraDirs.flatMap((dir) => {
      const resolved = resolveUserPath(dir);
      return loadSkills({
        dir: resolved,
        source: "openclaw-extra",
      });
    }),
    ...loadGeneratedPluginSkillRecords({
      pluginSkillsDir,
      pluginSkillDirs,
      source: "openclaw-extra",
      limits,
    }),
  ];
  const managedSkills = workspaceOnly
    ? []
    : loadSkills({
        dir: managedSkillsDir,
        source: "openclaw-managed",
      });
  const osHomeDir = resolveUserHomeDir();
  const personalAgentsSkillsDir = osHomeDir
    ? path.resolve(osHomeDir, ".agents", "skills")
    : path.resolve(".agents", "skills");
  const personalAgentsSkills = workspaceOnly
    ? []
    : loadSkills({
        dir: personalAgentsSkillsDir,
        source: "agents-skills-personal",
      });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = workspaceOnly
    ? []
    : loadSkills({
        dir: projectAgentsSkillsDir,
        source: "agents-skills-project",
      });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "openclaw-workspace",
  });

  const merged = new Map<string, LoadedSkillRecord>();
  const archivedSkillFiles = opts?.includeArchived ? null : getArchivedSkillFiles();
  const mergeRecord = (record: LoadedSkillRecord) => {
    if (archivedSkillFiles?.has(canonicalizePath(record.skill.filePath))) {
      return;
    }
    merged.set(record.skill.name, record);
  };
  // Precedence: extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
  for (const record of extraSkills) {
    mergeRecord(record);
  }
  for (const record of bundledSkills) {
    mergeRecord(record);
  }
  for (const record of managedSkills) {
    mergeRecord(record);
  }
  for (const record of personalAgentsSkills) {
    mergeRecord(record);
  }
  for (const record of projectAgentsSkills) {
    mergeRecord(record);
  }
  for (const record of workspaceSkills) {
    mergeRecord(record);
  }

  const skillEntries: SkillEntry[] = Array.from(merged.values())
    .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
    .map((record) => {
      const skill = record.skill;
      const frontmatter =
        record.frontmatter ??
        readSkillFrontmatterSafe({
          rootDir: skill.baseDir,
          filePath: skill.filePath,
          maxBytes: limits.maxSkillFileBytes,
        }) ??
        ({} as ParsedSkillFrontmatter);
      const invocation = resolveSkillInvocationPolicy(frontmatter);
      const entry: SkillEntry = {
        skill,
        frontmatter,
        metadata: resolveSkillEntryMetadata({ frontmatter, skillDir: skill.baseDir }),
        invocation,
        exposure: {
          includeInRuntimeRegistry: true,
          // Freshly loaded entries preserve the documented disable-model-invocation
          // contract, while legacy entries without exposure metadata still use
          // the centralized prompt visibility fallback.
          includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
          userInvocable: invocation.userInvocable ?? true,
        },
      };
      if (record.syncSourceDir !== undefined) {
        entry.syncSourceDir = record.syncSourceDir;
      }
      if (record.syncDirName !== undefined) {
        entry.syncDirName = record.syncDirName;
      }
      return entry;
    });
  return skillEntries;
}

function filterArchivedSkillEntries(entries: SkillEntry[]): SkillEntry[] {
  // One discovery-level query covers prompts, commands, runtime entries, and sandbox sync.
  const archivedSkillFiles = getArchivedSkillFiles();
  return entries.filter((entry) => !archivedSkillFiles.has(canonicalizePath(entry.skill.filePath)));
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const COMPACT_DESCRIPTION_MAX_CHARS = 220;
const COMPACT_DESCRIPTION_MIN_CHARS = 4;

function truncateSkillDescription(description: string, maxChars: number): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return truncateUtf16Safe(normalized, maxChars);
  }
  return `${truncateUtf16Safe(normalized, maxChars - 3).trimEnd()}...`;
}

/**
 * Compact skill catalog with descriptions bounded independently from identities.
 * A zero description budget preserves the previous name/location-only format.
 */
export function formatSkillsCompact(
  skills: Skill[],
  opts?: { descriptionMaxChars?: number },
): string {
  if (skills.length === 0) {
    return "";
  }
  const descriptionMaxChars = Math.max(
    0,
    Math.floor(opts?.descriptionMaxChars ?? COMPACT_DESCRIPTION_MAX_CHARS),
  );
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    descriptionMaxChars > 0
      ? "Use the read tool to load a skill's file when the task matches its name or description."
      : "Use the read tool to load a skill's file when the task matches its name.",
    "If a skill's <version> differs from a previous turn, re-read its SKILL.md before using it.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    if (descriptionMaxChars > 0) {
      const description = truncateSkillDescription(skill.description, descriptionMaxChars);
      if (description) {
        lines.push(`    <description>${escapeXml(description)}</description>`);
      }
    }
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    if (skill.locationNote) {
      lines.push(`    <location_note>${escapeXml(skill.locationNote)}</location_note>`);
    }
    if (skill.promptVersion) {
      lines.push(`    <version>${escapeXml(skill.promptVersion)}</version>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

type SkillsPromptFormat = { kind: "full" } | { kind: "compact"; descriptionMaxChars: number };

function buildSkillsLimitNote(params: {
  truncated: boolean;
  format: SkillsPromptFormat;
  included: number;
  total: number;
}): string {
  if (params.truncated) {
    const compactDetails =
      params.format.kind === "compact"
        ? ` (compact format, ${params.format.descriptionMaxChars > 0 ? "descriptions shortened" : "descriptions omitted"})`
        : "";
    return `⚠️ Skills truncated: included ${params.included} of ${params.total}${compactDetails}. Run \`openclaw skills check\` to audit.`;
  }
  if (params.format.kind === "compact") {
    const compactDetails =
      params.format.descriptionMaxChars > 0 ? "descriptions shortened" : "descriptions omitted";
    return `⚠️ Skills catalog using compact format (${compactDetails}). Run \`openclaw skills check\` to audit.`;
  }
  return "";
}

function buildRenderedSkillsPrompt(params: {
  remoteNote?: string;
  skills: Skill[];
  total: number;
  format: SkillsPromptFormat;
}): string {
  const truncated = params.skills.length < params.total;
  const limitNote = buildSkillsLimitNote({
    truncated,
    format: params.format,
    included: params.skills.length,
    total: params.total,
  });
  const catalog =
    params.format.kind === "compact"
      ? formatSkillsCompact(params.skills, {
          descriptionMaxChars: params.format.descriptionMaxChars,
        })
      : formatSkillsForPrompt(params.skills);
  return [params.remoteNote, limitNote, catalog].filter(Boolean).join("\n");
}

function applySkillsPromptLimits(params: {
  skills: Skill[];
  config?: OpenClawConfig;
  agentId?: string;
  remoteNote?: string;
}): {
  skillsForPrompt: Skill[];
  format: SkillsPromptFormat;
} {
  const limits = resolveSkillsLimits(params.config, params.agentId);
  const total = params.skills.length;
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));

  let skillsForPrompt = byCount;

  const fitsFull = (skills: Skill[]): boolean =>
    buildRenderedSkillsPrompt({
      remoteNote: params.remoteNote,
      skills,
      total,
      format: { kind: "full" },
    }).length <= limits.maxSkillsPromptChars;

  const fitsCompact = (skills: Skill[], descriptionMaxChars: number): boolean =>
    buildRenderedSkillsPrompt({
      remoteNote: params.remoteNote,
      skills,
      total,
      format: { kind: "compact", descriptionMaxChars },
    }).length <= limits.maxSkillsPromptChars;

  if (!fitsFull(skillsForPrompt)) {
    // Identity coverage takes priority over descriptions. Find the same largest
    // name/location/version prefix as the previous compact format before using
    // any leftover budget for trigger guidance.
    if (!fitsCompact(skillsForPrompt, 0)) {
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid), 0)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
    }

    let descriptionMaxChars = 0;
    if (skillsForPrompt.length > 0 && fitsCompact(skillsForPrompt, COMPACT_DESCRIPTION_MIN_CHARS)) {
      let lo = COMPACT_DESCRIPTION_MIN_CHARS;
      let hi = COMPACT_DESCRIPTION_MAX_CHARS;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt, mid)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      descriptionMaxChars = lo;
    }
    return { skillsForPrompt, format: { kind: "compact", descriptionMaxChars } };
  }

  return { skillsForPrompt, format: { kind: "full" } };
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, resolvedSkills } = resolveWorkspaceSkillPromptState(workspaceDir, opts);
  const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    ...(opts?.eligibility?.nodeSkills
      ? { nodeSkillsEligibility: opts.eligibility.nodeSkills }
      : {}),
    resolvedSkills,
    version: opts?.snapshotVersion,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): string {
  return resolveWorkspaceSkillPromptState(workspaceDir, opts).prompt;
}

export const testing = {
  compactHomePath,
};

type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  agentId?: string;
  /** If provided, only include skills with these names */
  skillFilter?: string[];
  eligibility?: SkillEligibilityContext;
};

function resolveEffectiveWorkspaceSkillFilter(
  opts?: WorkspaceSkillBuildOptions,
): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (!opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}

function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): {
  eligible: SkillEntry[];
  prompt: string;
  resolvedSkills: Skill[];
} {
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  if (effectiveSkillFilter !== undefined && effectiveSkillFilter.length === 0) {
    return { eligible: [], prompt: "", resolvedSkills: [] };
  }
  const skillEntries = opts?.entries
    ? filterArchivedSkillEntries(opts.entries)
    : mergeRemoteNodeSkillEntries(loadSkillEntries(workspaceDir, opts), {
        canExec: opts?.eligibility?.nodeSkills?.canExec,
        node: opts?.eligibility?.nodeSkills?.node,
      });
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    effectiveSkillFilter,
    opts?.eligibility,
  );
  const promptEntries = filterPromptVisibleSkillEntries(eligible);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  // Derive prompt-facing skills with compacted paths (e.g. ~/...) once.
  // Budget checks and final render both use this same representation so the
  // tier decision is based on the exact strings that end up in the prompt.
  // resolvedSkills keeps canonical paths for snapshot / runtime consumers.
  const promptSkills = compactSkillPaths(resolvedSkills).toSorted((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
  const { skillsForPrompt, format } = applySkillsPromptLimits({
    skills: promptSkills,
    config: opts?.config,
    agentId: opts?.agentId,
    remoteNote,
  });
  const prompt = buildRenderedSkillsPrompt({
    remoteNote,
    skills: skillsForPrompt,
    total: resolvedSkills.length,
    format,
  });
  return { eligible, prompt, resolvedSkills };
}

export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) {
    return snapshotPrompt;
  }
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
      agentId: params.agentId,
      eligibility: params.eligibility,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
    workspaceOnly?: boolean;
    includeArchived?: boolean;
  },
): SkillEntry[] {
  const entries = mergeRemoteNodeSkillEntries(loadSkillEntries(workspaceDir, opts), {
    canExec: opts?.eligibility?.nodeSkills?.canExec,
    node: opts?.eligibility?.nodeSkills?.node,
  });
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  if (effectiveSkillFilter === undefined && opts?.eligibility === undefined) {
    return entries;
  }
  return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}

export function loadVisibleWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  const entries = mergeRemoteNodeSkillEntries(loadSkillEntries(workspaceDir, opts), {
    canExec: opts?.eligibility?.nodeSkills?.canExec,
    node: opts?.eligibility?.nodeSkills?.node,
  });
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(entries, opts?.config, effectiveSkillFilter, opts?.eligibility);
}

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  let fallbackIndex = 10_000;
  let fallback = `${base}-${fallbackIndex}`;
  while (used.has(fallback)) {
    fallbackIndex += 1;
    fallback = `${base}-${fallbackIndex}`;
  }
  used.add(fallback);
  return fallback;
}

function resolveSyncedSkillDestinationPath(params: {
  targetSkillsDir: string;
  entry: SkillEntry;
  usedDirNames: Set<string>;
}): string | null {
  const sourceDirName = (
    params.entry.syncDirName ?? path.basename(params.entry.skill.baseDir)
  ).trim();
  if (!sourceDirName || sourceDirName === "." || sourceDirName === "..") {
    return null;
  }
  const uniqueDirName = resolveUniqueSyncedSkillDirName(sourceDirName, params.usedDirNames);
  return resolveSandboxPath({
    filePath: uniqueDirName,
    cwd: params.targetSkillsDir,
    root: params.targetSkillsDir,
  }).resolved;
}

async function prepareSyncedSkillsDirectory(targetSkillsDir: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = await fsp.lstat(targetSkillsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fsp.mkdir(targetSkillsDir, { recursive: true });
    return;
  }

  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });
    return;
  }

  for (const entry of await fsp.readdir(targetSkillsDir)) {
    await fsp.rm(path.join(targetSkillsDir, entry), { recursive: true, force: true });
  }
}

export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
}): Promise<SkillUsagePath[]> {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return [];
  }

  return await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    const entries = loadWorkspaceSkillEntries(sourceDir, {
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
      pluginSkillsDir: params.pluginSkillsDir,
    });

    await prepareSyncedSkillsDirectory(targetSkillsDir);

    const usedDirNames = new Set<string>();
    const skillUsagePaths: SkillUsagePath[] = [];
    for (const entry of entries) {
      let dest: string | null;
      try {
        dest = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!dest) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      try {
        const syncSourceDir = entry.syncSourceDir ?? entry.skill.baseDir;
        await fsp.cp(syncSourceDir, dest, {
          recursive: true,
          force: true,
          filter: (src) => {
            const name = path.basename(src);
            return !(name === ".git" || name === "node_modules");
          },
        });
        skillUsagePaths.push({
          readPath: path.join(dest, path.relative(entry.skill.baseDir, entry.skill.filePath)),
          skillFile: canonicalizePath(entry.skill.filePath),
          skillName: entry.skill.name,
          skillSource: resolveSkillTelemetrySource(entry.skill),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
    return skillUsagePaths;
  });
}

export function filterWorkspaceSkillEntriesWithOptions(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(entries, opts?.config, opts?.skillFilter, opts?.eligibility);
}
export { testing as __testing };
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

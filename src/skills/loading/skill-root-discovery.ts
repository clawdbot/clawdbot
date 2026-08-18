// Skill root discovery validates bounded filesystem candidates before loading skill records.
import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { walkDirectorySync } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { compactSkillPath } from "./skill-paths.js";
import { findContainingAllowedSkillSymlinkTarget, tryRealpath } from "./symlink-targets.js";

const skillsLogger = createSubsystemLogger("skills");

const DEFAULT_MAX_CANDIDATES_PER_ROOT = 300;
const DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE = 200;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
const DEFAULT_MIN_RAW_ENTRIES_PER_DIRECTORY_SCAN = 1_000;
const DEFAULT_MAX_RAW_ENTRIES_PER_DIRECTORY_SCAN = 10_000;
// Match Codex's bounded recursive skills discovery without letting broad
// workspace roots turn into unbounded filesystem walks.
const MAX_GROUPED_SKILL_SCAN_DEPTH = 6;
const MAX_CONFIGURED_ROOT_GROUPED_SKILL_SCAN_DEPTH = 2;

export type ResolvedSkillDiscoveryLimits = {
  maxCandidatesPerRoot: number;
  maxSkillsLoadedPerSource: number;
  maxSkillFileBytes: number;
};

export type CandidateSkillDir = {
  skillDir: string;
  skillDirRealPath: string;
  name: string;
  skillMdRealPath: string;
};

type DiscoveredSkillCandidates = {
  candidates: CandidateSkillDir[];
  rootIsSkill: boolean;
  configuredRootCandidate?: CandidateSkillDir;
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

export function resolveSkillDiscoveryLimits(config?: OpenClawConfig): ResolvedSkillDiscoveryLimits {
  const limits = config?.skills?.limits;
  return {
    maxCandidatesPerRoot: limits?.maxCandidatesPerRoot ?? DEFAULT_MAX_CANDIDATES_PER_ROOT,
    maxSkillsLoadedPerSource:
      limits?.maxSkillsLoadedPerSource ?? DEFAULT_MAX_SKILLS_LOADED_PER_SOURCE,
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

function hasSkillFileCandidate(skillDir: string): boolean {
  try {
    fs.lstatSync(path.join(skillDir, "SKILL.md"));
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
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
    skipTopLevelDirName?: string;
  },
): boolean {
  const discoveryBudget = createSkillDiscoveryBudget(opts.maxCandidateDirs);
  const queue: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
  for (const candidate of queue) {
    if (!candidate) {
      continue;
    }
    if (candidate.depth > 0 && hasSkillFileCandidate(candidate.dir)) {
      return true;
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
    return { reason: "symlink-escape", consoleHint: "reason=symlink-escape" };
  }
  if (params.source === "openclaw-bundled") {
    return {
      reason: "bundled-root-escape",
      consoleHint:
        "reason=bundled-root-escape hint=likely-stray-local-symlink-or-checkout-mutation",
    };
  }
  return { reason: "path-escape", consoleHint: "reason=path-escape" };
}

function warnEscapedSkillPath(params: {
  source: string;
  rootDir: string;
  rootRealPath: string;
  candidatePath: string;
  candidateRealPath: string;
}) {
  const compactRootDir = compactSkillPath(params.rootDir);
  const compactRootRealPath = compactSkillPath(params.rootRealPath);
  const compactCandidatePath = compactSkillPath(params.candidatePath);
  const compactCandidateRealPath = compactSkillPath(params.candidateRealPath);
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
    findContainingAllowedSkillSymlinkTarget(
      params.allowedSymlinkTargetRealPaths ?? [],
      candidateRealPath,
    ) !== null
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
  opts?: { maxEntriesToScan?: number },
): { baseDir: string; note?: string } {
  const rootSkillMdExists = hasSkillFileCandidate(dir);
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
      skipTopLevelDirName: "skills",
    })
  ) {
    return { baseDir: dir };
  }

  const discoveryBudget = createSkillDiscoveryBudget(scanLimit);
  const queue: Array<{ dir: string; depth: number }> = [{ dir: nested, depth: 0 }];
  for (const candidate of queue) {
    if (!candidate) {
      continue;
    }
    if (hasSkillFileCandidate(candidate.dir)) {
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

export function canonicalSkillDirForSource(
  source: string,
  skillDirRealPath: string,
): string | undefined {
  return shouldEnforceConfiguredSkillRootContainment(source) ? undefined : skillDirRealPath;
}

function resolveSkillFilePath(params: {
  source: string;
  skillDir: string;
  skillDirRealPath: string;
  candidatePath: string;
}): string | null {
  const resolved = resolveContainedSkillPath({
    source: params.source,
    rootDir: params.skillDir,
    rootRealPath: params.skillDirRealPath,
    candidatePath: params.candidatePath,
  });
  if (resolved || tryRealpath(params.candidatePath)) {
    return resolved;
  }
  // Let the root-scoped loader diagnose named paths that cannot be resolved.
  return path.resolve(params.candidatePath);
}

/** Discover validated skill directory candidates below one configured source root. */
export function discoverSkillCandidates(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
  allowedSymlinkTargetRealPaths: readonly string[];
}): DiscoveredSkillCandidates {
  const rootDir = path.resolve(params.dir);
  if (!fs.existsSync(rootDir)) {
    return { candidates: [], rootIsSkill: false };
  }
  const rootRealPath = tryRealpath(rootDir) ?? rootDir;
  const configuredRootSkillMd = path.join(rootDir, "SKILL.md");
  const resolved = resolveNestedSkillsRoot(params.dir, {
    maxEntriesToScan: params.limits.maxCandidatesPerRoot,
  });
  const baseDir = resolved.baseDir;
  const baseDirRealPath = resolveSkillRootCandidatePath({
    source: params.source,
    rootDir,
    rootRealPath,
    candidatePath: baseDir,
    allowedSymlinkTargetRealPaths: params.allowedSymlinkTargetRealPaths,
  });
  if (!baseDirRealPath) {
    return { candidates: [], rootIsSkill: false };
  }

  const rootSkillMd = path.join(baseDir, "SKILL.md");
  if (hasSkillFileCandidate(baseDir)) {
    const rootSkillRealPath = resolveSkillFilePath({
      source: params.source,
      skillDir: baseDir,
      skillDirRealPath: baseDirRealPath,
      candidatePath: rootSkillMd,
    });
    return {
      candidates: rootSkillRealPath
        ? [
            {
              skillDir: baseDir,
              skillDirRealPath: baseDirRealPath,
              name: path.basename(baseDir),
              skillMdRealPath: rootSkillRealPath,
            },
          ]
        : [],
      rootIsSkill: true,
    };
  }

  const maxCandidatesPerRoot = Math.max(0, params.limits.maxCandidatesPerRoot);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const nestedSkillsRootPath = path.resolve(baseDir, "skills");
  const baseDirIsNestedSkillsRoot = path.resolve(baseDir) === path.resolve(rootDir, "skills");
  const baseDirLooksLikeSkillsRoot = path.basename(baseDir) === "skills";
  const discoveryBudget = createSkillDiscoveryBudget(maxCandidatesPerRoot);
  const childDirScan = listBudgetedChildDirectories(baseDir, discoveryBudget, {
    maxCandidateDirs: maxCandidatesPerRoot,
  });
  const childDirs = childDirScan.dirs;
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

  if (childDirScan.truncated) {
    skillsLogger.warn("Skills root looks suspiciously large, truncating discovery.", {
      dir: params.dir,
      baseDir,
      childDirCount: childDirs.length,
      scannedEntryCount: childDirScan.scannedEntryCount,
      maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
    });
  } else if (childDirs.length > maxCandidatesPerRoot) {
    skillsLogger.warn("Skills root has many entries, truncating discovery.", {
      dir: params.dir,
      baseDir,
      childDirCount: childDirs.length,
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
    });
  }

  let configuredRootCandidate: CandidateSkillDir | undefined;
  if (path.resolve(baseDir) !== rootDir && hasSkillFileCandidate(rootDir)) {
    const configuredRootSkillRealPath = resolveSkillFilePath({
      source: params.source,
      skillDir: rootDir,
      skillDirRealPath: rootRealPath,
      candidatePath: configuredRootSkillMd,
    });
    if (configuredRootSkillRealPath) {
      configuredRootCandidate = {
        skillDir: rootDir,
        skillDirRealPath: rootRealPath,
        name: path.basename(rootDir),
        skillMdRealPath: configuredRootSkillRealPath,
      };
    }
  }
  const skillCandidates: CandidateSkillDir[] = [];
  const scanQueue: Array<{ skillDir: string; name: string; depth: number }> = limitedChildren.map(
    (name) => ({
      skillDir: path.join(baseDir, name),
      name,
      depth: name === "skills" && !hasSkillFileCandidate(path.join(baseDir, name)) ? 0 : 1,
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
      allowedSymlinkTargetRealPaths: params.allowedSymlinkTargetRealPaths,
    });
    if (!skillDirRealPath) {
      continue;
    }

    const skillMd = path.join(candidate.skillDir, "SKILL.md");
    if (hasSkillFileCandidate(candidate.skillDir)) {
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
    if (nestedChildScan.truncated) {
      skillsLogger.warn("Nested skills directory looks suspiciously large, truncating discovery.", {
        dir: params.dir,
        baseDir,
        nestedDir: candidate.skillDir,
        nestedChildDirCount: nestedChildren.length,
        scannedEntryCount: nestedChildScan.scannedEntryCount,
        maxEntriesToScan: resolveRawEntryScanLimit(maxCandidatesPerRoot),
        maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
        maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH,
      });
    } else if (nestedChildren.length > maxCandidatesPerRoot) {
      skillsLogger.warn("Nested skills directory has many entries, truncating discovery.", {
        dir: params.dir,
        baseDir,
        nestedDir: candidate.skillDir,
        nestedChildDirCount: nestedChildren.length,
        maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
        maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
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

  if (discoveryBudget.truncated) {
    skillsLogger.warn("Skills root hit recursive discovery budget, truncating discovery.", {
      dir: params.dir,
      baseDir,
      maxCandidatesPerRoot: params.limits.maxCandidatesPerRoot,
      maxSkillsLoadedPerSource: params.limits.maxSkillsLoadedPerSource,
      maxGroupedSkillScanDepth: MAX_GROUPED_SKILL_SCAN_DEPTH,
    });
  }

  return {
    candidates: skillCandidates.toSorted((a, b) => a.name.localeCompare(b.name)),
    rootIsSkill: false,
    ...(configuredRootCandidate ? { configuredRootCandidate } : {}),
  };
}

function resolvePluginSkillRootRealPaths(pluginSkillDirs: readonly string[]): string[] {
  return uniqueStrings(
    pluginSkillDirs.map((dir) => tryRealpath(dir)).filter((dir): dir is string => Boolean(dir)),
  );
}

/** Discover validated generated plugin-skill symlink candidates. */
export function discoverPluginSkills(params: {
  pluginSkillsDir: string;
  pluginSkillDirs: readonly string[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
}): CandidateSkillDir[] {
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
  const candidates: CandidateSkillDir[] = [];

  for (const name of childDirs) {
    const skillDir = path.join(rootDir, name);
    if (!isSymlinkPath(skillDir)) {
      continue;
    }
    const skillDirRealPath = tryRealpath(skillDir);
    if (
      !skillDirRealPath ||
      findContainingAllowedSkillSymlinkTarget(allowedRootRealPaths, skillDirRealPath) === null
    ) {
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
    candidates.push({ skillDir, skillDirRealPath, name, skillMdRealPath });
  }
  return candidates;
}

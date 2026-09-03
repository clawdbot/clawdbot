import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { ParsedSkillFrontmatter } from "../types.js";
import { loadSkillsFromDirSafe, type LocalSkillLoadDiagnostic } from "./local-loader.js";
import type { PluginSkillRoot } from "./plugin-skills.js";
import type { Skill } from "./skill-contract.js";
import { compactSkillPath } from "./skill-paths.js";
import {
  canonicalSkillDirForSource,
  discoverPluginSkills,
  discoverSkillCandidates,
  resolveSkillDiscoveryLimits,
  type CandidateSkillDir,
  type ResolvedSkillDiscoveryLimits,
} from "./skill-root-discovery.js";
import { resolveSkillTelemetrySourceValue } from "./source.js";
import { resolveAllowedSkillSymlinkTargetRealPaths, tryRealpath } from "./symlink-targets.js";

const skillsLogger = createSubsystemLogger("skills");

export type LoadedSkillRecord = {
  skill: Skill;
  frontmatter?: ParsedSkillFrontmatter;
  rejectHardlinks: boolean;
  syncSourceDir?: string;
  syncDirName?: string;
};

function warnInvalidSkill(source: string, diagnostic: LocalSkillLoadDiagnostic): void {
  skillsLogger.warn("Skipping invalid skill.", {
    source,
    filePath: diagnostic.path,
    error: diagnostic.message,
    consoleMessage:
      `Skipping invalid skill: file=${compactSkillPath(diagnostic.path)} ` +
      `error=${diagnostic.message}`,
  });
}

function loadContainedSkillRecords(params: {
  skillDir: string;
  source: string;
  maxSkillFileBytes: number;
  canonicalSkillDir?: string;
  rejectHardlinks: boolean;
}): LoadedSkillRecord[] {
  const expectedBaseDir = path.resolve(params.skillDir);
  const loaded = loadSkillsFromDirSafe({
    dir: params.skillDir,
    source: params.source,
    maxBytes: params.maxSkillFileBytes,
    rejectHardlinks: params.rejectHardlinks,
    onDiagnostic: (diagnostic) => warnInvalidSkill(params.source, diagnostic),
  });
  const records = loaded.skills
    .map((skill) => ({
      skill,
      frontmatter: loaded.frontmatterByFilePath.get(skill.filePath),
      rejectHardlinks: params.rejectHardlinks,
    }))
    .filter((record) => path.resolve(record.skill.baseDir) === expectedBaseDir);
  const canonicalSkillDir = params.canonicalSkillDir;
  return canonicalSkillDir
    ? records.map((record) => canonicalizeLoadedSkillRecord(record, canonicalSkillDir))
    : records;
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
        ? { ...record.skill.sourceInfo, path: filePath, baseDir: canonicalBaseDir }
        : record.skill.sourceInfo,
    },
  };
}

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

/** Loads one skill root under the configured discovery limits and symlink/hardlink policy. */
export function loadSkillRootRecords(params: {
  dir: string;
  source: string;
  config?: OpenClawConfig;
  rejectHardlinks?: boolean;
}): LoadedSkillRecord[] {
  const limits = resolveSkillDiscoveryLimits(params.config);
  const rejectHardlinks =
    params.rejectHardlinks ??
    shouldRejectHardlinkedPluginFiles({
      origin:
        resolveSkillTelemetrySourceValue(params.source) === "bundled" ? "bundled" : "workspace",
      rootDir: params.dir,
    });
  const discovered = discoverSkillCandidates({
    dir: params.dir,
    source: params.source,
    limits,
    allowedSymlinkTargetRealPaths: resolveAllowedSkillSymlinkTargetRealPaths(params.config),
  });
  const maxSkillsLoadedPerSource = Math.max(0, limits.maxSkillsLoadedPerSource);
  const loadCandidate = (candidate: CandidateSkillDir) =>
    loadContainedSkillRecords({
      skillDir: candidate.skillDir,
      source: params.source,
      maxSkillFileBytes: limits.maxSkillFileBytes,
      canonicalSkillDir: canonicalSkillDirForSource(params.source, candidate.skillDirRealPath),
      rejectHardlinks,
    });
  if (discovered.configuredRootCandidate) {
    const rootRecords = loadCandidate(discovered.configuredRootCandidate);
    if (rootRecords.length > 0) {
      return rootRecords;
    }
  }

  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of discovered.candidates) {
    if (!discovered.rootIsSkill && loadedSkills.length >= maxSkillsLoadedPerSource) {
      break;
    }
    loadedSkills.push(...loadCandidate(candidate));
  }
  if (loadedSkills.length > maxSkillsLoadedPerSource && !discovered.rootIsSkill) {
    return loadedSkills
      .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
      .slice(0, maxSkillsLoadedPerSource);
  }
  return loadedSkills;
}

export function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillRoots: readonly PluginSkillRoot[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
}): LoadedSkillRecord[] {
  const candidates = discoverPluginSkills({
    ...params,
    pluginSkillDirs: params.pluginSkillRoots.map((root) => root.dir),
  });
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of candidates) {
    const pluginRoot = params.pluginSkillRoots.find((root) => {
      const rootRealPath = tryRealpath(root.dir);
      return rootRealPath !== null && isPathInside(rootRealPath, candidate.skillDirRealPath);
    });
    const loadedRecords = loadContainedSkillRecords({
      skillDir: candidate.skillDir,
      source: params.source,
      maxSkillFileBytes: params.limits.maxSkillFileBytes,
      rejectHardlinks: pluginRoot?.rejectHardlinks ?? true,
    });
    loadedSkills.push(
      ...loadedRecords.map((record) =>
        setSyncSourceForPluginSkill(record, candidate.skillDirRealPath),
      ),
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

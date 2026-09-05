import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import {
  loadSingleSkillDirectory,
  type LoadedLocalSkill,
  type LocalSkillLoadDiagnostic,
} from "./local-loader.js";
import type { PluginSkillRoot } from "./plugin-skills.js";
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
import { resolveAllowedSkillSymlinkTargetRealPaths } from "./symlink-targets.js";

const skillsLogger = createSubsystemLogger("skills");

export type LoadedSkillRecord = Pick<LoadedLocalSkill, "skill" | "frontmatter"> & {
  syncSourceDir?: string;
  syncDirName?: string;
};

export function warnInvalidSkill(source: string, diagnostic: LocalSkillLoadDiagnostic): void {
  skillsLogger.warn("Skipping invalid skill.", {
    source,
    filePath: diagnostic.path,
    error: diagnostic.message,
    consoleMessage:
      `Skipping invalid skill: file=${compactSkillPath(diagnostic.path)} ` +
      `error=${diagnostic.message}`,
  });
}

function loadContainedSkillRecord(params: {
  skillDir: string;
  skillDirRealPath: string;
  source: string;
  maxSkillFileBytes: number;
  canonicalSkillDir?: string;
  rejectHardlinks: boolean;
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): LoadedSkillRecord | null {
  const loaded = loadSingleSkillDirectory({
    skillDir: params.skillDir,
    rootRealPath: params.skillDirRealPath,
    source: params.source,
    maxBytes: params.maxSkillFileBytes,
    rejectHardlinks: params.rejectHardlinks,
    onDiagnostic:
      params.onDiagnostic ?? ((diagnostic) => warnInvalidSkill(params.source, diagnostic)),
  });
  if (!loaded) {
    return null;
  }
  // Discovery selected one terminal SKILL.md; keep its parsed facts, not its content, in the cache.
  const record: LoadedSkillRecord = { skill: loaded.skill, frontmatter: loaded.frontmatter };
  const canonicalSkillDir = params.canonicalSkillDir;
  return canonicalSkillDir ? canonicalizeLoadedSkillRecord(record, canonicalSkillDir) : record;
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
  mode?: "audit";
  onDiagnostic?: (diagnostic: LocalSkillLoadDiagnostic) => void;
}): LoadedSkillRecord[] {
  const limits = resolveSkillDiscoveryLimits(params.config);
  if (params.mode === "audit") {
    // Prompt budgets must not hide installed skills. Keep larger configured
    // traversal bounds, and use the existing default file cap for audit reads.
    const defaults = resolveSkillDiscoveryLimits();
    limits.maxCandidatesPerRoot = Math.max(
      limits.maxCandidatesPerRoot,
      defaults.maxCandidatesPerRoot,
    );
    limits.maxSkillsLoadedPerSource = Math.max(
      limits.maxSkillsLoadedPerSource,
      defaults.maxSkillsLoadedPerSource,
    );
    limits.maxSkillFileBytes = defaults.maxSkillFileBytes;
  }
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
    onDiagnostic: params.onDiagnostic,
  });
  const maxSkillsLoadedPerSource = Math.max(0, limits.maxSkillsLoadedPerSource);
  const loadCandidate = (candidate: CandidateSkillDir) =>
    loadContainedSkillRecord({
      skillDir: candidate.skillDir,
      skillDirRealPath: candidate.skillDirRealPath,
      source: params.source,
      maxSkillFileBytes: limits.maxSkillFileBytes,
      canonicalSkillDir:
        params.mode === "audit"
          ? candidate.skillDirRealPath
          : canonicalSkillDirForSource(params.source, candidate.skillDirRealPath),
      rejectHardlinks,
      onDiagnostic: params.onDiagnostic,
    });
  if (discovered.configuredRootCandidate) {
    const rootRecord = loadCandidate(discovered.configuredRootCandidate);
    if (rootRecord) {
      return [rootRecord];
    }
  }

  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of discovered.candidates) {
    if (
      params.mode !== "audit" &&
      !discovered.rootIsSkill &&
      loadedSkills.length >= maxSkillsLoadedPerSource
    ) {
      break;
    }
    const record = loadCandidate(candidate);
    if (record) {
      loadedSkills.push(record);
    }
  }
  return loadedSkills;
}

export function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillRoots: readonly PluginSkillRoot[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
}): LoadedSkillRecord[] {
  const candidates = discoverPluginSkills(params);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of candidates) {
    const record = loadContainedSkillRecord({
      skillDir: candidate.skillDir,
      skillDirRealPath: candidate.skillDirRealPath,
      source: params.source,
      maxSkillFileBytes: params.limits.maxSkillFileBytes,
      rejectHardlinks: candidate.rejectHardlinks,
    });
    if (record) {
      loadedSkills.push(setSyncSourceForPluginSkill(record, candidate.skillDirRealPath));
    }
    if (loadedSkills.length >= maxSkillsLoadedPerSource) {
      break;
    }
  }
  return loadedSkills;
}

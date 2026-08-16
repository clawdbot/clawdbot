// Workspace skill loading turns validated discovery candidates into source-aware skill entries.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  isSessionSkillEnabled,
  resolveEffectiveAgentSkillFilter,
} from "../discovery/agent-filter.js";
import { normalizeSkillFilter } from "../discovery/filter.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillEntry,
} from "../types.js";
import { getArchivedSkillFiles } from "../workshop/curator.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { resolveBundledAllowlist, shouldIncludeSkill } from "./config.js";
import {
  resolveSkillManifestMetadata,
  resolveSkillInvocationPolicy,
  resolveSkillKey,
} from "./frontmatter.js";
import {
  loadSkillsFromDirSafe,
  readSkillFrontmatterSafe,
  type LocalSkillLoadDiagnostic,
} from "./local-loader.js";
import { resolvePluginSkillDirs } from "./plugin-skills.js";
import type { Skill } from "./skill-contract.js";
import { compactSkillPath, resolveSkillsUserHomeDir } from "./skill-paths.js";
import {
  canonicalSkillDirForSource,
  discoverPluginSkills,
  discoverSkillCandidates,
  resolveSkillDiscoveryLimits,
  type CandidateSkillDir,
  type ResolvedSkillDiscoveryLimits,
} from "./skill-root-discovery.js";
import { resolveAllowedSkillSymlinkTargetRealPaths, tryRealpath } from "./symlink-targets.js";

const skillsLogger = createSubsystemLogger("skills");
const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const MAX_SKILL_SOURCE_ORIGIN_BYTES = 16 * 1024;

type LoadedSkillRecord = {
  skill: Skill;
  frontmatter?: ParsedSkillFrontmatter;
  syncSourceDir?: string;
  syncDirName?: string;
};

function warnInvalidSkillFrontmatter(source: string, diagnostic: LocalSkillLoadDiagnostic): void {
  skillsLogger.warn("Skipping skill with invalid frontmatter.", {
    source,
    filePath: diagnostic.path,
    error: diagnostic.message,
    consoleMessage:
      `Skipping skill with invalid frontmatter: ` +
      `file=${compactSkillPath(diagnostic.path)} error=${diagnostic.message}`,
  });
}

function filterSkillEntries(
  entries: SkillEntry[],
  config?: OpenClawConfig,
  skillFilter?: string[],
  skillOverrides?: Readonly<Record<string, boolean>>,
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  const bundledAllowlist = resolveBundledAllowlist(config);
  let filtered = entries.filter((entry) =>
    shouldIncludeSkill({ entry, config, bundledAllowlist, eligibility }),
  );
  if (skillFilter !== undefined || skillOverrides !== undefined) {
    const normalized = normalizeSkillFilter(skillFilter) ?? [];
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    skillsLogger.debug(`Applying skill filter: ${label}`);
    const resolvedFilter = skillFilter === undefined ? undefined : normalized;
    filtered = filtered.filter((entry) =>
      isSessionSkillEnabled(
        entry.skill.name,
        resolvedFilter,
        skillOverrides,
        resolveSkillKey(entry.skill, entry),
      ),
    );
    skillsLogger.debug(
      `After skill filter: ${filtered.map((entry) => entry.skill.name).join(", ") || "(none)"}`,
    );
  }
  return filtered;
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
    onDiagnostic: (diagnostic) => warnInvalidSkillFrontmatter(params.source, diagnostic),
  });
  const records = loaded.skills
    .map((skill) => ({
      skill,
      frontmatter: loaded.frontmatterByFilePath.get(skill.filePath),
    }))
    .filter((record) => path.resolve(record.skill.baseDir) === expectedBaseDir);
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

export function resolveSkillEntryMetadata(params: {
  frontmatter: ParsedSkillFrontmatter;
  skillDir: string;
}): OpenClawSkillMetadata | undefined {
  const metadata = resolveSkillManifestMetadata(params.frontmatter);
  if (metadata?.skillKey) {
    return metadata;
  }
  const sourceInstallSkillKey = readSourceInstallSkillKey(params.skillDir);
  if (!sourceInstallSkillKey) {
    return metadata;
  }
  return { ...metadata, skillKey: sourceInstallSkillKey };
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

function isCandidateOversized(
  candidate: CandidateSkillDir,
  limits: ResolvedSkillDiscoveryLimits,
  rootIsSkill: boolean,
): boolean {
  try {
    const size = fs.statSync(candidate.skillMdRealPath).size;
    if (size <= limits.maxSkillFileBytes) {
      return false;
    }
    skillsLogger.warn(
      rootIsSkill
        ? "Skipping skills root due to oversized SKILL.md."
        : "Skipping skill due to oversized SKILL.md.",
      rootIsSkill
        ? {
            dir: candidate.skillDir,
            filePath: path.join(candidate.skillDir, "SKILL.md"),
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          }
        : {
            skill: candidate.name,
            filePath: path.join(candidate.skillDir, "SKILL.md"),
            size,
            maxSkillFileBytes: limits.maxSkillFileBytes,
          },
    );
    return true;
  } catch {
    return true;
  }
}

function loadDiscoveredSkillRecords(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
  allowedSymlinkTargetRealPaths: readonly string[];
}): LoadedSkillRecord[] {
  const discovered = discoverSkillCandidates(params);
  const loadedSkills: LoadedSkillRecord[] = [];
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  for (const candidate of discovered.candidates) {
    if (!discovered.rootIsSkill && loadedSkills.length >= maxSkillsLoadedPerSource) {
      break;
    }
    if (isCandidateOversized(candidate, params.limits, discovered.rootIsSkill)) {
      continue;
    }
    loadedSkills.push(
      ...loadContainedSkillRecords({
        skillDir: candidate.skillDir,
        source: params.source,
        maxSkillFileBytes: params.limits.maxSkillFileBytes,
        canonicalSkillDir: canonicalSkillDirForSource(params.source, candidate.skillDirRealPath),
      }),
    );
  }
  if (loadedSkills.length > maxSkillsLoadedPerSource && !discovered.rootIsSkill) {
    return loadedSkills
      .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
      .slice(0, maxSkillsLoadedPerSource);
  }
  return loadedSkills;
}

function loadGeneratedPluginSkillRecords(params: {
  pluginSkillsDir: string;
  pluginSkillDirs: readonly string[];
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
}): LoadedSkillRecord[] {
  const candidates = discoverPluginSkills(params);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const loadedSkills: LoadedSkillRecord[] = [];
  for (const candidate of candidates) {
    if (isCandidateOversized(candidate, params.limits, false)) {
      continue;
    }
    const loadedRecords = loadContainedSkillRecords({
      skillDir: candidate.skillDir,
      source: params.source,
      maxSkillFileBytes: params.limits.maxSkillFileBytes,
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
  const limits = resolveSkillDiscoveryLimits(opts?.config);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(opts?.config);
  const loadSkills = (params: { dir: string; source: string }): LoadedSkillRecord[] =>
    loadDiscoveredSkillRecords({ ...params, limits, allowedSymlinkTargetRealPaths });

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
    : resolvePluginSkillDirs({ workspaceDir, config: opts?.config, pluginSkillsDir });
  const mergedExtraDirs = [...extraDirs, ...pluginSkillDirs];

  const bundledSkills = bundledSkillsDir
    ? loadSkills({ dir: bundledSkillsDir, source: "openclaw-bundled" })
    : [];
  const extraSkills = [
    ...mergedExtraDirs.flatMap((dir) =>
      loadSkills({ dir: resolveUserPath(dir), source: "openclaw-extra" }),
    ),
    ...loadGeneratedPluginSkillRecords({
      pluginSkillsDir,
      pluginSkillDirs,
      source: "openclaw-extra",
      limits,
    }),
  ];
  const managedSkills = workspaceOnly
    ? []
    : loadSkills({ dir: managedSkillsDir, source: "openclaw-managed" });
  const osHomeDir = resolveSkillsUserHomeDir();
  const personalAgentsSkillsDir = osHomeDir
    ? path.resolve(osHomeDir, ".agents", "skills")
    : path.resolve(".agents", "skills");
  const personalAgentsSkills =
    workspaceOnly || !isDefaultStateDir()
      ? []
      : loadSkills({ dir: personalAgentsSkillsDir, source: "agents-skills-personal" });
  const projectAgentsSkillsDir = path.resolve(workspaceDir, ".agents", "skills");
  const projectAgentsSkills = workspaceOnly
    ? []
    : loadSkills({ dir: projectAgentsSkillsDir, source: "agents-skills-project" });
  const workspaceSkills = loadSkills({ dir: workspaceSkillsDir, source: "openclaw-workspace" });

  const merged = new Map<string, LoadedSkillRecord>();
  const archivedSkillFiles = opts?.includeArchived ? null : getArchivedSkillFiles();
  const mergeRecord = (record: LoadedSkillRecord) => {
    if (archivedSkillFiles?.has(canonicalizePath(record.skill.filePath))) {
      return;
    }
    merged.set(record.skill.name, record);
  };
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

  return Array.from(merged.values())
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
}

function filterArchivedSkillEntries(entries: SkillEntry[]): SkillEntry[] {
  const archivedSkillFiles = getArchivedSkillFiles();
  return entries.filter((entry) => !archivedSkillFiles.has(canonicalizePath(entry.skill.filePath)));
}

function resolveEffectiveWorkspaceSkillFilter(opts?: {
  config?: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
}): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (!opts?.config || !opts.agentId) {
    return undefined;
  }
  return resolveEffectiveAgentSkillFilter(opts.config, opts.agentId);
}

export function resolveWorkspaceSkillPromptEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    agentId?: string;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
  },
): { eligible: SkillEntry[]; skillFilter: string[] | undefined } {
  const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  const skillEntries = opts?.entries
    ? filterArchivedSkillEntries(opts.entries)
    : mergeRemoteNodeSkillEntries(loadSkillEntries(workspaceDir, opts), {
        canExec: opts?.eligibility?.nodeSkills?.canExec,
        node: opts?.eligibility?.nodeSkills?.node,
      });
  return {
    eligible: filterSkillEntries(
      skillEntries,
      opts?.config,
      skillFilter,
      opts?.skillOverrides,
      opts?.eligibility,
    ),
    skillFilter,
  };
}

export function loadWorkspaceSkills(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
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
  if (
    effectiveSkillFilter === undefined &&
    opts?.skillOverrides === undefined &&
    opts?.eligibility === undefined
  ) {
    return entries;
  }
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

export function loadVisibleSkills(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    agentId?: string;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  const entries = mergeRemoteNodeSkillEntries(loadSkillEntries(workspaceDir, opts), {
    canExec: opts?.eligibility?.nodeSkills?.canExec,
    node: opts?.eligibility?.nodeSkills?.node,
  });
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  return filterSkillEntries(
    entries,
    opts?.config,
    effectiveSkillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

export function filterWorkspaceSkills(
  entries: SkillEntry[],
  opts?: {
    config?: OpenClawConfig;
    skillFilter?: string[];
    skillOverrides?: Record<string, boolean>;
    eligibility?: SkillEligibilityContext;
  },
): SkillEntry[] {
  return filterSkillEntries(
    entries,
    opts?.config,
    opts?.skillFilter,
    opts?.skillOverrides,
    opts?.eligibility,
  );
}

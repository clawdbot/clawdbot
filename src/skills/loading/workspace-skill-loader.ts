// Workspace skill loading turns validated discovery candidates into source-aware skill entries.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import {
  isSessionSkillEnabled,
  resolveEffectiveAgentSkillFilter,
} from "../discovery/agent-filter.js";
import { normalizeSkillFilter } from "../discovery/filter.js";
import { assertUnambiguousManagedSkillNames } from "../library/command-name.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillEntry,
} from "../types.js";
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
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
  type PluginSkillRoot,
} from "./plugin-skills.js";
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
import { resolveSkillTelemetrySourceValue } from "./source.js";
import { resolveAllowedSkillSymlinkTargetRealPaths, tryRealpath } from "./symlink-targets.js";

const skillsLogger = createSubsystemLogger("skills");
const CUSTODIAN_SKILLS_DIR_NAME = "custodian-skills";
const SKILL_SOURCE_ORIGIN_RELATIVE_PATH = path.join(".openclaw", "source-origin.json");
const MAX_SKILL_SOURCE_ORIGIN_BYTES = 16 * 1024;
const MAX_SKILL_ENTRY_CACHE_SIZE = 64;
const skillEntryCache = new Map<string, SkillEntry[]>();
const reportedSkillCollisions = new Map<string, true>();

type LoadedSkillRecord = {
  skill: Skill;
  frontmatter?: ParsedSkillFrontmatter;
  rejectHardlinks: boolean;
  syncSourceDir?: string;
  syncDirName?: string;
};

type WorkspaceSkillRoots = {
  agentWorkspaceDir: string;
  executionSkillsDir?: string;
};

type WorkspaceSkillLoadOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  agentId?: string;
  /**
   * "ignore" keeps agentId scoping source discovery (custodian skills) without
   * activating the agent allowlist filter — status/inventory views need the
   * full entry list so excluded skills stay present-but-marked.
   */
  agentSkillFilter?: "apply" | "ignore";
  eligibility?: SkillEligibilityContext;
  workspaceOnly?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
};

export function normalizeWorkspaceSkillRoots(roots: WorkspaceSkillRoots): WorkspaceSkillRoots {
  const agentWorkspaceDir = path.resolve(roots.agentWorkspaceDir);
  const executionSkillsDir = roots.executionSkillsDir
    ? path.resolve(roots.executionSkillsDir)
    : undefined;
  return executionSkillsDir && executionSkillsDir !== path.join(agentWorkspaceDir, "skills")
    ? { agentWorkspaceDir, executionSkillsDir }
    : { agentWorkspaceDir };
}

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

// Shared by both merge paths so a dropped skill is never silent: the by-name merge in
// loadSkillEntries and the execution-directory filter in loadMergedWorkspaceSkills.
function warnSkillPrecedenceCollision(winner: Skill, loser: Skill, workspaceDir: string): void {
  const collisionKey = JSON.stringify([
    workspaceDir,
    getSkillsSnapshotVersion(workspaceDir),
    winner.name,
    winner.source,
    winner.filePath,
    loser.source,
    loser.filePath,
  ]);
  if (reportedSkillCollisions.has(collisionKey)) {
    return;
  }
  // One file reachable through two roots is not a collision. normalizeWorkspaceSkillRoots only
  // rejects the literal <agentWorkspaceDir>/skills path, so a symlinked execution dir still
  // arrives here with both sides naming the same skill.
  if (canonicalizePath(winner.filePath) === canonicalizePath(loser.filePath)) {
    return;
  }
  reportedSkillCollisions.set(collisionKey, true);
  pruneMapToMaxSize(reportedSkillCollisions, MAX_SKILL_ENTRY_CACHE_SIZE * 4);
  const collisionName = winner.name.slice(0, 128);
  skillsLogger.warn("Skill precedence collision resolved.", {
    skill: collisionName,
    winnerSource: winner.source,
    loserSource: loser.source,
    winnerPath: winner.filePath,
    loserPath: loser.filePath,
    consoleMessage:
      `Skill precedence collision: skill="${collisionName}" ` +
      `winner=${winner.source}:${compactSkillPath(winner.filePath)} ` +
      `loser=${loser.source}:${compactSkillPath(loser.filePath)}`,
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
  assertUnambiguousManagedSkillNames(entries);
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

function loadDiscoveredSkillRecords(params: {
  dir: string;
  source: string;
  limits: ResolvedSkillDiscoveryLimits;
  allowedSymlinkTargetRealPaths: readonly string[];
  rejectHardlinks: boolean;
}): LoadedSkillRecord[] {
  const discovered = discoverSkillCandidates(params);
  const maxSkillsLoadedPerSource = Math.max(0, params.limits.maxSkillsLoadedPerSource);
  const loadCandidate = (candidate: CandidateSkillDir) =>
    loadContainedSkillRecords({
      skillDir: candidate.skillDir,
      source: params.source,
      maxSkillFileBytes: params.limits.maxSkillFileBytes,
      canonicalSkillDir: canonicalSkillDirForSource(params.source, candidate.skillDirRealPath),
      rejectHardlinks: params.rejectHardlinks,
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

function loadGeneratedPluginSkillRecords(params: {
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

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    agentId?: string;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    workspaceSkillsDir?: string;
    workspaceOnly?: boolean;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): SkillEntry[] {
  const workspaceOnly = opts?.workspaceOnly === true;
  const workspaceSkillsDir = opts?.workspaceSkillsDir ?? path.resolve(workspaceDir, "skills");
  const configuredCustodianAgentId = opts?.config
    ? tryResolveAmbientOwnerAgentId(opts.config)
    : undefined;
  const custodianAgentId =
    !workspaceOnly &&
    opts?.agentId &&
    configuredCustodianAgentId &&
    normalizeAgentId(opts.agentId) === configuredCustodianAgentId
      ? configuredCustodianAgentId
      : undefined;
  const osHomeDir = resolveSkillsUserHomeDir();
  // Snapshot versions are the watcher-owned invalidation boundary; cache hits must do no IO.
  const cacheKey = JSON.stringify([
    workspaceDir,
    workspaceSkillsDir,
    workspaceOnly,
    custodianAgentId,
    opts?.managedSkillsDir,
    opts?.bundledSkillsDir,
    opts?.pluginSkillsDir,
    opts?.config ? fingerprintSkillSnapshotConfig(opts.config) : undefined,
    osHomeDir,
    process.env.OPENCLAW_STATE_DIR,
    getSkillsSnapshotVersion(workspaceDir),
  ]);
  const cachedEntries = skillEntryCache.get(cacheKey);
  if (cachedEntries) {
    return cachedEntries;
  }

  const limits = resolveSkillDiscoveryLimits(opts?.config);
  const allowedSymlinkTargetRealPaths = resolveAllowedSkillSymlinkTargetRealPaths(opts?.config);
  const loadSkills = (params: {
    dir: string;
    source: string;
    rejectHardlinks?: boolean;
  }): LoadedSkillRecord[] =>
    loadDiscoveredSkillRecords({
      ...params,
      limits,
      allowedSymlinkTargetRealPaths,
      rejectHardlinks:
        params.rejectHardlinks ??
        shouldRejectHardlinkedPluginFiles({
          origin:
            resolveSkillTelemetrySourceValue(params.source) === "bundled" ? "bundled" : "workspace",
          rootDir: params.dir,
        }),
    });
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledSkillsDir = workspaceOnly
    ? undefined
    : (opts?.bundledSkillsDir ?? resolveBundledSkillsDir());
  const pluginSkillsDir = opts?.pluginSkillsDir ?? path.join(CONFIG_DIR, "plugin-skills");
  const extraDirsRaw = workspaceOnly ? [] : (opts?.config?.skills?.load?.extraDirs ?? []);
  const extraDirs = normalizeTrimmedStringList(extraDirsRaw);
  const pluginSkillRoots = workspaceOnly
    ? []
    : opts?.pluginMetadataSnapshot
      ? resolvePluginSkillRootsFromMetadata({
          workspaceDir,
          config: opts.config,
          pluginSkillsDir,
          metadataSnapshot: opts.pluginMetadataSnapshot,
        })
      : resolvePluginSkillRoots({ workspaceDir, config: opts?.config, pluginSkillsDir });

  const bundledSkills = bundledSkillsDir
    ? loadSkills({ dir: bundledSkillsDir, source: "openclaw-bundled" })
    : [];
  const custodianSkillsDir =
    bundledSkillsDir && custodianAgentId
      ? path.join(path.dirname(bundledSkillsDir), CUSTODIAN_SKILLS_DIR_NAME)
      : undefined;
  const custodianSkills = custodianSkillsDir
    ? loadSkills({ dir: custodianSkillsDir, source: "openclaw-custodian" })
    : [];
  const extraSkills = [
    ...extraDirs.flatMap((dir) =>
      loadSkills({ dir: resolveUserPath(dir), source: "openclaw-extra" }),
    ),
    ...pluginSkillRoots.flatMap((root) =>
      loadSkills({
        dir: root.dir,
        source: "openclaw-extra",
        rejectHardlinks: root.rejectHardlinks,
      }),
    ),
    ...loadGeneratedPluginSkillRecords({
      pluginSkillsDir,
      pluginSkillRoots,
      source: "openclaw-extra",
      limits,
    }),
  ];
  const managedSkills = workspaceOnly
    ? []
    : loadSkills({ dir: managedSkillsDir, source: "openclaw-managed" });
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
  const mergeRecord = (record: LoadedSkillRecord) => {
    const replaced = merged.get(record.skill.name);
    if (replaced) {
      warnSkillPrecedenceCollision(record.skill, replaced.skill, workspaceDir);
    }
    merged.set(record.skill.name, record);
  };
  for (const record of extraSkills) {
    mergeRecord(record);
  }
  // Custodian skills share bundled precedence. Sort the tier so source traversal
  // remains deterministic even if a package accidentally ships a duplicate name.
  const bundledTierSkills = [...bundledSkills, ...custodianSkills].toSorted(
    (left, right) =>
      left.skill.name.localeCompare(right.skill.name, "en") ||
      left.skill.source.localeCompare(right.skill.source, "en"),
  );
  for (const record of bundledTierSkills) {
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

  const entries = Array.from(merged.values())
    .toSorted((a, b) => a.skill.name.localeCompare(b.skill.name, "en"))
    .map((record) => {
      const skill = record.skill;
      const frontmatter =
        record.frontmatter ??
        readSkillFrontmatterSafe({
          rootDir: skill.baseDir,
          filePath: skill.filePath,
          maxBytes: limits.maxSkillFileBytes,
          rejectHardlinks: record.rejectHardlinks,
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
  skillEntryCache.set(cacheKey, entries);
  pruneMapToMaxSize(skillEntryCache, MAX_SKILL_ENTRY_CACHE_SIZE);
  return entries;
}

function resolveEffectiveWorkspaceSkillFilter(opts?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentSkillFilter?: "apply" | "ignore";
  skillFilter?: string[];
}): string[] | undefined {
  if (opts?.skillFilter !== undefined) {
    return normalizeSkillFilter(opts.skillFilter);
  }
  if (opts?.agentSkillFilter === "ignore" || !opts?.config || !opts.agentId) {
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
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): { eligible: SkillEntry[]; skillFilter: string[] | undefined } {
  const skillFilter = resolveEffectiveWorkspaceSkillFilter(opts);
  const skillEntries =
    opts?.entries ??
    mergeRemoteNodeSkillEntries(loadSkillEntries(workspaceDir, opts), {
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
  opts?: WorkspaceSkillLoadOptions,
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

/** Loads agent-workspace skills first, then execution-directory OpenClaw skills. */
export function loadMergedWorkspaceSkills(
  params: WorkspaceSkillRoots & WorkspaceSkillLoadOptions,
): SkillEntry[] {
  const { agentWorkspaceDir, executionSkillsDir } = normalizeWorkspaceSkillRoots(params);
  if (!executionSkillsDir) {
    return loadWorkspaceSkills(agentWorkspaceDir, params);
  }

  const agentEntries = mergeRemoteNodeSkillEntries(loadSkillEntries(agentWorkspaceDir, params), {
    canExec: params.eligibility?.nodeSkills?.canExec,
    node: params.eligibility?.nodeSkills?.node,
  });
  const agentEntriesByName = new Map(agentEntries.map((entry) => [entry.skill.name, entry]));
  const executionEntries = loadSkillEntries(agentWorkspaceDir, {
    ...params,
    workspaceOnly: true,
    workspaceSkillsDir: executionSkillsDir,
  }).filter((entry) => {
    const agentEntry = agentEntriesByName.get(entry.skill.name);
    if (!agentEntry) {
      return true;
    }
    warnSkillPrecedenceCollision(agentEntry.skill, entry.skill, agentWorkspaceDir);
    return false;
  });
  const effectiveSkillFilter = resolveEffectiveWorkspaceSkillFilter(params);
  return filterSkillEntries(
    [...agentEntries, ...executionEntries],
    params.config,
    effectiveSkillFilter,
    params.skillOverrides,
    params.eligibility,
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
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
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

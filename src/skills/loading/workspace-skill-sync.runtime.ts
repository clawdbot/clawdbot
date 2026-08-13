// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryReadJson, writeJson } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillTelemetrySource,
  SkillUsagePath,
} from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { resolveSkillInvocationPolicy, resolveSkillKey } from "./frontmatter.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";
import { serializeByKey } from "./serialize.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { loadWorkspaceSkills, resolveSkillEntryMetadata } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import {
  pruneSyncedSkillsUsageCache,
  readSyncedSkillsUsageCache,
  resolveSyncedSkillsCacheKey,
  writeSyncedSkillsUsageCache,
} from "./workspace-skill-sync-cache.js";

const fsp = fs.promises;
const skillsLogger = createSubsystemLogger("skills");

function resolveUniqueSyncedSkillDirName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

const SYNCED_SKILLS_MANIFEST_NAME = ".openclaw-sync.json";

type SyncedSkillsManifest = {
  entryKeys: string[];
  skillsVersion: number;
  skillUsagePaths?: SkillUsagePath[];
};

export type SyncedWorkspaceSkills = {
  skillUsagePaths: SkillUsagePath[];
  /** Complete materialized catalog for this run (host destination paths). */
  skillsSnapshot: SkillSnapshot;
};

function createEmptySyncedSkillsSnapshot(skillsVersion: number): SkillSnapshot {
  return {
    prompt: "",
    skills: [],
    resolvedSkills: [],
    version: skillsVersion,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}

function remapSkillEntryToSyncedDestination(
  entry: SkillEntry,
  destinationPath: string,
): SkillEntry {
  const relativeFilePath = path.relative(entry.skill.baseDir, entry.skill.filePath);
  const filePath = path.join(destinationPath, relativeFilePath);
  return {
    ...entry,
    skill: {
      ...entry.skill,
      baseDir: destinationPath,
      filePath,
      sourceInfo: {
        ...entry.skill.sourceInfo,
        path: filePath,
        ...(entry.skill.sourceInfo.baseDir === undefined ? {} : { baseDir: destinationPath }),
      },
    },
  };
}

function buildSyncedSkillsSnapshot(params: {
  targetWorkspaceDir: string;
  plans: Array<{ destinationPath?: string; entry: SkillEntry }>;
  skillUsagePaths: SkillUsagePath[];
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  skillsVersion: number;
}): SkillSnapshot {
  const syncedNames = new Set(params.skillUsagePaths.map((entry) => entry.skillName));
  const materializedEntries = params.plans.flatMap((plan) => {
    // Non-filesystem locators (node://) are planned without a destination and
    // must stay in the published catalog. Dropping them makes the attached
    // snapshot suppress live loading and omit those skills from sandbox prompts.
    if (!plan.destinationPath) {
      return [plan.entry];
    }
    if (!syncedNames.has(plan.entry.skill.name)) {
      return [];
    }
    return [remapSkillEntryToSyncedDestination(plan.entry, plan.destinationPath)];
  });
  return buildSkillSnapshot(params.targetWorkspaceDir, {
    entries: materializedEntries,
    config: params.config,
    agentId: params.agentId,
    skillFilter: params.skillFilter,
    eligibility: params.eligibility,
    snapshotVersion: params.skillsVersion,
  });
}

function resolveSyncedSkillIdentity(skillKey: string, skillName: string): string {
  return JSON.stringify([skillKey, skillName]);
}

function isSkillTelemetrySource(value: unknown): value is SkillTelemetrySource {
  return value === "bundled" || value === "unknown" || value === "workspace";
}

function parseSyncedSkillUsagePaths(value: unknown): SkillUsagePath[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const skillUsagePaths: SkillUsagePath[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.readPath !== "string" ||
      typeof entry.skillFile !== "string" ||
      typeof entry.skillName !== "string" ||
      !isSkillTelemetrySource(entry.skillSource)
    ) {
      return undefined;
    }
    skillUsagePaths.push({
      readPath: entry.readPath,
      skillFile: entry.skillFile,
      skillName: entry.skillName,
      skillSource: entry.skillSource,
    });
  }
  return skillUsagePaths;
}

function applyPublishedSkillTelemetrySource(
  skill: SkillEntry["skill"],
  skillSource: SkillTelemetrySource | undefined,
): SkillEntry["skill"] {
  // Reloading published files defaults to source "workspace". allowBundled and
  // workspace provenance checks need the original loader labels.
  const source =
    skillSource === "bundled"
      ? "openclaw-bundled"
      : skillSource === "workspace"
        ? "openclaw-workspace"
        : undefined;
  if (!source) {
    return skill;
  }
  return {
    ...skill,
    source,
    sourceInfo: {
      ...skill.sourceInfo,
      source,
    },
  };
}

function loadPublishedSyncedSkillEntries(
  targetSkillsDir: string,
  skillUsagePaths: SkillUsagePath[],
): SkillEntry[] {
  const loaded = loadSkillsFromDirSafe({
    dir: targetSkillsDir,
    source: "workspace",
  });
  // Only manifest-committed children belong to the catalog. A directory left
  // behind by a failed copy exists on disk but was never published, so it must
  // not reach a prompt.
  const publishedByReadPath = new Map(
    skillUsagePaths.map((usage) => [canonicalizePath(usage.readPath), usage]),
  );
  return loaded.skills.flatMap((skill) => {
    const usage = publishedByReadPath.get(canonicalizePath(skill.filePath));
    if (!usage) {
      return [];
    }
    const frontmatter = loaded.frontmatterByFilePath.get(skill.filePath) ?? {};
    const metadata = resolveSkillEntryMetadata({
      frontmatter,
      skillDir: skill.baseDir,
    });
    return [
      {
        skill: applyPublishedSkillTelemetrySource(skill, usage.skillSource),
        frontmatter,
        ...(metadata ? { metadata } : {}),
        invocation: resolveSkillInvocationPolicy(frontmatter),
      },
    ];
  });
}

function projectSnapshotFromPublishedSkills(params: {
  targetSkillsDir: string;
  targetWorkspaceDir: string;
  skillUsagePaths: SkillUsagePath[];
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  skillsVersion: number;
}): SkillSnapshot | undefined {
  // Published files are shared across runs. Prompt notes and node:// members are
  // this run's projection; never hand back another run's cached snapshot.
  const fileEntries = loadPublishedSyncedSkillEntries(
    params.targetSkillsDir,
    params.skillUsagePaths,
  );
  if (fileEntries.length === 0) {
    return undefined;
  }
  return buildSkillSnapshot(params.targetWorkspaceDir, {
    entries: mergeRemoteNodeSkillEntries(fileEntries, {
      canExec: params.eligibility?.nodeSkills?.canExec,
      node: params.eligibility?.nodeSkills?.node,
    }),
    config: params.config,
    skillFilter: params.skillFilter,
    agentId: params.agentId,
    eligibility: params.eligibility,
    snapshotVersion: params.skillsVersion,
  });
}

function parseSyncedSkillsManifest(value: unknown): SyncedSkillsManifest | null {
  if (
    !isRecord(value) ||
    typeof value.skillsVersion !== "number" ||
    !Number.isFinite(value.skillsVersion) ||
    !Array.isArray(value.entryKeys) ||
    !value.entryKeys.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  let skillUsagePaths: SkillUsagePath[] | undefined;
  if (value.skillUsagePaths !== undefined) {
    skillUsagePaths = parseSyncedSkillUsagePaths(value.skillUsagePaths);
    if (!skillUsagePaths) {
      return null;
    }
  }
  return {
    entryKeys: value.entryKeys,
    skillsVersion: value.skillsVersion,
    ...(skillUsagePaths ? { skillUsagePaths } : {}),
  };
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

function shouldCopySyncedSkillSourceEntry(src: string): boolean {
  const name = path.basename(src);
  return name !== ".git" && name !== "node_modules";
}

async function lstatOrUndefined(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function pruneStaleSyncedSkillFiles(source: string, destination: string): Promise<void> {
  let children: fs.Dirent[];
  try {
    children = await fsp.readdir(destination, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const child of children) {
    const sourceChild = path.join(source, child.name);
    const destinationChild = path.join(destination, child.name);
    const sourceStats = shouldCopySyncedSkillSourceEntry(sourceChild)
      ? await lstatOrUndefined(sourceChild)
      : undefined;
    if (sourceStats?.isDirectory() === child.isDirectory()) {
      if (child.isDirectory()) {
        await pruneStaleSyncedSkillFiles(sourceChild, destinationChild);
      }
      continue;
    }
    await fsp.rm(destinationChild, { recursive: true, force: true });
  }
}

async function syncSyncedSkillChild(source: string, destination: string): Promise<void> {
  // Overlay-copy onto the live child instead of replacing it. A concurrent run
  // already advertised these <location> paths; wiping first would leave it
  // reading a half-built directory. Stale files are removed after the copy, so
  // every path that survives the refresh stays readable throughout.
  await fsp.cp(source, destination, {
    recursive: true,
    force: true,
    filter: shouldCopySyncedSkillSourceEntry,
  });
  await pruneStaleSyncedSkillFiles(source, destination);
}

async function pruneRemovedSyncedSkillChildren(params: {
  targetSkillsDir: string;
  retainDirNames: ReadonlySet<string>;
}): Promise<void> {
  for (const child of await fsp.readdir(params.targetSkillsDir)) {
    if (child === SYNCED_SKILLS_MANIFEST_NAME || params.retainDirNames.has(child)) {
      continue;
    }
    await fsp.rm(path.join(params.targetSkillsDir, child), { recursive: true, force: true });
  }
}

function hydratePublishedSyncedSkillsCache(params: {
  targetSkillsDir: string;
  targetWorkspaceDir: string;
  manifest: SyncedSkillsManifest;
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
}): ReturnType<typeof readSyncedSkillsUsageCache> {
  // The process-local catalog cache dies on restart. Rebuild it from the last
  // committed manifest so a cold start never re-copies a tree that concurrent
  // runs are already reading.
  const skillUsagePaths = params.manifest.skillUsagePaths?.map((usage) => ({ ...usage }));
  if (!skillUsagePaths?.length) {
    return undefined;
  }
  const snapshot = projectSnapshotFromPublishedSkills({
    targetSkillsDir: params.targetSkillsDir,
    targetWorkspaceDir: params.targetWorkspaceDir,
    skillUsagePaths,
    config: params.config,
    skillFilter: params.skillFilter,
    agentId: params.agentId,
    eligibility: params.eligibility,
    skillsVersion: params.manifest.skillsVersion,
  });
  if (!snapshot) {
    return undefined;
  }
  const entry = {
    manifestKey: JSON.stringify([params.manifest.skillsVersion, params.manifest.entryKeys]),
    skillUsagePaths,
    skillsSnapshot: snapshot,
  };
  writeSyncedSkillsUsageCache(params.targetSkillsDir, entry);
  pruneSyncedSkillsUsageCache(100);
  return entry;
}

async function ensureSyncedSkillsDirectory(targetSkillsDir: string): Promise<void> {
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
  }
}

export async function syncWorkspaceSkills(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  pluginSkillsDir?: string;
  skillsSnapshot?: SkillSnapshot;
}): Promise<SyncedWorkspaceSkills> {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return {
      skillUsagePaths: [],
      skillsSnapshot: createEmptySyncedSkillsSnapshot(getSkillsSnapshotVersion(sourceDir)),
    };
  }

  return await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = resolveSyncedSkillsCacheKey(params.targetWorkspaceDir);
    const manifestPath = path.join(targetSkillsDir, SYNCED_SKILLS_MANIFEST_NAME);
    const skillsVersion = getSkillsSnapshotVersion(sourceDir);
    const skillsSnapshot = params.skillsSnapshot;

    await ensureSyncedSkillsDirectory(targetSkillsDir);
    const manifest = parseSyncedSkillsManifest(await tryReadJson<unknown>(manifestPath));
    const expectedManifestKey =
      skillsSnapshot?.version === skillsVersion
        ? JSON.stringify([
            skillsVersion,
            skillsSnapshot.skills
              .map((skill) => resolveSyncedSkillIdentity(skill.skillKey ?? skill.name, skill.name))
              .toSorted(),
          ])
        : undefined;
    const cachedUsage =
      readSyncedSkillsUsageCache(targetSkillsDir) ??
      (manifest
        ? hydratePublishedSyncedSkillsCache({
            targetSkillsDir,
            targetWorkspaceDir: targetDir,
            manifest,
            config: params.config,
            skillFilter: params.skillFilter,
            agentId: params.agentId,
            eligibility: params.eligibility,
          })
        : undefined);
    const manifestKey = manifest
      ? JSON.stringify([manifest.skillsVersion, manifest.entryKeys])
      : undefined;
    if (
      expectedManifestKey &&
      manifestKey === expectedManifestKey &&
      cachedUsage?.manifestKey === manifestKey
    ) {
      // Same catalog identities: reuse the published files untouched and only
      // reproject them onto this run's eligibility. No delete, no copy.
      const projected = projectSnapshotFromPublishedSkills({
        targetSkillsDir,
        targetWorkspaceDir: targetDir,
        skillUsagePaths: cachedUsage.skillUsagePaths,
        config: params.config,
        skillFilter: params.skillFilter,
        agentId: params.agentId,
        eligibility: params.eligibility,
        skillsVersion,
      });
      if (projected) {
        writeSyncedSkillsUsageCache(targetSkillsDir, {
          manifestKey: cachedUsage.manifestKey,
          skillUsagePaths: cachedUsage.skillUsagePaths,
          skillsSnapshot: projected,
        });
        return {
          skillUsagePaths: cachedUsage.skillUsagePaths.map((usage) => ({ ...usage })),
          skillsSnapshot: projected,
        };
      }
    }

    const entries = loadWorkspaceSkills(sourceDir, {
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
      pluginSkillsDir: params.pluginSkillsDir,
    });

    const usedDirNames = new Set<string>();
    const plans: Array<{ destinationPath?: string; entry: SkillEntry; identity: string }> = [];
    for (const entry of entries) {
      const identity = resolveSyncedSkillIdentity(
        resolveSkillKey(entry.skill, entry),
        entry.skill.name,
      );
      if (entry.skill.filePath.startsWith("node://")) {
        plans.push({ entry, identity });
        continue;
      }
      let destinationPath: string | null;
      try {
        destinationPath = resolveSyncedSkillDestinationPath({
          targetSkillsDir,
          entry,
          usedDirNames,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to resolve safe destination for ${entry.skill.name}: ${message}`);
        continue;
      }
      if (!destinationPath) {
        skillsLogger.warn(
          `Failed to resolve safe destination for ${entry.skill.name}: invalid source directory name`,
        );
        continue;
      }
      plans.push({ destinationPath, entry, identity });
    }

    const skillUsagePaths: SkillUsagePath[] = [];
    const publishedIdentities: string[] = [];
    for (const plan of plans) {
      const { destinationPath, entry } = plan;
      if (!destinationPath) {
        publishedIdentities.push(plan.identity);
        continue;
      }
      const readPath = path.join(
        destinationPath,
        path.relative(entry.skill.baseDir, entry.skill.filePath),
      );
      let refreshed = true;
      try {
        await syncSyncedSkillChild(entry.syncSourceDir ?? entry.skill.baseDir, destinationPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
        // Keep the previously published copy when a source turns unreadable. One
        // failed refresh must not shrink a catalog concurrent runs advertise;
        // only a skill that was never published drops out here.
        if (!(await lstatOrUndefined(readPath))) {
          continue;
        }
        refreshed = false;
      }
      // A reused stale child stays out of the manifest identities so the next
      // sync misses the unchanged-catalog fast path and retries the copy.
      if (refreshed) {
        publishedIdentities.push(plan.identity);
      }
      skillUsagePaths.push({
        readPath,
        skillFile: canonicalizePath(entry.skill.filePath),
        skillName: entry.skill.name,
        skillSource: resolveSkillTelemetrySource(entry.skill),
      });
    }
    if (plans.length > 0 && skillUsagePaths.length === 0 && publishedIdentities.length === 0) {
      // Every candidate failed to copy. Committing an empty manifest would tell
      // later readers the catalog is genuinely empty instead of retrying.
      return {
        skillUsagePaths: [],
        skillsSnapshot: createEmptySyncedSkillsSnapshot(skillsVersion),
      };
    }
    const nextSkillsSnapshot = buildSyncedSkillsSnapshot({
      targetWorkspaceDir: targetDir,
      plans,
      skillUsagePaths,
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
      skillsVersion,
    });
    const nextManifest: SyncedSkillsManifest = {
      entryKeys: publishedIdentities.toSorted(),
      skillsVersion,
      skillUsagePaths,
    };
    await writeJson(manifestPath, nextManifest, { trailingNewline: true });
    writeSyncedSkillsUsageCache(targetSkillsDir, {
      manifestKey: JSON.stringify([skillsVersion, nextManifest.entryKeys]),
      skillUsagePaths,
      skillsSnapshot: nextSkillsSnapshot,
    });
    pruneSyncedSkillsUsageCache(100);
    try {
      await pruneRemovedSyncedSkillChildren({
        targetSkillsDir,
        retainDirNames: usedDirNames,
      });
    } catch (error) {
      // The manifest is already committed. Prune is cleanup; failing it must not
      // hide the published catalog from this run's prompt.
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      skillsLogger.warn(`Failed to prune removed sandbox skills: ${message}`);
    }
    return {
      skillUsagePaths,
      skillsSnapshot: nextSkillsSnapshot,
    };
  });
}

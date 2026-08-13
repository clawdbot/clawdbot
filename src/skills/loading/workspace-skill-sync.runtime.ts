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
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { loadSkillsFromDirSafe } from "./local-loader.js";
import { serializeByKey } from "./serialize.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import {
  collectRetainedSyncedSkillGenerations,
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
const SYNCED_SKILLS_GENERATIONS_DIR_NAME = ".openclaw-generations";

type SyncedSkillsManifest = {
  entryKeys: string[];
  generation: number;
  skillsVersion: number;
};

export type SyncedWorkspaceSkills = {
  skillUsagePaths: SkillUsagePath[];
  /** Complete materialized catalog for this sync generation (host destination paths). */
  skillsSnapshot: SkillSnapshot;
  /** Published generation that `skillsSnapshot` advertises; 0 means nothing to lease. */
  generation: number;
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
  let generation = 0;
  if (value.generation !== undefined) {
    if (
      typeof value.generation !== "number" ||
      !Number.isInteger(value.generation) ||
      value.generation < 0
    ) {
      return null;
    }
    generation = value.generation;
  }
  return {
    entryKeys: value.entryKeys,
    generation,
    skillsVersion: value.skillsVersion,
  };
}

function resolveSyncedSkillGenerationDir(targetSkillsDir: string, generation: number): string {
  return path.join(targetSkillsDir, SYNCED_SKILLS_GENERATIONS_DIR_NAME, String(generation));
}

function resolveSyncedSkillDestinationPath(params: {
  generationDir: string;
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
    cwd: params.generationDir,
    root: params.generationDir,
  }).resolved;
}

function shouldCopySyncedSkillSourceEntry(src: string): boolean {
  const name = path.basename(src);
  return name !== ".git" && name !== "node_modules";
}

async function copySyncedSkillDirectory(source: string, destination: string): Promise<void> {
  await fsp.cp(source, destination, {
    recursive: true,
    force: true,
    filter: shouldCopySyncedSkillSourceEntry,
  });
}

async function listSyncedSkillGenerationIds(targetSkillsDir: string): Promise<number[]> {
  const generationsRoot = path.join(targetSkillsDir, SYNCED_SKILLS_GENERATIONS_DIR_NAME);
  let children: fs.Dirent[];
  try {
    children = await fsp.readdir(generationsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return children.flatMap((entry) => {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) {
      return [];
    }
    return [Number(entry.name)];
  });
}

function resolveLegacySyncedSkillRootBasenames(
  targetSkillsDir: string,
  skillUsagePaths: SkillUsagePath[],
): string[] {
  const generationsPrefix = `${SYNCED_SKILLS_GENERATIONS_DIR_NAME}${path.sep}`;
  return skillUsagePaths.flatMap((entry) => {
    const relative = path.relative(targetSkillsDir, entry.readPath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative === SYNCED_SKILLS_GENERATIONS_DIR_NAME ||
      relative.startsWith(generationsPrefix)
    ) {
      return [];
    }
    const basename = relative.split(path.sep)[0];
    return basename ? [basename] : [];
  });
}

async function pruneSyncedSkillGenerations(params: {
  targetSkillsDir: string;
  retainGenerations: ReadonlySet<number>;
  retainRootBasenames: ReadonlySet<string>;
}): Promise<void> {
  const generationsRoot = path.join(params.targetSkillsDir, SYNCED_SKILLS_GENERATIONS_DIR_NAME);
  for (const generation of await listSyncedSkillGenerationIds(params.targetSkillsDir)) {
    if (!params.retainGenerations.has(generation)) {
      await fsp.rm(path.join(generationsRoot, String(generation)), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const child of await fsp.readdir(params.targetSkillsDir)) {
    if (
      child === SYNCED_SKILLS_MANIFEST_NAME ||
      child === SYNCED_SKILLS_GENERATIONS_DIR_NAME ||
      params.retainRootBasenames.has(child)
    ) {
      continue;
    }
    await fsp.rm(path.join(params.targetSkillsDir, child), { recursive: true, force: true });
  }
}

async function hydratePublishedSyncedSkillsCache(params: {
  targetSkillsDir: string;
  targetWorkspaceDir: string;
  manifest: SyncedSkillsManifest;
  config?: OpenClawConfig;
  skillFilter?: string[];
  agentId?: string;
  eligibility?: SkillEligibilityContext;
}): Promise<ReturnType<typeof readSyncedSkillsUsageCache>> {
  // Process-local catalog cache dies on restart. Reload the last committed
  // generation so a failed refresh cannot strand readers on an empty live scan
  // of the bind-mounted skills root, which skips dot-prefixed generation dirs.
  if (params.manifest.generation <= 0) {
    return undefined;
  }
  const generationDir = resolveSyncedSkillGenerationDir(
    params.targetSkillsDir,
    params.manifest.generation,
  );
  try {
    const stats = await fsp.stat(generationDir);
    if (!stats.isDirectory()) {
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const loaded = loadSkillsFromDirSafe({
    dir: generationDir,
    source: "workspace",
  });
  if (loaded.skills.length === 0) {
    return undefined;
  }
  const entries = loaded.skills.map((skill) => ({
    skill,
    frontmatter: loaded.frontmatterByFilePath.get(skill.filePath) ?? {},
  }));
  const entry = {
    generation: params.manifest.generation,
    manifestKey: JSON.stringify([
      params.manifest.skillsVersion,
      entries
        .map((skillEntry) =>
          resolveSyncedSkillIdentity(
            resolveSkillKey(skillEntry.skill, skillEntry),
            skillEntry.skill.name,
          ),
        )
        .toSorted(),
    ]),
    skillUsagePaths: loaded.skills.map((skill) => ({
      readPath: skill.filePath,
      skillFile: canonicalizePath(skill.filePath),
      skillName: skill.name,
      skillSource: resolveSkillTelemetrySource(skill),
    })),
    skillsSnapshot: buildSkillSnapshot(params.targetWorkspaceDir, {
      entries,
      config: params.config,
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      eligibility: params.eligibility,
      snapshotVersion: params.manifest.skillsVersion,
    }),
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
      generation: 0,
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
        ? await hydratePublishedSyncedSkillsCache({
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
      return {
        skillUsagePaths: cachedUsage.skillUsagePaths.map((entry) => ({ ...entry })),
        skillsSnapshot: cachedUsage.skillsSnapshot,
        generation: cachedUsage.generation ?? 0,
      };
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

    const existingGenerationIds = await listSyncedSkillGenerationIds(targetSkillsDir);
    const previousGeneration = manifest?.generation ?? cachedUsage?.generation ?? 0;
    const nextGeneration = Math.max(previousGeneration, ...existingGenerationIds, 0) + 1;
    const generationDir = resolveSyncedSkillGenerationDir(targetSkillsDir, nextGeneration);
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
          generationDir,
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

    // Publish into a new generation directory. The bind-mounted skills root
    // inode cannot be renamed, so in-place child replacement would leave the
    // still-published catalog pointing at missing <location> files.
    const retainRootBasenames = new Set(
      resolveLegacySyncedSkillRootBasenames(targetSkillsDir, cachedUsage?.skillUsagePaths ?? []),
    );
    const filesystemPlans = plans.filter((plan) => plan.destinationPath);
    if (filesystemPlans.length > 0) {
      await fsp.mkdir(generationDir, { recursive: true });
    }

    const skillUsagePaths: SkillUsagePath[] = [];
    let copyFailed = false;
    for (const plan of plans) {
      const { destinationPath, entry } = plan;
      if (!destinationPath) {
        continue;
      }
      try {
        await copySyncedSkillDirectory(entry.syncSourceDir ?? entry.skill.baseDir, destinationPath);
      } catch (error) {
        copyFailed = true;
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
        continue;
      }
      skillUsagePaths.push({
        readPath: path.join(
          destinationPath,
          path.relative(entry.skill.baseDir, entry.skill.filePath),
        ),
        skillFile: canonicalizePath(entry.skill.filePath),
        skillName: entry.skill.name,
        skillSource: resolveSkillTelemetrySource(entry.skill),
      });
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
    if (copyFailed) {
      await fsp.rm(generationDir, { recursive: true, force: true });
      // Leave the previously published complete catalog and generation in
      // place. A failed refresh must not force concurrent readers onto a
      // partial live tree.
      if (cachedUsage) {
        return {
          skillUsagePaths: cachedUsage.skillUsagePaths.map((entry) => ({ ...entry })),
          skillsSnapshot: cachedUsage.skillsSnapshot,
          generation: cachedUsage.generation ?? 0,
        };
      }
      return { skillUsagePaths, skillsSnapshot: nextSkillsSnapshot, generation: 0 };
    }
    const nextManifest: SyncedSkillsManifest = {
      entryKeys: plans.map((plan) => plan.identity).toSorted(),
      generation: nextGeneration,
      skillsVersion,
    };
    await writeJson(manifestPath, nextManifest, { trailingNewline: true });
    writeSyncedSkillsUsageCache(targetSkillsDir, {
      generation: nextGeneration,
      manifestKey: JSON.stringify([skillsVersion, nextManifest.entryKeys]),
      skillUsagePaths,
      skillsSnapshot: nextSkillsSnapshot,
    });
    pruneSyncedSkillsUsageCache(100);
    await pruneSyncedSkillGenerations({
      targetSkillsDir,
      retainGenerations: collectRetainedSyncedSkillGenerations({
        targetSkillsDir,
        currentGeneration: nextGeneration,
        previousGeneration,
      }),
      retainRootBasenames,
    });
    return {
      skillUsagePaths,
      skillsSnapshot: nextSkillsSnapshot,
      generation: nextGeneration,
    };
  });
}

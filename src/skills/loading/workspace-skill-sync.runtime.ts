// Sandbox workspace skill synchronization is deferred behind the sandbox runtime boundary.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSandboxPath } from "../../agents/sandbox-paths.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { tryReadJson, writeJson } from "../../infra/json-files.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { loadSkillLibrarySelection, readSelectedSkillLibraryFiles } from "../library/selection.js";
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { fingerprintSkillSnapshotConfig } from "../runtime/snapshot-config-fingerprint.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { serializeByKey } from "./serialize.js";
import { shouldSyncSkillPath } from "./skill-paths.js";
import { resolveSkillTelemetrySource } from "./source.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

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
  skillRootsFingerprint: string;
  skillsVersion: number;
};

const syncedSkillsUsageCache = new Map<
  string,
  {
    destinations: Map<string, string>;
    manifestKey: string;
    skillUsagePaths: SkillUsagePath[];
  }
>();

function resolveSyncedSkillIdentity(skillKey: string, skillName: string): string {
  return JSON.stringify([skillKey, skillName]);
}

function parseSyncedSkillsManifest(value: unknown): SyncedSkillsManifest | null {
  if (
    !isRecord(value) ||
    typeof value.skillsVersion !== "number" ||
    !Number.isFinite(value.skillsVersion) ||
    typeof value.skillRootsFingerprint !== "string" ||
    !Array.isArray(value.entryKeys) ||
    !value.entryKeys.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return {
    entryKeys: value.entryKeys,
    skillRootsFingerprint: value.skillRootsFingerprint,
    skillsVersion: value.skillsVersion,
  };
}

function resolveSyncedSkillsManifestKey(manifest: SyncedSkillsManifest): string {
  return JSON.stringify([
    manifest.skillsVersion,
    manifest.skillRootsFingerprint,
    manifest.entryKeys,
  ]);
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
}): Promise<SkillUsagePath[]> {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) {
    return [];
  }

  return await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");
    const manifestPath = path.join(targetSkillsDir, SYNCED_SKILLS_MANIFEST_NAME);
    const skillsSnapshot = params.skillsSnapshot;
    const skillRoots = skillsSnapshot?.skillRoots;
    // Names and versions do not identify a source tree. Both reuse paths must
    // bind its full discovery context, or shared sandboxes retain another owner's bytes.
    const skillRootsFingerprint = sha256Hex(
      JSON.stringify([
        sourceDir,
        params.agentId ? normalizeAgentId(params.agentId) : undefined,
        params.config ? fingerprintSkillSnapshotConfig(params.config) : undefined,
        params.managedSkillsDir,
        params.bundledSkillsDir,
        params.pluginSkillsDir,
        skillRoots?.agentWorkspaceDir,
        skillRoots?.executionWorkspaceDir,
        skillsSnapshot?.librarySelections,
      ]),
    );
    const skillsVersion = getSkillsSnapshotVersion(skillRoots?.agentWorkspaceDir ?? sourceDir);

    await ensureSyncedSkillsDirectory(targetSkillsDir);
    const manifest = parseSyncedSkillsManifest(await tryReadJson<unknown>(manifestPath));
    const expectedManifestKey =
      skillsSnapshot?.version === skillsVersion
        ? resolveSyncedSkillsManifestKey({
            entryKeys: skillsSnapshot.skills
              .map((skill) => resolveSyncedSkillIdentity(skill.skillKey ?? skill.name, skill.name))
              .toSorted(),
            skillRootsFingerprint,
            skillsVersion,
          })
        : undefined;
    const cachedUsage = syncedSkillsUsageCache.get(targetSkillsDir);
    const manifestKey = manifest ? resolveSyncedSkillsManifestKey(manifest) : undefined;
    if (
      expectedManifestKey &&
      manifestKey === expectedManifestKey &&
      cachedUsage?.manifestKey === manifestKey
    ) {
      return cachedUsage.skillUsagePaths.map((entry) => ({ ...entry }));
    }

    const loadOptions = {
      config: params.config,
      skillFilter: params.skillFilter,
      agentId: params.agentId,
      eligibility: params.eligibility,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
      pluginSkillsDir: params.pluginSkillsDir,
      ...(skillsSnapshot?.skillFilter ? { skillFilter: skillsSnapshot.skillFilter } : {}),
      ...(skillsSnapshot?.skillOverrides ? { skillOverrides: skillsSnapshot.skillOverrides } : {}),
    };
    const entries = loadWorkspaceSkills(skillRoots?.agentWorkspaceDir ?? sourceDir, {
      ...loadOptions,
      executionWorkspaceDir: skillRoots?.executionWorkspaceDir,
    });
    if (skillsSnapshot?.librarySelections?.length) {
      const selectedNames = new Set(skillsSnapshot.skills.map((skill) => skill.name));
      entries.push(
        ...loadSkillLibrarySelection(skillsSnapshot.librarySelections).filter((entry) =>
          selectedNames.has(entry.skill.name),
        ),
      );
    }

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

    await fsp.rm(manifestPath, { force: true });
    const previousUsage =
      manifest?.skillsVersion === skillsVersion &&
      manifest.skillRootsFingerprint === skillRootsFingerprint &&
      cachedUsage?.manifestKey === manifestKey
        ? cachedUsage
        : undefined;
    syncedSkillsUsageCache.delete(targetSkillsDir);
    const preservedDestinations = new Set(
      plans.flatMap((plan) => {
        const destination = plan.destinationPath ? path.basename(plan.destinationPath) : null;
        return previousUsage?.destinations.get(plan.identity) === destination
          ? destination
            ? [destination]
            : []
          : [];
      }),
    );
    for (const child of await fsp.readdir(targetSkillsDir)) {
      if (!preservedDestinations.has(child)) {
        await fsp.rm(path.join(targetSkillsDir, child), { recursive: true, force: true });
      }
    }

    const skillUsagePaths: SkillUsagePath[] = [];
    let copyFailed = false;
    for (const plan of plans) {
      const { destinationPath, entry } = plan;
      if (!destinationPath) {
        continue;
      }
      if (!preservedDestinations.has(path.basename(destinationPath))) {
        try {
          const pin = skillsSnapshot?.librarySelections?.find(
            (selection) => selection.name === entry.skill.name,
          );
          if (pin) {
            const files = await readSelectedSkillLibraryFiles(pin);
            for (const file of files) {
              const target = path.join(destinationPath, file.path);
              await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
              await fsp.writeFile(
                target,
                Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"),
                { mode: file.executable ? 0o500 : 0o400, flag: "wx" },
              );
            }
          } else {
            const syncSourceDir = entry.syncSourceDir ?? entry.skill.baseDir;
            await fsp.cp(syncSourceDir, destinationPath, {
              recursive: true,
              force: true,
              filter: shouldSyncSkillPath,
            });
          }
        } catch (error) {
          if (entry.skill.source === "openclaw-library") {
            throw error;
          }
          copyFailed = true;
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          skillsLogger.warn(`Failed to copy ${entry.skill.name} to sandbox: ${message}`);
          continue;
        }
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
    if (!copyFailed) {
      const nextManifest: SyncedSkillsManifest = {
        entryKeys: plans.map((plan) => plan.identity).toSorted(),
        skillRootsFingerprint,
        skillsVersion,
      };
      await writeJson(manifestPath, nextManifest, { trailingNewline: true });
      syncedSkillsUsageCache.set(targetSkillsDir, {
        destinations: new Map(
          plans.flatMap((plan) =>
            plan.destinationPath
              ? [[plan.identity, path.basename(plan.destinationPath)] as const]
              : [],
          ),
        ),
        manifestKey: resolveSyncedSkillsManifestKey(nextManifest),
        skillUsagePaths,
      });
      pruneMapToMaxSize(syncedSkillsUsageCache, 100);
    }
    return skillUsagePaths;
  });
}

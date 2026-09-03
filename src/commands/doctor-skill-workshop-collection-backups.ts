import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pathExists } from "../infra/fs-safe.js";
import { isPathStrictlyInside } from "../infra/path-guards.js";
import type { CollectionBackupManifest } from "../skills/workshop/collection-backup.js";
import { resolveSkillCollectionBackupRoot } from "../skills/workshop/collection-paths.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";

const LEGACY_COLLECTION_BACKUP_SCHEMA = "openclaw.skill-collection-backup.v1";
const MAX_BACKUP_MANIFEST_BYTES = 1024 * 1024;

export async function listLegacyCollectionBackupRoots(
  env: NodeJS.ProcessEnv,
): Promise<{ backupRoot: string; names: string[] }> {
  const backupRoot = path.join(resolveStateDir(env), "skill-workshop", "collection-backups");
  if (!(await pathExists(backupRoot))) {
    return { backupRoot, names: [] };
  }
  const names = (await fs.readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/u.test(entry.name))
    .map((entry) => entry.name);
  return { backupRoot, names };
}

type LegacyCollectionBackup = {
  backupDir: string;
  manifest: {
    id: string;
    createdAt: string;
    workspaceDir: string;
    skillDirs: string[];
    resultSkillDirs: string[];
    resultSkillHashes: Record<string, string>;
  };
  convertedSkillDirs: string[];
  convertedResultSkillDirs: string[];
};

type LegacyWorkshopSkillRelocations = ReadonlyMap<string, string>;

export function inferWorkspaceOwnerAgentId(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): string | undefined {
  const workspaceMatches = listAgentIds(config).filter(
    (agentId) =>
      path.resolve(resolveAgentWorkspaceDir(config, agentId, env)) === path.resolve(workspaceDir),
  );
  return workspaceMatches.length === 1 ? workspaceMatches[0] : undefined;
}

function legacyCollectionSkillPath(workspaceDir: string, relativeDir: string): string {
  if (!relativeDir || path.isAbsolute(relativeDir) || relativeDir !== path.normalize(relativeDir)) {
    throw new Error(`invalid skill path ${relativeDir}`);
  }
  const absoluteDir = path.resolve(workspaceDir, relativeDir);
  const writableRoot = [
    path.resolve(workspaceDir, "skills"),
    path.resolve(workspaceDir, ".agents", "skills"),
  ].find((rootDir) => isPathStrictlyInside(rootDir, absoluteDir));
  if (!writableRoot) {
    throw new Error(`skill path is outside the workspace skill roots: ${relativeDir}`);
  }
  return path.relative(writableRoot, absoluteDir);
}

function readLegacyCollectionBackupManifest(
  value: unknown,
  backupId: string,
): LegacyCollectionBackup["manifest"] {
  const record = asNullableRecord(value);
  const skillDirs = record?.skillDirs;
  const resultSkillDirs = record?.resultSkillDirs;
  if (
    record?.schema !== LEGACY_COLLECTION_BACKUP_SCHEMA ||
    record.id !== backupId ||
    typeof record.createdAt !== "string" ||
    typeof record.workspaceDir !== "string" ||
    !Array.isArray(skillDirs) ||
    !skillDirs.every((entry): entry is string => typeof entry === "string") ||
    !Array.isArray(resultSkillDirs) ||
    !resultSkillDirs.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`invalid legacy collection backup manifest: ${backupId}`);
  }
  const resultSkillHashes = asNullableRecord(record.resultSkillHashes);
  if (!resultSkillHashes) {
    throw new Error(`invalid legacy collection backup hashes: ${backupId}`);
  }
  const parsedResultSkillHashes: Record<string, string> = {};
  for (const relativeDir of resultSkillDirs) {
    const hash = resultSkillHashes[relativeDir];
    if (typeof hash !== "string") {
      throw new Error(`invalid legacy collection backup hashes: ${backupId}`);
    }
    parsedResultSkillHashes[relativeDir] = hash;
  }
  if (Object.keys(resultSkillHashes).some((key) => !resultSkillDirs.includes(key))) {
    throw new Error(`invalid legacy collection backup hashes: ${backupId}`);
  }
  return {
    id: backupId,
    createdAt: record.createdAt,
    workspaceDir: path.resolve(record.workspaceDir),
    skillDirs: [...new Set(skillDirs)],
    resultSkillDirs: [...new Set(resultSkillDirs)],
    resultSkillHashes: parsedResultSkillHashes,
  };
}

async function readLegacyCollectionBackups(backupRoot: string): Promise<LegacyCollectionBackup[]> {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const backups: LegacyCollectionBackup[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".pending-")) {
      continue;
    }
    const manifestText = await fs.readFile(
      path.join(backupRoot, entry.name, "manifest.json"),
      "utf8",
    );
    if (Buffer.byteLength(manifestText, "utf8") > MAX_BACKUP_MANIFEST_BYTES) {
      throw new Error(`legacy collection backup manifest is too large: ${entry.name}`);
    }
    const manifest = readLegacyCollectionBackupManifest(JSON.parse(manifestText), entry.name);
    const convertedSkillDirs = manifest.skillDirs.map((relativeDir) =>
      legacyCollectionSkillPath(manifest.workspaceDir, relativeDir),
    );
    const convertedResultSkillDirs = manifest.resultSkillDirs.map((relativeDir) =>
      legacyCollectionSkillPath(manifest.workspaceDir, relativeDir),
    );
    const sourcePaths = [...new Set([...manifest.skillDirs, ...manifest.resultSkillDirs])];
    const convertedPaths = sourcePaths.map((relativeDir) =>
      legacyCollectionSkillPath(manifest.workspaceDir, relativeDir),
    );
    if (new Set(convertedPaths).size !== sourcePaths.length) {
      throw new Error(`legacy collection backup paths collide: ${entry.name}`);
    }
    backups.push({
      backupDir: path.join(backupRoot, entry.name),
      manifest,
      convertedSkillDirs,
      convertedResultSkillDirs,
    });
  }
  return backups;
}

async function readCurrentCollectionBackupCreatedAt(
  backupRoot: string,
): Promise<string | undefined> {
  const entries = await fs.readdir(backupRoot, { withFileTypes: true }).catch(() => []);
  const createdAtValues = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".pending-"))
      .map(async (entry) => {
        const record = asNullableRecord(
          JSON.parse(await fs.readFile(path.join(backupRoot, entry.name, "manifest.json"), "utf8")),
        );
        return record?.schema === "openclaw.skill-collection-backup.v2" &&
          typeof record.createdAt === "string"
          ? record.createdAt
          : undefined;
      }),
  );
  return createdAtValues
    .filter((createdAt): createdAt is string => createdAt !== undefined)
    .toSorted()
    .at(-1);
}

async function isHistoryOnlyBackup(backupDir: string): Promise<boolean> {
  try {
    const record = asNullableRecord(
      JSON.parse(await fs.readFile(path.join(backupDir, "manifest.json"), "utf8")),
    );
    return (
      record?.schema === "openclaw.skill-collection-backup.v2" &&
      typeof record.restoreUnavailableReason === "string"
    );
  } catch {
    return false;
  }
}

async function migrateLegacyCollectionBackup(
  backup: LegacyCollectionBackup,
  destinationRoot: string,
  workshopSkillRelocations: LegacyWorkshopSkillRelocations,
): Promise<{ preserveLegacyRoot: boolean }> {
  const destination = path.join(destinationRoot, backup.manifest.id);
  if (await pathExists(destination)) {
    throw new Error(`destination backup already exists: ${destination}`);
  }
  const staging = path.join(
    destinationRoot,
    `.pending-legacy-${backup.manifest.id}-${randomUUID()}`,
  );
  try {
    const affectedDirs = [
      ...new Set([...backup.manifest.skillDirs, ...backup.manifest.resultSkillDirs]),
    ];
    const unownedDirs = affectedDirs.filter(
      (relativeDir) =>
        !workshopSkillRelocations.has(path.resolve(backup.manifest.workspaceDir, relativeDir)),
    );
    if (unownedDirs.length > 0) {
      await fs.cp(
        path.join(backup.backupDir, "workspace"),
        path.join(staging, "history", "workspace"),
        { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
      );
      const manifest: CollectionBackupManifest = {
        schema: "openclaw.skill-collection-backup.v2",
        id: backup.manifest.id,
        createdAt: backup.manifest.createdAt,
        skillDirs: [],
        resultSkillDirs: [],
        resultSkillHashes: {},
        restoreUnavailableReason: `Legacy collection paths are not proven Workshop-owned: ${unownedDirs.join(", ")}`,
      };
      await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      await fs.mkdir(destinationRoot, { recursive: true });
      await fs.rename(staging, destination);
      return { preserveLegacyRoot: true };
    }
    for (const relativeDir of backup.manifest.resultSkillDirs) {
      const workshopSkillDir = workshopSkillRelocations.get(
        path.resolve(backup.manifest.workspaceDir, relativeDir),
      );
      if (!workshopSkillDir) {
        throw new Error(`legacy collection result path conversion failed: ${relativeDir}`);
      }
      const resultHash = await readSkillProposalTargetTreeSha256(workshopSkillDir);
      if (resultHash !== backup.manifest.resultSkillHashes[relativeDir]) {
        throw new Error(`legacy collection result changed after cleanup: ${relativeDir}`);
      }
    }
    await fs.mkdir(path.join(staging, "skills"), { recursive: true });
    for (const [index, relativeDir] of backup.manifest.skillDirs.entries()) {
      const source = path.join(backup.backupDir, "workspace", relativeDir);
      if (!(await pathExists(source))) {
        throw new Error(`legacy collection backup is incomplete: ${relativeDir}`);
      }
      const destinationRelativeDir = backup.convertedSkillDirs[index];
      if (!destinationRelativeDir) {
        throw new Error(`legacy collection backup path conversion failed: ${relativeDir}`);
      }
      await fs.mkdir(path.dirname(path.join(staging, "skills", destinationRelativeDir)), {
        recursive: true,
      });
      await fs.cp(source, path.join(staging, "skills", destinationRelativeDir), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    const manifest: CollectionBackupManifest = {
      schema: "openclaw.skill-collection-backup.v2",
      id: backup.manifest.id,
      createdAt: backup.manifest.createdAt,
      skillDirs: backup.convertedSkillDirs,
      resultSkillDirs: backup.convertedResultSkillDirs,
      resultSkillHashes: Object.fromEntries(
        backup.manifest.resultSkillDirs.map((relativeDir, index) => [
          backup.convertedResultSkillDirs[index],
          backup.manifest.resultSkillHashes[relativeDir],
        ]),
      ),
    };
    await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    await fs.mkdir(destinationRoot, { recursive: true });
    await fs.rename(staging, destination);
    return { preserveLegacyRoot: false };
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function migrateLegacyCollectionBackups(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  workshopSkillRelocations: LegacyWorkshopSkillRelocations = new Map(),
): Promise<{ migrated: number; warnings: string[] }> {
  const { backupRoot, names } = await listLegacyCollectionBackupRoots(env);
  if (names.length === 0) {
    return { migrated: 0, warnings: [] };
  }
  let migrated = 0;
  const warnings: string[] = [];
  for (const name of names) {
    const legacyRoot = path.join(backupRoot, name);
    try {
      const backups = await readLegacyCollectionBackups(legacyRoot);
      const workspaceDirs = new Set(backups.map((backup) => backup.manifest.workspaceDir));
      const workspaceDir = [...workspaceDirs][0];
      const ownerAgentId =
        workspaceDirs.size === 1 && workspaceDir
          ? inferWorkspaceOwnerAgentId(config, env, workspaceDir)
          : undefined;
      if (!ownerAgentId) {
        throw new Error("workspace does not map to exactly one configured agent");
      }
      const destinationRoot = resolveSkillCollectionBackupRoot(config, ownerAgentId, env);
      const alreadyArchived = await Promise.all(
        backups.map(
          async (backup) =>
            (await pathExists(path.join(destinationRoot, backup.manifest.id))) &&
            (await isHistoryOnlyBackup(path.join(destinationRoot, backup.manifest.id))),
        ),
      );
      if (alreadyArchived.every(Boolean)) {
        continue;
      }
      const currentCreatedAt = await readCurrentCollectionBackupCreatedAt(destinationRoot);
      const newestLegacy = backups.toSorted((left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt),
      )[0];
      if (
        currentCreatedAt &&
        newestLegacy &&
        currentCreatedAt.localeCompare(newestLegacy.manifest.createdAt) >= 0
      ) {
        throw new Error(`newer agent backup already exists at ${destinationRoot}`);
      }
      if (
        (
          await Promise.all(
            backups.map((backup) => pathExists(path.join(destinationRoot, backup.manifest.id))),
          )
        ).some(Boolean)
      ) {
        throw new Error(`destination backup already exists at ${destinationRoot}`);
      }
      let preserveLegacyRoot = false;
      for (const backup of backups) {
        const migration = await migrateLegacyCollectionBackup(
          backup,
          destinationRoot,
          workshopSkillRelocations,
        );
        preserveLegacyRoot ||= migration.preserveLegacyRoot;
        if (!migration.preserveLegacyRoot) {
          await fs.rm(backup.backupDir, { recursive: true, force: false });
        }
      }
      if (!preserveLegacyRoot && (await fs.readdir(legacyRoot)).length === 0) {
        await fs.rmdir(legacyRoot);
      }
      migrated += 1;
    } catch (error) {
      warnings.push(`Preserved legacy collection backup root ${legacyRoot}: ${String(error)}`);
    }
  }
  return { migrated, warnings };
}

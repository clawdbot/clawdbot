import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { assertWorkspaceStateMigrationReady } from "../agents/workspace-legacy-state.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pathExists } from "../infra/fs-safe.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { isPathStrictlyInside } from "../infra/path-guards.js";
import { resolveSkillManifestMetadata } from "../skills/loading/frontmatter.js";
import { readSkillFrontmatterSafe } from "../skills/loading/local-loader.js";
import { resolveSkillDiscoveryLimits } from "../skills/loading/skill-root-discovery.js";
import type { CollectionBackupManifest } from "../skills/workshop/collection-backup.js";
import { resolveSkillCollectionBackupRoot } from "../skills/workshop/collection-paths.js";
import { readSkillCollectionBackupDrops } from "../skills/workshop/collection-review-state.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import { parseSkillProposalRow } from "../skills/workshop/store-sqlite-record.js";
import { openSkillWorkshopStore } from "../skills/workshop/store-sqlite-schema.js";
import { resolveSkillProposalTarget } from "../skills/workshop/store.js";

const LEGACY_COLLECTION_BACKUP_SCHEMA = "openclaw.skill-collection-backup.v1";
const MAX_BACKUP_MANIFEST_BYTES = 1024 * 1024;

type LegacyCollectionBackupRoot =
  | {
      legacyRoot: string;
      backups: LegacyCollectionBackup[];
      ownerAgentId: string;
      destinationRoot: string;
    }
  | { legacyRoot: string; warning: string };

export async function listPendingLegacyCollectionBackupRoots(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<LegacyCollectionBackupRoot[]> {
  const backupRoot = path.join(resolveStateDir(env), "skill-workshop", "collection-backups");
  if (!(await pathExists(backupRoot))) {
    return [];
  }
  const names = (await fs.readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/u.test(entry.name))
    .map((entry) => entry.name);
  const roots: LegacyCollectionBackupRoot[] = [];
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
      assertWorkspaceStateMigrationReady({ workspaceDirs: [...workspaceDirs], env });
      const destinationRoot = resolveSkillCollectionBackupRoot(config, ownerAgentId, env);
      const alreadyArchived = await Promise.all(
        backups.map((backup) =>
          isHistoryOnlyBackup(path.join(destinationRoot, backup.manifest.id)),
        ),
      );
      // History-only archives retain their source. Exclude each completed copy
      // so an interrupted root can resume its remaining backups.
      const pendingBackups = backups.filter((_, index) => !alreadyArchived[index]);
      if (pendingBackups.length > 0) {
        roots.push({ legacyRoot, backups: pendingBackups, ownerAgentId, destinationRoot });
      }
    } catch (error) {
      roots.push({
        legacyRoot,
        warning: `Preserved legacy collection backup root ${legacyRoot}: ${String(error)}`,
      });
    }
  }
  return roots;
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

export function inferWorkspaceOwnerAgentId(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  workspaceDir: string,
): string | undefined {
  const workspaceMatches = listAgentIds(config).filter(
    (agentId) =>
      resolveCanonicalWorkspacePath(resolveAgentWorkspaceDir(config, agentId, env)) ===
      resolveCanonicalWorkspacePath(workspaceDir),
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

async function readRestorableCollectionBackupCreatedAt(
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
          typeof record.restoreUnavailableReason !== "string" &&
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
      record.id === path.basename(backupDir) &&
      typeof record.restoreUnavailableReason === "string"
    );
  } catch {
    return false;
  }
}

async function readLegacyBackupSkillKey(
  backup: LegacyCollectionBackup,
  relativeDir: string,
  fallbackKey: string | undefined,
  maxSkillFileBytes: number,
): Promise<string | undefined> {
  const skillDir = path.join(backup.backupDir, "workspace", relativeDir);
  const frontmatter = readSkillFrontmatterSafe({
    rootDir: skillDir,
    filePath: path.join(skillDir, "SKILL.md"),
    maxBytes: maxSkillFileBytes,
  });
  if (!frontmatter) {
    return (await pathExists(skillDir)) ? undefined : fallbackKey;
  }
  return (resolveSkillManifestMetadata(frontmatter)?.skillKey ?? frontmatter.name)?.trim();
}

async function proveLegacyCollectionBackupOwnership(
  backup: LegacyCollectionBackup,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ownerAgentId: string,
): Promise<ReadonlySet<string>> {
  const provenPaths = new Set<string>();
  const backedUpDirs = new Set(backup.manifest.skillDirs);
  const resultDirs = new Set(backup.manifest.resultSkillDirs);
  const droppedNames = readSkillCollectionBackupDrops(ownerAgentId, backup.manifest.id, { env });
  const { database, kysely } = openSkillWorkshopStore({ env });
  const appliedCreates = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("owner_agent_id", "=", ownerAgentId)
      .where("kind", "=", "create"),
  ).rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record?.appliedAt !== undefined ? [record] : [];
  });
  const maxSkillFileBytes = resolveSkillDiscoveryLimits(config).maxSkillFileBytes;
  for (const relativeDir of new Set([...backedUpDirs, ...resultDirs])) {
    const legacyPath = path.resolve(backup.manifest.workspaceDir, relativeDir);
    if (await pathExists(legacyPath)) {
      continue;
    }
    const skillKey = await readLegacyBackupSkillKey(
      backup,
      relativeDir,
      backedUpDirs.has(relativeDir) ? undefined : path.basename(relativeDir),
      maxSkillFileBytes,
    );
    if (!skillKey) {
      continue;
    }
    const target = resolveSkillProposalTarget({
      skillName: skillKey,
      config,
      agentId: ownerAgentId,
      env,
    });
    const targetExists = await pathExists(target.skillDir);
    if (!resultDirs.has(relativeDir)) {
      // The exact review binds this drop to its backup; an applied create binds
      // its owner, path, and key. Stale status and authorship are not ownership.
      if (
        !targetExists &&
        droppedNames.has(skillKey) &&
        appliedCreates.some(
          (record) =>
            path.resolve(record.target.skillDir) === legacyPath &&
            path.resolve(record.target.skillFile) === path.join(legacyPath, "SKILL.md") &&
            record.target.skillKey === skillKey,
        )
      ) {
        provenPaths.add(legacyPath);
      }
      continue;
    }
    if (!targetExists) {
      continue;
    }
    const resultHash = await readSkillProposalTargetTreeSha256(target.skillDir);
    if (resultHash === backup.manifest.resultSkillHashes[relativeDir]) {
      provenPaths.add(legacyPath);
    }
  }
  return provenPaths;
}

async function verifyLegacyCollectionBackupCopy(
  backup: LegacyCollectionBackup,
  destination: string,
  manifest: CollectionBackupManifest,
): Promise<void> {
  const published: unknown = JSON.parse(
    await fs.readFile(path.join(destination, "manifest.json"), "utf8"),
  );
  if (!isDeepStrictEqual(published, manifest)) {
    throw new Error(`destination backup manifest differs: ${destination}`);
  }
  for (const [index, relativeDir] of backup.manifest.skillDirs.entries()) {
    const source = path.join(backup.backupDir, "workspace", relativeDir);
    const copied = path.join(destination, "skills", backup.convertedSkillDirs[index]!);
    // Tree hashing treats missing roots as empty; retirement requires both copies.
    await Promise.all([fs.access(source), fs.access(copied)]);
    const [sourceHash, copiedHash] = await Promise.all(
      [source, copied].map((skillDir) =>
        readSkillProposalTargetTreeSha256(skillDir, { includeRootMetadata: true }),
      ),
    );
    if (sourceHash !== copiedHash) {
      throw new Error(`destination backup contents differ: ${destination}`);
    }
  }
}

async function migrateLegacyCollectionBackup(
  backup: LegacyCollectionBackup,
  destinationRoot: string,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ownerAgentId: string,
  newerBackupExists: boolean,
): Promise<void> {
  const destination = path.join(destinationRoot, backup.manifest.id);
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
  if (!(await pathExists(destination))) {
    if (newerBackupExists) {
      throw new Error(`newer agent backup already exists at ${destinationRoot}`);
    }
    const staging = path.join(
      destinationRoot,
      `.pending-legacy-${backup.manifest.id}-${randomUUID()}`,
    );
    try {
      const affectedDirs = [
        ...new Set([...backup.manifest.skillDirs, ...backup.manifest.resultSkillDirs]),
      ];
      const provenLegacyPaths = await proveLegacyCollectionBackupOwnership(
        backup,
        config,
        env,
        ownerAgentId,
      );
      const unownedDirs = affectedDirs.filter(
        (relativeDir) =>
          !provenLegacyPaths.has(path.resolve(backup.manifest.workspaceDir, relativeDir)),
      );
      if (unownedDirs.length > 0) {
        await fs.cp(
          path.join(backup.backupDir, "workspace"),
          path.join(staging, "history", "workspace"),
          { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
        );
        const historyManifest: CollectionBackupManifest = {
          schema: "openclaw.skill-collection-backup.v2",
          id: backup.manifest.id,
          createdAt: backup.manifest.createdAt,
          skillDirs: [],
          resultSkillDirs: [],
          resultSkillHashes: {},
          restoreUnavailableReason: `Legacy collection paths are not proven Workshop-owned: ${unownedDirs.join(", ")}`,
        };
        await fs.writeFile(
          path.join(staging, "manifest.json"),
          JSON.stringify(historyManifest, null, 2),
        );
        await fs.mkdir(destinationRoot, { recursive: true });
        await fs.rename(staging, destination);
        return;
      }
      await fs.mkdir(path.join(staging, "skills"), { recursive: true });
      for (const [index, relativeDir] of backup.manifest.skillDirs.entries()) {
        const source = path.join(backup.backupDir, "workspace", relativeDir);
        if (!(await pathExists(source))) {
          throw new Error(`legacy collection backup is incomplete: ${relativeDir}`);
        }
        const destinationRelativeDir = backup.convertedSkillDirs[index]!;
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
      await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
      await fs.mkdir(destinationRoot, { recursive: true });
      await fs.rename(staging, destination);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  // New publication and interrupted cleanup share the same full-copy proof.
  await verifyLegacyCollectionBackupCopy(backup, destination, manifest);
  await fs.rm(backup.backupDir, { recursive: true, force: false });
}

export async function migrateLegacyCollectionBackups(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ migrated: number; warnings: string[] }> {
  const roots = await listPendingLegacyCollectionBackupRoots(config, env);
  let migrated = 0;
  const warnings: string[] = [];
  for (const root of roots) {
    if ("warning" in root) {
      warnings.push(root.warning);
      continue;
    }
    const { legacyRoot, backups, ownerAgentId, destinationRoot } = root;
    try {
      const currentCreatedAt = await readRestorableCollectionBackupCreatedAt(destinationRoot);
      const newestLegacy = backups.toSorted((left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt),
      )[0];
      const newerBackupExists = Boolean(
        currentCreatedAt &&
        newestLegacy &&
        currentCreatedAt.localeCompare(newestLegacy.manifest.createdAt) >= 0,
      );
      for (const backup of backups) {
        await migrateLegacyCollectionBackup(
          backup,
          destinationRoot,
          config,
          env,
          ownerAgentId,
          newerBackupExists,
        );
      }
      if ((await fs.readdir(legacyRoot)).length === 0) {
        await fs.rmdir(legacyRoot);
      }
      migrated += 1;
    } catch (error) {
      warnings.push(`Preserved legacy collection backup root ${legacyRoot}: ${String(error)}`);
    }
  }
  return { migrated, warnings };
}

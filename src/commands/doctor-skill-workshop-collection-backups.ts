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
      if (backups.length === 0) {
        continue;
      }
      const workspaceDirs = new Set(backups.map((backup) => backup.workspaceDir));
      const workspaceDir = [...workspaceDirs][0];
      const ownerAgentId =
        workspaceDirs.size === 1 && workspaceDir
          ? inferWorkspaceOwnerAgentId(config, env, workspaceDir)
          : undefined;
      if (!ownerAgentId) {
        throw new Error("workspace does not map to exactly one configured agent");
      }
      assertWorkspaceStateMigrationReady({
        workspaceDirs: [...workspaceDirs],
        env,
        operation: "doctor",
      });
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
  workspaceDir: string;
  manifest: CollectionBackupManifest;
  sourceDirs: ReadonlyMap<string, string>;
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
  backupDir: string,
): LegacyCollectionBackup {
  const backupId = path.basename(backupDir);
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
  const workspaceDir = path.resolve(record.workspaceDir);
  const convertedDirs = new Map(
    [...new Set([...skillDirs, ...resultSkillDirs])].map((relativeDir) => [
      relativeDir,
      legacyCollectionSkillPath(workspaceDir, relativeDir),
    ]),
  );
  const sourceDirs = new Map(
    [...convertedDirs].map(([source, destination]) => [destination, source]),
  );
  if (sourceDirs.size !== convertedDirs.size) {
    throw new Error(`legacy collection backup paths collide: ${backupId}`);
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
    parsedResultSkillHashes[convertedDirs.get(relativeDir)!] = hash;
  }
  if (Object.keys(resultSkillHashes).some((key) => !resultSkillDirs.includes(key))) {
    throw new Error(`invalid legacy collection backup hashes: ${backupId}`);
  }
  return {
    backupDir,
    workspaceDir,
    sourceDirs,
    manifest: {
      schema: "openclaw.skill-collection-backup.v2",
      id: backupId,
      createdAt: record.createdAt,
      skillDirs: [...new Set(skillDirs)].map((relativeDir) => convertedDirs.get(relativeDir)!),
      resultSkillDirs: [...new Set(resultSkillDirs)].map((relativeDir) =>
        convertedDirs.get(relativeDir)!,
      ),
      resultSkillHashes: parsedResultSkillHashes,
    },
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
    backups.push(
      readLegacyCollectionBackupManifest(
        JSON.parse(manifestText),
        path.join(backupRoot, entry.name),
      ),
    );
  }
  return backups;
}

async function hasNewerUnrelatedCollectionBackup(
  backupRoot: string,
  backups: readonly LegacyCollectionBackup[],
): Promise<boolean> {
  const pending = new Map(backups.map((backup) => [backup.manifest.id, backup]));
  const newestLegacy = backups
    .map((backup) => backup.manifest.createdAt)
    .toSorted()
    .at(-1)!;
  const entries = await fs.readdir(backupRoot, { withFileTypes: true }).catch(() => []);
  const newerBackups = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".pending-"))
      .map(async (entry) => {
        const backup = pending.get(entry.name);
        if (backup) {
          // Only an exact published copy belongs to this interrupted batch.
          await verifyLegacyCollectionBackupCopy(backup, path.join(backupRoot, entry.name));
          return false;
        }
        const record = asNullableRecord(
          JSON.parse(await fs.readFile(path.join(backupRoot, entry.name, "manifest.json"), "utf8")),
        );
        return (
          record?.schema === "openclaw.skill-collection-backup.v2" &&
          typeof record.restoreUnavailableReason !== "string" &&
          typeof record.createdAt === "string" &&
          record.createdAt.localeCompare(newestLegacy) >= 0
        );
      }),
  );
  return newerBackups.some(Boolean);
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
  const skillDir = path.join(backup.backupDir, "workspace", backup.sourceDirs.get(relativeDir)!);
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

async function findUnownedLegacyCollectionBackupDirs(
  backup: LegacyCollectionBackup,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ownerAgentId: string,
): Promise<string[]> {
  const unownedDirs = new Set(backup.sourceDirs.values());
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
  for (const [relativeDir, sourceDir] of backup.sourceDirs) {
    const legacyPath = path.resolve(backup.workspaceDir, sourceDir);
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
        unownedDirs.delete(sourceDir);
      }
      continue;
    }
    if (!targetExists) {
      continue;
    }
    const resultHash = await readSkillProposalTargetTreeSha256(target.skillDir);
    if (resultHash === backup.manifest.resultSkillHashes[relativeDir]) {
      unownedDirs.delete(sourceDir);
    }
  }
  return [...unownedDirs];
}

async function verifyLegacyCollectionBackupCopy(
  backup: LegacyCollectionBackup,
  destination: string,
): Promise<void> {
  const published: unknown = JSON.parse(
    await fs.readFile(path.join(destination, "manifest.json"), "utf8"),
  );
  if (!isDeepStrictEqual(published, backup.manifest)) {
    throw new Error(`destination backup manifest differs: ${destination}`);
  }
  for (const relativeDir of backup.manifest.skillDirs) {
    const source = path.join(backup.backupDir, "workspace", backup.sourceDirs.get(relativeDir)!);
    const copied = path.join(destination, "skills", relativeDir);
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

async function publishLegacyCollectionBackup(
  backup: LegacyCollectionBackup,
  destinationRoot: string,
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ownerAgentId: string,
  newerBackupExists: boolean,
): Promise<boolean> {
  const destination = path.join(destinationRoot, backup.manifest.id);
  if (await pathExists(destination)) {
    return true;
  }
  if (newerBackupExists) {
    throw new Error(`newer agent backup already exists at ${destinationRoot}`);
  }
  const unownedDirs = await findUnownedLegacyCollectionBackupDirs(
    backup,
    config,
    env,
    ownerAgentId,
  );
  const restorable = unownedDirs.length === 0;
  const manifest: CollectionBackupManifest = restorable
    ? backup.manifest
    : {
        ...backup.manifest,
        skillDirs: [],
        resultSkillDirs: [],
        resultSkillHashes: {},
        restoreUnavailableReason: `Legacy collection paths are not proven Workshop-owned: ${unownedDirs.join(", ")}`,
      };
  const copies = restorable
    ? backup.manifest.skillDirs.map((relativeDir) => ({
        source: path.join(backup.backupDir, "workspace", backup.sourceDirs.get(relativeDir)!),
        relativeDir: path.join("skills", relativeDir),
      }))
    : [
        {
          source: path.join(backup.backupDir, "workspace"),
          relativeDir: path.join("history", "workspace"),
        },
      ];
  const staging = path.join(
    destinationRoot,
    `.pending-legacy-${backup.manifest.id}-${randomUUID()}`,
  );
  try {
    await fs.mkdir(path.join(staging, restorable ? "skills" : "history"), { recursive: true });
    for (const copy of copies) {
      const copied = path.join(staging, copy.relativeDir);
      await fs.mkdir(path.dirname(copied), { recursive: true });
      await fs.cp(copy.source, copied, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
    }
    await fs.writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  return restorable;
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
      const newerBackupExists = await hasNewerUnrelatedCollectionBackup(destinationRoot, backups);
      const restorable: LegacyCollectionBackup[] = [];
      for (const backup of backups) {
        const canRetireSource = await publishLegacyCollectionBackup(
          backup,
          destinationRoot,
          config,
          env,
          ownerAgentId,
          newerBackupExists,
        );
        if (canRetireSource) {
          restorable.push(backup);
        }
      }
      // Retain every source until the whole batch is published and verified.
      // Otherwise an interrupted newest-first batch loses its recovery evidence.
      for (const backup of restorable) {
        await verifyLegacyCollectionBackupCopy(
          backup,
          path.join(destinationRoot, backup.manifest.id),
        );
      }
      for (const backup of restorable) {
        await fs.rm(backup.backupDir, { recursive: true, force: false });
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

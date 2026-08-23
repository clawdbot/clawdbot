import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import type {
  SkillCollectionPlanEntry,
  WritableSkillCollectionEntry,
} from "./collection-contracts.js";
import {
  canonicalSkillCollectionWorkspace,
  resolveSkillCollectionBackupRoot,
} from "./collection-paths.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";

const BACKUP_SCHEMA = "openclaw.skill-collection-backup.v1";
export type CollectionBackupManifest = {
  schema: typeof BACKUP_SCHEMA;
  id: string;
  createdAt: string;
  workspaceDir: string;
  skillDirs: string[];
  resultSkillDirs: string[];
  resultSkillHashes: Record<string, string>;
};

export async function createCollectionBackup(params: {
  workspaceDir: string;
  current: readonly WritableSkillCollectionEntry[];
  plan: readonly SkillCollectionPlanEntry[];
  env?: NodeJS.ProcessEnv;
}): Promise<{
  backupDir: string;
  committedBackupDir: string;
  backupRoot: string;
  manifest: CollectionBackupManifest;
}> {
  const backupRoot = resolveSkillCollectionBackupRoot(params.workspaceDir, params.env);
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = path.join(backupRoot, `.pending-${id}`);
  const committedBackupDir = path.join(backupRoot, id);
  const currentByName = new Map(params.current.map((skill) => [skill.name, skill]));
  // A restore must never rewrite a kept, externally owned skill. Back up only paths
  // this transaction may mutate; newly created result paths are removed on restore.
  const skillDirs = [
    ...new Set(
      params.plan.flatMap((entry) => {
        if (entry.action === "keep") {
          return [];
        }
        const existing = currentByName.get(entry.name);
        return existing ? [path.relative(params.workspaceDir, existing.baseDir)] : [];
      }),
    ),
  ].toSorted();
  const manifest: CollectionBackupManifest = {
    schema: BACKUP_SCHEMA,
    id,
    createdAt: new Date().toISOString(),
    workspaceDir: params.workspaceDir,
    skillDirs,
    resultSkillDirs: params.plan
      .filter((entry) => entry.action === "write")
      .map((entry) => {
        const existing = currentByName.get(entry.name);
        return path.relative(
          params.workspaceDir,
          existing?.baseDir ?? path.join(params.workspaceDir, "skills", entry.name),
        );
      }),
    resultSkillHashes: {},
  };
  await fs.mkdir(path.join(backupDir, "workspace"), { recursive: true });
  for (const relativeDir of skillDirs) {
    await fs.cp(
      path.join(params.workspaceDir, relativeDir),
      path.join(backupDir, "workspace", relativeDir),
      {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      },
    );
  }
  await fs.writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { backupDir, committedBackupDir, backupRoot, manifest };
}

export async function commitCollectionBackup(
  workspaceDir: string,
  backup: Awaited<ReturnType<typeof createCollectionBackup>>,
): Promise<void> {
  for (const relativeDir of backup.manifest.resultSkillDirs) {
    backup.manifest.resultSkillHashes[relativeDir] = await readSkillProposalTargetTreeSha256(
      path.join(workspaceDir, relativeDir),
    );
  }
  await fs.writeFile(
    path.join(backup.backupDir, "manifest.json"),
    JSON.stringify(backup.manifest, null, 2),
  );
  await fs.rename(backup.backupDir, backup.committedBackupDir);
}

export async function discardPendingCollectionBackup(
  backup: Awaited<ReturnType<typeof createCollectionBackup>>,
): Promise<void> {
  if (!(await pathExists(backup.backupDir))) {
    return;
  }
  await removePathWithinRoot({
    rootDir: backup.backupRoot,
    relativePath: path.basename(backup.backupDir),
    recursive: true,
    force: true,
  });
}

export async function readCollectionBackupManifest(params: {
  backupDir: string;
  backupId: string;
  workspaceDir: string;
}): Promise<CollectionBackupManifest> {
  const record = asNullableRecord(
    JSON.parse(await fs.readFile(path.join(params.backupDir, "manifest.json"), "utf8")),
  );
  const skillDirs = readBackupSkillDirs(record?.skillDirs, "skillDirs", params.workspaceDir);
  const resultSkillDirs = readBackupSkillDirs(
    record?.resultSkillDirs,
    "resultSkillDirs",
    params.workspaceDir,
  );
  const resultSkillHashes = asNullableRecord(record?.resultSkillHashes);
  if (
    record?.schema !== BACKUP_SCHEMA ||
    record.id !== params.backupId ||
    typeof record.createdAt !== "string" ||
    typeof record.workspaceDir !== "string" ||
    canonicalSkillCollectionWorkspace(record.workspaceDir) !== params.workspaceDir ||
    !resultSkillHashes ||
    Object.keys(resultSkillHashes).some((relativeDir) => !resultSkillDirs.includes(relativeDir))
  ) {
    throw new Error(`Invalid skill collection backup: ${params.backupId}`);
  }
  const parsedResultSkillHashes: Record<string, string> = {};
  for (const relativeDir of resultSkillDirs) {
    const hash = resultSkillHashes[relativeDir];
    if (typeof hash !== "string") {
      throw new Error(`Invalid skill collection backup: ${params.backupId}`);
    }
    parsedResultSkillHashes[relativeDir] = hash;
  }
  for (const relativeDir of skillDirs) {
    if (!(await pathExists(path.join(params.backupDir, "workspace", relativeDir)))) {
      throw new Error(`Skill collection backup is incomplete: ${relativeDir}`);
    }
  }
  return {
    schema: BACKUP_SCHEMA,
    id: params.backupId,
    createdAt: record.createdAt,
    workspaceDir: params.workspaceDir,
    skillDirs,
    resultSkillDirs,
    resultSkillHashes: parsedResultSkillHashes,
  };
}

function readBackupSkillDirs(value: unknown, label: string, workspaceDir: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`Invalid skill collection backup ${label}.`);
  }
  const skillRoots = [
    path.join(workspaceDir, "skills"),
    path.join(workspaceDir, ".agents", "skills"),
  ];
  for (const relativeDir of value) {
    const absoluteDir = path.resolve(workspaceDir, relativeDir);
    const insideWritableRoot = skillRoots.some((rootDir) => {
      const relativeToRoot = path.relative(rootDir, absoluteDir);
      return (
        relativeToRoot &&
        !path.isAbsolute(relativeToRoot) &&
        !relativeToRoot.startsWith(`..${path.sep}`)
      );
    });
    if (!insideWritableRoot) {
      throw new Error(`Skill collection backup path is outside the workspace: ${relativeDir}`);
    }
  }
  return [...new Set(value)];
}

export async function latestCommittedBackupId(backupRoot: string): Promise<string | undefined> {
  if (!(await pathExists(backupRoot))) {
    return undefined;
  }
  return (await fs.readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".pending-"))
    .map((entry) => entry.name)
    .toSorted()
    .at(-1);
}

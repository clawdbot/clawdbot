import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { pathExists } from "../../infra/fs-safe.js";
import { isPathStrictlyInside } from "../../infra/path-guards.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";

const BACKUP_SCHEMA = "openclaw.skill-collection-backup.v2";

export type CollectionBackupManifest = {
  schema: typeof BACKUP_SCHEMA;
  id: string;
  createdAt: string;
  skillDirs: string[];
  resultSkillDirs: string[];
  resultSkillHashes: Record<string, string>;
  restoreUnavailableReason?: string;
};

export async function readCollectionBackupManifest(params: {
  backupDir: string;
  backupId: string;
  skillsRoot: string;
}): Promise<CollectionBackupManifest> {
  const record = asNullableRecord(
    JSON.parse(await fs.readFile(path.join(params.backupDir, "manifest.json"), "utf8")),
  );
  const skillDirs = readBackupSkillDirs(record?.skillDirs, "skillDirs", params.skillsRoot);
  const resultSkillDirs = readBackupSkillDirs(
    record?.resultSkillDirs,
    "resultSkillDirs",
    params.skillsRoot,
  );
  const resultSkillHashes = asNullableRecord(record?.resultSkillHashes);
  const restoreUnavailableReason = record?.restoreUnavailableReason;
  if (
    record?.schema !== BACKUP_SCHEMA ||
    record.id !== params.backupId ||
    typeof record.createdAt !== "string" ||
    !resultSkillHashes ||
    (restoreUnavailableReason !== undefined && typeof restoreUnavailableReason !== "string") ||
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
    const savedSkillDir = path.join(params.backupDir, "skills", relativeDir);
    if (!(await pathExists(savedSkillDir))) {
      throw new Error(`Skill collection backup is incomplete: ${relativeDir}`);
    }
    // Legacy hashes omitted deep content. Verify retained originals too, or deleting
    // an omitted subtree from the result could let restore resurrect it unnoticed.
    if (resultSkillDirs.includes(relativeDir)) {
      await readSkillProposalTargetTreeSha256(savedSkillDir);
    }
  }
  return {
    schema: BACKUP_SCHEMA,
    id: params.backupId,
    createdAt: record.createdAt,
    skillDirs,
    resultSkillDirs,
    resultSkillHashes: parsedResultSkillHashes,
    ...(typeof restoreUnavailableReason === "string" ? { restoreUnavailableReason } : {}),
  };
}

function readBackupSkillDirs(value: unknown, label: string, skillsRoot: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`Invalid skill collection backup ${label}.`);
  }
  const resolvedRoot = path.resolve(skillsRoot);
  for (const relativeDir of value) {
    const resolvedDir = path.resolve(resolvedRoot, relativeDir);
    if (
      !relativeDir ||
      path.isAbsolute(relativeDir) ||
      relativeDir !== path.normalize(relativeDir) ||
      !isPathStrictlyInside(resolvedRoot, resolvedDir)
    ) {
      throw new Error(
        `Skill collection backup path is outside the Skill Workshop directory: ${relativeDir}`,
      );
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

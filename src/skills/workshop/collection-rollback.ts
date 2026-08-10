import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";
import {
  restoreWorkspaceSkillMutation,
  type PreparedWorkspaceSkillMutation,
} from "../lifecycle/workspace-skill-write.js";

export async function rollbackSkillCollectionMutation(params: {
  workspaceDir: string;
  backupDir: string;
  appliedWrites: readonly PreparedWorkspaceSkillMutation[];
  droppedSkills: readonly { name: string; baseDir: string }[];
}): Promise<void> {
  const errors: unknown[] = [];
  for (const mutation of params.appliedWrites.toReversed()) {
    try {
      await restoreWorkspaceSkillMutation(mutation);
      if (mutation.mode === "create") {
        await fs.rmdir(mutation.skillDir).catch((error: unknown) => {
          const code = asNullableRecord(error)?.code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
            throw error;
          }
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  for (const skill of params.droppedSkills.toReversed()) {
    try {
      if (await pathExists(skill.baseDir)) {
        throw new Error(`Dropped skill changed before restoration: ${skill.name}`);
      }
      await fs.mkdir(path.dirname(skill.baseDir), { recursive: true });
      await fs.cp(
        path.join(params.backupDir, "workspace", path.relative(params.workspaceDir, skill.baseDir)),
        skill.baseDir,
        { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to restore the previous skill collection.");
  }
}

export async function restoreSkillCollectionBackupTransaction(params: {
  workspaceDir: string;
  backupDir: string;
  skillDirs: readonly string[];
  resultSkillDirs: readonly string[];
}): Promise<void> {
  const rollbackDir = path.join(params.backupDir, `.restore-${randomUUID()}`);
  try {
    await fs.mkdir(path.join(rollbackDir, "workspace"), { recursive: true });
    for (const relativeDir of params.resultSkillDirs) {
      await fs.cp(
        path.join(params.workspaceDir, relativeDir),
        path.join(rollbackDir, "workspace", relativeDir),
        { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
      );
    }
  } catch (error) {
    await discardRestoreSnapshot(params.backupDir, rollbackDir);
    throw error;
  }
  let discardSnapshot = false;
  try {
    await restoreSkillCollectionBackup(params);
    discardSnapshot = true;
  } catch (error) {
    try {
      await restoreSkillCollectionBackup({
        workspaceDir: params.workspaceDir,
        backupDir: rollbackDir,
        skillDirs: params.resultSkillDirs,
        resultSkillDirs: [...new Set([...params.skillDirs, ...params.resultSkillDirs])],
      });
      discardSnapshot = true;
    } catch (rollbackError) {
      const failure = new Error(
        "Skill collection restore failed and the current collection was not restored.",
        { cause: error },
      );
      Object.assign(failure, { rollbackError });
      throw failure;
    }
    throw error;
  } finally {
    if (discardSnapshot) {
      await discardRestoreSnapshot(params.backupDir, rollbackDir);
    }
  }
}

async function restoreSkillCollectionBackup(params: {
  workspaceDir: string;
  backupDir: string;
  skillDirs: readonly string[];
  resultSkillDirs: readonly string[];
}): Promise<void> {
  const removeDirs = new Set([
    ...params.skillDirs.map((relativeDir) => path.join(params.workspaceDir, relativeDir)),
    ...params.resultSkillDirs.map((relativeDir) => path.join(params.workspaceDir, relativeDir)),
  ]);
  for (const skillDir of [...removeDirs].toSorted((left, right) => right.length - left.length)) {
    if (await pathExists(skillDir)) {
      await removeSkillCollectionDirectory(params.workspaceDir, skillDir);
    }
  }
  for (const relativeDir of params.skillDirs) {
    await fs.mkdir(path.dirname(path.join(params.workspaceDir, relativeDir)), { recursive: true });
    await fs.cp(
      path.join(params.backupDir, "workspace", relativeDir),
      path.join(params.workspaceDir, relativeDir),
      { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
    );
  }
}

async function discardRestoreSnapshot(backupDir: string, rollbackDir: string): Promise<void> {
  await removePathWithinRoot({
    rootDir: backupDir,
    relativePath: path.basename(rollbackDir),
    recursive: true,
    force: true,
  }).catch((error: unknown) => {
    logWarn(`skill-workshop: failed to discard restore snapshot: ${String(error)}`);
  });
}

export async function removeSkillCollectionDirectory(
  workspaceDir: string,
  skillDir: string,
): Promise<void> {
  const relativePath = path.relative(workspaceDir, skillDir);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error(`Skill directory must be inside the workspace: ${skillDir}`);
  }
  await removePathWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    recursive: true,
    force: false,
  });
}

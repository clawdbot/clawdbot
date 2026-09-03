import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";
import {
  restoreWorkspaceSkillMutation,
  type PreparedWorkspaceSkillMutation,
} from "../lifecycle/workspace-skill-write.js";

export async function rollbackSkillCollectionMutation(params: {
  skillsRoot: string;
  appliedWrites: readonly PreparedWorkspaceSkillMutation[];
  droppedSkills: readonly { skillKey: string; baseDir: string; stagedDir: string }[];
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
  const skillsRootHandle = await root(params.skillsRoot);
  for (const skill of params.droppedSkills.toReversed()) {
    try {
      const baseRelativePath = relativeSkillCollectionPath(params.skillsRoot, skill.baseDir);
      if (await skillsRootHandle.exists(baseRelativePath)) {
        throw new Error(`Dropped skill changed before restoration: ${skill.skillKey}`);
      }
      await skillsRootHandle.move(
        relativeSkillCollectionPath(params.skillsRoot, skill.stagedDir),
        baseRelativePath,
        { overwrite: true },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to restore the previous skill collection.");
  }
}

export async function stageSkillCollectionDrop(params: {
  skillsRoot: string;
  skillKey: string;
  baseDir: string;
}): Promise<{ skillKey: string; baseDir: string; stagedDir: string }> {
  const stagedDir = path.join(
    path.dirname(params.baseDir),
    `.openclaw-drop-${path.basename(params.baseDir)}-${randomUUID()}`,
  );
  const skillsRootHandle = await root(params.skillsRoot);
  await skillsRootHandle.move(
    relativeSkillCollectionPath(params.skillsRoot, params.baseDir),
    relativeSkillCollectionPath(params.skillsRoot, stagedDir),
    { overwrite: true },
  );
  return { skillKey: params.skillKey, baseDir: params.baseDir, stagedDir };
}

export async function discardStagedSkillCollectionDrops(
  skillsRoot: string,
  droppedSkills: readonly { stagedDir: string }[],
): Promise<void> {
  for (const skill of droppedSkills) {
    await removeSkillCollectionDirectory(skillsRoot, skill.stagedDir).catch((error: unknown) => {
      logWarn(`skill-workshop: failed to discard staged skill drop: ${String(error)}`);
    });
  }
}

export async function restoreSkillCollectionBackupTransaction(params: {
  skillsRoot: string;
  backupDir: string;
  skillDirs: readonly string[];
  resultSkillDirs: readonly string[];
}): Promise<void> {
  const rollbackDir = path.join(params.backupDir, `.restore-${randomUUID()}`);
  try {
    await fs.mkdir(path.join(rollbackDir, "skills"), { recursive: true });
    for (const relativeDir of params.resultSkillDirs) {
      await fs.cp(
        path.join(params.skillsRoot, relativeDir),
        path.join(rollbackDir, "skills", relativeDir),
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
        skillsRoot: params.skillsRoot,
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
  skillsRoot: string;
  backupDir: string;
  skillDirs: readonly string[];
  resultSkillDirs: readonly string[];
}): Promise<void> {
  const removeDirs = new Set([
    ...params.skillDirs.map((relativeDir) => path.join(params.skillsRoot, relativeDir)),
    ...params.resultSkillDirs.map((relativeDir) => path.join(params.skillsRoot, relativeDir)),
  ]);
  for (const skillDir of [...removeDirs].toSorted((left, right) => right.length - left.length)) {
    if (await pathExists(skillDir)) {
      await removeSkillCollectionDirectory(params.skillsRoot, skillDir);
    }
  }
  for (const relativeDir of params.skillDirs) {
    await fs.mkdir(path.dirname(path.join(params.skillsRoot, relativeDir)), { recursive: true });
    await fs.cp(
      path.join(params.backupDir, "skills", relativeDir),
      path.join(params.skillsRoot, relativeDir),
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

async function removeSkillCollectionDirectory(skillsRoot: string, skillDir: string): Promise<void> {
  const relativePath = relativeSkillCollectionPath(skillsRoot, skillDir);
  await removePathWithinRoot({
    rootDir: skillsRoot,
    relativePath,
    recursive: true,
    force: false,
  });
}

function relativeSkillCollectionPath(skillsRoot: string, skillDir: string): string {
  const relativePath = path.relative(skillsRoot, skillDir);
  if (
    !relativePath ||
    relativePath === ".." ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Skill directory must be inside the Skill Workshop directory: ${skillDir}`);
  }
  return relativePath;
}

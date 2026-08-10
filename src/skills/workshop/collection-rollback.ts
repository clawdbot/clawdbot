import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { pathExists } from "../../infra/fs-safe.js";
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

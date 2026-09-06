import fs from "node:fs/promises";
import path from "node:path";
import { loadSkillRootRecords } from "../loading/skill-root-loader.js";
import type { CollectionBackupManifest } from "./collection-backup.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";

/** Seed the retained v2 format independently of the retired review producer. */
export async function seedLegacyCollectionBackup(
  skillsRoot: string,
  backupRoot: string,
  change: () => Promise<unknown>,
): Promise<string> {
  const id = "2026-09-01T00-00-00.000Z-legacy";
  const backupDir = path.join(backupRoot, id);
  const directories = () =>
    loadSkillRootRecords({ dir: skillsRoot, source: "openclaw-workshop" }).map(({ skill }) =>
      path.relative(skillsRoot, skill.baseDir),
    );
  const skillDirs = directories();
  await fs.mkdir(backupDir, { recursive: true });
  await fs.cp(skillsRoot, path.join(backupDir, "skills"), { recursive: true });
  await change();
  const resultSkillDirs = directories();
  const resultSkillHashes: Record<string, string> = {};
  for (const dir of resultSkillDirs) {
    resultSkillHashes[dir] = await readSkillProposalTargetTreeSha256(path.join(skillsRoot, dir));
  }
  const manifest: CollectionBackupManifest = {
    schema: "openclaw.skill-collection-backup.v2",
    id,
    createdAt: "2026-09-01T00:00:00.000Z",
    skillDirs,
    resultSkillDirs,
    resultSkillHashes,
  };
  await fs.writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(manifest));
  return backupDir;
}

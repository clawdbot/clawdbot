import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  assertInsideSkillsRoot,
  readWorkspaceSkillFile,
} from "../lifecycle/workspace-skill-write.js";
import { loadSkillsFromDirSafe } from "../loading/local-loader.js";
import type { Skill } from "../loading/skill-contract.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

export function assertWritableSkillTarget(
  skill: Pick<Skill, "baseDir" | "filePath" | "name">,
  env?: NodeJS.ProcessEnv,
): void {
  const skillsRoot = resolveWorkshopSkillsDir(env);
  assertInsideSkillsRoot(skillsRoot, skill.filePath, "skill file");
  assertInsideSkillsRoot(skillsRoot, skill.baseDir, "skill directory");
  if (path.basename(skill.filePath) !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}

export type WritableWorkshopSkillSummary = {
  name: string;
  skillKey: string;
  description: string;
  baseDir: string;
  filePath: string;
};

export function listWritableWorkshopSkillSummaries(
  env?: NodeJS.ProcessEnv,
): WritableWorkshopSkillSummary[] {
  const loaded = loadSkillsFromDirSafe({
    dir: resolveWorkshopSkillsDir(env),
    source: "openclaw-workshop",
  });
  return loaded.skills
    .map((skill) => ({
      name: skill.name,
      skillKey: normalizeSkillIndexName(skill.name),
      description: skill.description,
      baseDir: skill.baseDir,
      filePath: skill.filePath,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function resolveWritableWorkshopSkillSummary(
  skillName: string,
  env?: NodeJS.ProcessEnv,
): WritableWorkshopSkillSummary | undefined {
  const normalized = normalizeSkillIndexName(skillName);
  const matches = listWritableWorkshopSkillSummaries(env).filter(
    (skill) =>
      skill.name === skillName ||
      skill.name.toLowerCase() === skillName.toLowerCase() ||
      (normalized !== "" && normalizeSkillIndexName(skill.name) === normalized),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export async function readWritableWorkshopSkill(
  skillName: string,
  env?: NodeJS.ProcessEnv,
): Promise<{
  skillName: string;
  skillKey: string;
  skillFile: string;
  content: string;
  baseDir: string;
  description: string;
}> {
  const name = normalizeOptionalString(skillName);
  if (!name) {
    throw new Error("Skill name is required.");
  }
  const targetSkill = resolveWritableWorkshopSkillSummary(name, env);
  if (!targetSkill) {
    throw new Error(
      `Skill Workshop can only update skills it generated. No Workshop-generated skill matched: ${name}. Create it as a new skill, or edit the file directly.`,
    );
  }
  assertWritableSkillTarget(targetSkill, env);
  const content = await readWorkspaceSkillFile(targetSkill.filePath);
  if (content === null) {
    throw new Error(`Skill file is missing: ${targetSkill.filePath}`);
  }
  return {
    skillName: targetSkill.name,
    skillKey: targetSkill.skillKey,
    skillFile: targetSkill.filePath,
    content,
    baseDir: targetSkill.baseDir,
    description: targetSkill.description,
  };
}

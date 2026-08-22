// Skill test helpers build canonical skill fixtures for unit tests.
import { createSyntheticSourceInfo, type Skill } from "../loading/skill-contract.js";
import type { SkillEntry } from "../types.js";

export function createCanonicalFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation?: boolean;
}): Skill {
  return {
    name: params.name,
    description: params.description,
    filePath: params.filePath,
    baseDir: params.baseDir,
    source: params.source,
    sourceInfo: createSyntheticSourceInfo(params.filePath, {
      source: params.source,
      baseDir: params.baseDir,
      scope: "project",
      origin: "top-level",
    }),
    disableModelInvocation: params.disableModelInvocation ?? false,
  };
}

export function createFixtureSkillEntry(
  name: string,
  opts?: {
    source?: string;
    skillKey?: string;
    exposure?: SkillEntry["exposure"];
    invocation?: SkillEntry["invocation"];
  },
): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: `${name} description`,
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
      source: opts?.source ?? "openclaw-workspace",
    }),
    frontmatter: {},
    metadata: opts?.skillKey ? { skillKey: opts.skillKey } : undefined,
    invocation: opts?.invocation ?? {
      userInvocable: true,
      disableModelInvocation: false,
    },
    exposure: opts?.exposure,
  };
}

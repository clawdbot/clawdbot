import type { ParsedSkillFrontmatter } from "../types.js";
import { resolveSkillInvocationPolicy } from "./frontmatter.js";
import {
  createSyntheticSourceInfo,
  resolveSkillDisplayName,
  type Skill,
} from "./skill-contract.js";

export function materializeSkill(params: {
  content: string;
  frontmatter: ParsedSkillFrontmatter;
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  sourceOptions: Omit<Parameters<typeof createSyntheticSourceInfo>[1], "baseDir">;
}): Skill {
  return {
    name: params.name,
    displayName: resolveSkillDisplayName(params.content, params.name),
    description: params.description,
    filePath: params.filePath,
    baseDir: params.baseDir,
    source: params.source,
    sourceInfo: createSyntheticSourceInfo(params.filePath, {
      ...params.sourceOptions,
      baseDir: params.baseDir,
    }),
    disableModelInvocation: resolveSkillInvocationPolicy(params.frontmatter).disableModelInvocation,
  };
}

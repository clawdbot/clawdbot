import { readFile } from "node:fs/promises";
import { decodeSkillXml, type Skill } from "../skills/loading/skill-contract.js";

export type CodeModeSkill = {
  name: string;
  description: string;
  location: string;
  source: Pick<Skill, "filePath" | "readContent">;
  reader?: CodeModeSkillReader;
};

export type CodeModeSkillReader = (params: {
  location: string;
  signal?: AbortSignal;
}) => Promise<string>;

const SKILL_NAME_PATTERN = /^[ ]{4}<name>(.*)<\/name>$/mu;
const SKILL_LOCATION_PATTERN = /^[ ]{4}<location>(.*)<\/location>$/mu;

function readSkillField(block: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(block)?.[1];
  return match === undefined ? undefined : decodeSkillXml(match);
}

/** Select Code Mode skills from the exact catalog rendered into this run's prompt. */
export function resolveCodeModeSkills(params: {
  skillsPrompt: string;
  candidates: readonly Skill[];
  reader?: CodeModeSkillReader;
}): CodeModeSkill[] {
  const catalog = /<available_skills>\n([\s\S]*?)\n<\/available_skills>/u.exec(
    params.skillsPrompt,
  )?.[1];
  if (!catalog) {
    return [];
  }
  const candidatesByName = new Map(params.candidates.map((skill) => [skill.name, skill]));
  const result: CodeModeSkill[] = [];
  for (const match of catalog.matchAll(/^[ ]{2}<skill>\n([\s\S]*?)\n[ ]{2}<\/skill>$/gmu)) {
    const block = match[1] ?? "";
    const name = readSkillField(block, SKILL_NAME_PATTERN);
    const location = readSkillField(block, SKILL_LOCATION_PATTERN);
    const source = name ? candidatesByName.get(name) : undefined;
    if (!name || !location || !source) {
      continue;
    }
    result.push({
      name,
      description: [source.description, source.locationNote].filter(Boolean).join("\n"),
      location,
      source: { filePath: source.filePath, readContent: source.readContent },
      reader: params.reader,
    });
  }
  return result;
}

export async function readCodeModeSkill(
  skill: CodeModeSkill,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof skill.source.readContent === "string") {
    return skill.source.readContent;
  }
  if (skill.reader) {
    return await skill.reader({ location: skill.location, signal });
  }
  return await readFile(skill.source.filePath, { encoding: "utf8", signal });
}

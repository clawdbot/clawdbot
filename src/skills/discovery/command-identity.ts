// Skill command identities bind admitted command paths to frozen workspace skill metadata.
import { canonicalizePath } from "../../agents/utils/paths.js";
import { resolveSkillTelemetrySource } from "../loading/source.js";
import type { SkillEntry, SkillUsagePath } from "../types.js";
import { filterUserInvocableSkillEntries } from "./skill-index.js";

export function resolveSkillCommandUsagePath(entry: SkillEntry): SkillUsagePath {
  return {
    readPath: canonicalizePath(entry.skill.filePath),
    skillFile: entry.skill.filePath,
    skillName: entry.skill.name,
    skillSource: resolveSkillTelemetrySource(entry.skill),
  };
}

export function resolveSkillCommandUsagePaths(entries: readonly SkillEntry[]): SkillUsagePath[] {
  return filterUserInvocableSkillEntries(entries).map(resolveSkillCommandUsagePath);
}

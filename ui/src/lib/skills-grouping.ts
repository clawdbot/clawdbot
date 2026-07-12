// Shared pure skill grouping helper.
import type { SkillStatusEntry } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

const SKILL_SOURCE_GROUPS: Array<{ id: string; labelKey: string; sources: string[] }> = [
  { id: "workspace", labelKey: "skillGroups.workspace", sources: ["openclaw-workspace"] },
  { id: "built-in", labelKey: "skillGroups.builtIn", sources: ["openclaw-bundled"] },
  { id: "installed", labelKey: "skillGroups.installed", sources: ["openclaw-managed"] },
  { id: "extra", labelKey: "skillGroups.extra", sources: ["openclaw-extra"] },
];

export function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: t(def.labelKey), skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: t("skillGroups.other"), skills: [] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_SOURCE_GROUPS.map((group) => groups.get(group.id)).filter(
    (group): group is SkillGroup => Boolean(group && group.skills.length > 0),
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

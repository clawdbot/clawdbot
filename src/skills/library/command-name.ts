import { sanitizeSkillCommandName } from "../discovery/command-name.js";
import type { SkillEntry } from "../types.js";

/** Fits native 32-character limits without truncating the stable 80-bit identity suffix. */
export function managedSkillCommandName(slug: string, skillId: string): string {
  const label = slug.replace(/-+/g, "_").slice(0, 9).replace(/_+$/, "");
  return `s_${label}_${skillId.replaceAll("-", "").slice(0, 20)}`;
}

/** Explicit references must never resolve a different bundle that copied a managed command name. */
export function assertUnambiguousManagedSkillNames(entries: readonly SkillEntry[]): void {
  const managed = new Set(
    entries
      .filter((entry) => entry.skill.source === "openclaw-library")
      .map((entry) => entry.skill.name),
  );
  if (!managed.size) {
    return;
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = sanitizeSkillCommandName(entry.skill.name);
    if (managed.has(name) && seen.has(name)) {
      throw new Error(
        `Skill command ${name} is ambiguous. Rename the conflicting workspace skill or detach the managed skill before retrying.`,
      );
    }
    seen.add(name);
  }
}

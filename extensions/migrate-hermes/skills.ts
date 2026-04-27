import fs from "node:fs/promises";
import path from "node:path";
import { createMigrationItem, MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { exists, sanitizeName } from "./helpers.js";
import type { HermesSource } from "./source.js";
import type { PlannedTargets } from "./targets.js";

type PlannedSkill = {
  name: string;
  source: string;
  target: string;
};

export async function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  if (!params.source.skillsDir) {
    return [];
  }
  const entries = await fs
    .readdir(params.source.skillsDir, { withFileTypes: true })
    .catch(() => []);
  const plannedSkills: PlannedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const name = sanitizeName(entry.name);
    if (!name) {
      continue;
    }
    const source = path.join(params.source.skillsDir, entry.name);
    if (!(await exists(path.join(source, "SKILL.md")))) {
      continue;
    }
    plannedSkills.push({
      name,
      source,
      target: path.join(params.targets.workspaceDir, "skills", name),
    });
  }
  const counts = new Map<string, number>();
  for (const skill of plannedSkills) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }
  const items: MigrationItem[] = [];
  for (const skill of plannedSkills) {
    const collides = (counts.get(skill.name) ?? 0) > 1;
    const targetExists = await exists(skill.target);
    items.push(
      createMigrationItem({
        id: `skill:${skill.name}`,
        kind: "skill",
        action: "copy",
        source: skill.source,
        target: skill.target,
        status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
        reason: collides
          ? `multiple Hermes skill directories normalize to "${skill.name}"`
          : targetExists && !params.overwrite
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
      }),
    );
  }
  return items;
}

// Migrate Hermes plugin module implements skills behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createMigrationItem, MIGRATION_REASON_TARGET_EXISTS } from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { exists, parseHermesConfig, readText, sanitizeName } from "./helpers.js";
import type { HermesSource } from "./source.js";
import type { PlannedTargets } from "./targets.js";

type PlannedSkill = {
  id: string;
  name: string;
  skillName: string;
  source: string;
  target: string;
};

const EXCLUDED_SKILL_DIRS = new Set([
  ".git",
  ".github",
  ".hub",
  ".archive",
  ".venv",
  "venv",
  "node_modules",
  "site-packages",
  "__pycache__",
  ".tox",
  ".nox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
const SKILL_SUPPORT_DIRS = new Set(["references", "templates", "assets", "scripts"]);

async function discoverSkillRoots(root: string): Promise<string[]> {
  const orgRoot = path.join(root, "_org");
  const activeOrg = (await readText(path.join(orgRoot, ".active_org")))?.trim();
  async function visit(dir: string): Promise<string[]> {
    const hasSkill = await exists(path.join(dir, "SKILL.md"));
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const roots: string[] = hasSkill ? [dir] : [];
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(dir, entry.name);
      // Hermes retains old org mirrors on disk, but only the marked org is active.
      const inactiveOrg =
        (child === orgRoot && !activeOrg) || (dir === orgRoot && entry.name !== activeOrg);
      if (
        !entry.isDirectory() ||
        EXCLUDED_SKILL_DIRS.has(entry.name) ||
        (hasSkill && SKILL_SUPPORT_DIRS.has(entry.name)) ||
        inactiveOrg
      ) {
        continue;
      }
      roots.push(...(await visit(child)));
    }
    return roots;
  }
  return await visit(root);
}

export async function buildSkillItems(params: {
  source: HermesSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  if (!params.source.skillsDir) {
    return [];
  }
  const plannedSkills: PlannedSkill[] = [];
  for (const source of await discoverSkillRoots(params.source.skillsDir)) {
    const name = sanitizeName(path.basename(source));
    if (!name) {
      continue;
    }
    const content = await readText(path.join(source, "SKILL.md"));
    const frontmatter = content?.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u)?.[1];
    let skillName = path.basename(source);
    try {
      skillName = normalizeOptionalString(parseHermesConfig(frontmatter).name) ?? skillName;
    } catch {
      // Keep copying malformed source files; the skill loader reports invalid frontmatter.
    }
    plannedSkills.push({
      id: `skill:${path
        .relative(params.source.skillsDir, source)
        .split(path.sep)
        .map(sanitizeName)
        .filter(Boolean)
        .join(":")}`,
      name,
      skillName,
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
        id: skill.id,
        kind: "skill",
        action: "copy",
        source: skill.source,
        target: skill.target,
        details: { skillName: skill.skillName },
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

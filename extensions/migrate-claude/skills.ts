import fs from "node:fs/promises";
import path from "node:path";
import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
  MIGRATION_REASON_TARGET_EXISTS,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { exists, readText, sanitizeName } from "./helpers.js";
import type { ClaudeSource } from "./source.js";
import type { PlannedTargets } from "./targets.js";

type PlannedSkill = {
  name: string;
  source: string;
  target: string;
  action: "copy" | "create";
  sourceLabel: string;
};

async function listMarkdownFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function collectSkillDirs(
  planned: PlannedSkill[],
  dir: string | undefined,
  targets: PlannedTargets,
  scope: string,
): Promise<void> {
  if (!dir) {
    return;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const source = path.join(dir, entry.name);
    if (!(await exists(path.join(source, "SKILL.md")))) {
      continue;
    }
    const name = sanitizeName(entry.name);
    if (!name) {
      continue;
    }
    planned.push({
      name,
      source,
      target: path.join(targets.workspaceDir, "skills", name),
      action: "copy",
      sourceLabel: `${scope} Claude skill`,
    });
  }
}

async function collectCommandFiles(
  planned: PlannedSkill[],
  dir: string | undefined,
  targets: PlannedTargets,
  scope: string,
): Promise<void> {
  if (!dir) {
    return;
  }
  for (const file of await listMarkdownFiles(dir)) {
    const relative = path.relative(dir, file);
    const parsed = path.parse(relative);
    const namespace = sanitizeName(parsed.dir.replaceAll(path.sep, "-"));
    const commandName = sanitizeName(parsed.name);
    const name = sanitizeName(["claude-command", namespace, commandName].filter(Boolean).join("-"));
    if (!name) {
      continue;
    }
    planned.push({
      name,
      source: file,
      target: path.join(targets.workspaceDir, "skills", name),
      action: "create",
      sourceLabel: `${scope} Claude command ${relative}`,
    });
  }
}

export async function buildSkillItems(params: {
  source: ClaudeSource;
  targets: PlannedTargets;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const planned: PlannedSkill[] = [];
  await collectSkillDirs(planned, params.source.userSkillsDir, params.targets, "user");
  await collectSkillDirs(planned, params.source.projectSkillsDir, params.targets, "project");
  await collectCommandFiles(planned, params.source.userCommandsDir, params.targets, "user");
  await collectCommandFiles(planned, params.source.projectCommandsDir, params.targets, "project");

  const counts = new Map<string, number>();
  for (const skill of planned) {
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  }

  const items: MigrationItem[] = [];
  for (const skill of planned) {
    const collides = (counts.get(skill.name) ?? 0) > 1;
    const targetExists = await exists(skill.target);
    items.push(
      createMigrationItem({
        id: `skill:${skill.name}`,
        kind: "skill",
        action: skill.action,
        source: skill.source,
        target: skill.target,
        status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
        reason: collides
          ? `multiple Claude skills or commands normalize to "${skill.name}"`
          : targetExists && !params.overwrite
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        details: { sourceLabel: skill.sourceLabel, skillName: skill.name },
      }),
    );
  }
  return items;
}

function firstParagraph(content: string): string | undefined {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
    .split(/\r?\n\r?\n/u)
    .map((part) => part.replaceAll(/\s+/g, " ").trim())
    .find(Boolean);
}

function generatedCommandSkillContent(params: {
  skillName: string;
  sourceLabel: string;
  commandContent: string;
}): string {
  const description =
    firstParagraph(params.commandContent) ?? `Imported Claude command ${params.skillName}`;
  return [
    "---",
    `name: ${params.skillName}`,
    `description: ${JSON.stringify(description.slice(0, 180))}`,
    "disable-model-invocation: true",
    "---",
    "",
    `<!-- Imported from Claude: ${params.sourceLabel} -->`,
    "",
    params.commandContent.trimEnd(),
    "",
  ].join("\n");
}

export async function applyGeneratedSkillItem(
  item: MigrationItem,
  opts: { overwrite?: boolean } = {},
): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    if ((await exists(item.target)) && !opts.overwrite) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    const sourceLabel =
      typeof item.details?.sourceLabel === "string"
        ? item.details.sourceLabel
        : path.basename(item.source);
    const skillName =
      typeof item.details?.skillName === "string" ? item.details.skillName : sanitizeName(item.id);
    const content = generatedCommandSkillContent({
      skillName,
      sourceLabel,
      commandContent: (await readText(item.source)) ?? "",
    });
    await fs.mkdir(item.target, { recursive: true });
    await fs.writeFile(path.join(item.target, "SKILL.md"), content, "utf8");
    return { ...item, status: "migrated" };
  } catch (err) {
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}

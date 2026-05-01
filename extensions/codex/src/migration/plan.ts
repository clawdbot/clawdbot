import path from "node:path";
import {
  createMigrationItem,
  createMigrationManualItem,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { exists, sanitizeName } from "./helpers.js";
import { discoverCodexSource, hasCodexSource, type CodexSkillSource } from "./source.js";
import { resolveCodexMigrationTargets } from "./targets.js";

function uniqueSkillName(skill: CodexSkillSource, counts: Map<string, number>): string {
  const base = sanitizeName(skill.name) || "codex-skill";
  if ((counts.get(base) ?? 0) <= 1) {
    return base;
  }
  const parent = sanitizeName(path.basename(path.dirname(skill.source)));
  return sanitizeName(["codex", parent, base].filter(Boolean).join("-")) || base;
}

async function buildSkillItems(params: {
  skills: CodexSkillSource[];
  workspaceDir: string;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const baseCounts = new Map<string, number>();
  for (const skill of params.skills) {
    const base = sanitizeName(skill.name) || "codex-skill";
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const resolvedCounts = new Map<string, number>();
  const planned = params.skills.map((skill) => {
    const name = uniqueSkillName(skill, baseCounts);
    resolvedCounts.set(name, (resolvedCounts.get(name) ?? 0) + 1);
    return { skill, name, target: path.join(params.workspaceDir, "skills", name) };
  });
  const items: MigrationItem[] = [];
  for (const item of planned) {
    const collides = (resolvedCounts.get(item.name) ?? 0) > 1;
    const targetExists = await exists(item.target);
    items.push(
      createMigrationItem({
        id: `skill:${item.name}`,
        kind: "skill",
        action: "copy",
        source: item.skill.source,
        target: item.target,
        status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
        reason: collides
          ? `multiple Codex skills normalize to "${item.name}"`
          : targetExists && !params.overwrite
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: `Copy ${item.skill.sourceLabel} into this OpenClaw agent workspace.`,
        details: {
          skillName: item.name,
          sourceLabel: item.skill.sourceLabel,
        },
      }),
    );
  }
  return items;
}

export async function buildCodexMigrationPlan(
  ctx: MigrationProviderContext,
): Promise<MigrationPlan> {
  const source = await discoverCodexSource(ctx.source);
  if (!hasCodexSource(source)) {
    throw new Error(
      `Codex state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const targets = resolveCodexMigrationTargets(ctx);
  const items: MigrationItem[] = [];
  items.push(
    ...(await buildSkillItems({
      skills: source.skills,
      workspaceDir: targets.workspaceDir,
      overwrite: ctx.overwrite,
    })),
  );
  for (const [index, plugin] of source.plugins.entries()) {
    items.push(
      createMigrationManualItem({
        id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${index + 1}`,
        source: plugin.source,
        message: `Codex native plugin "${plugin.name}" was found but not activated automatically.`,
        recommendation:
          "Review the plugin bundle first, then install trusted compatible plugins with openclaw plugins install <path>.",
      }),
    );
  }
  for (const archivePath of source.archivePaths) {
    items.push(
      createMigrationItem({
        id: archivePath.id,
        kind: "archive",
        action: "archive",
        source: archivePath.path,
        message:
          archivePath.message ??
          "Archived in the migration report for manual review; not imported into live config.",
        details: { archiveRelativePath: archivePath.relativePath },
      }),
    );
  }
  const warnings = [
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting skill targets after item-level backups.",
        ]
      : []),
    ...(source.plugins.length > 0
      ? [
          "Codex native plugins are reported for manual review only. OpenClaw does not auto-activate plugin bundles, hooks, MCP servers, or apps from another Codex home.",
        ]
      : []),
    ...(source.archivePaths.length > 0
      ? [
          "Codex config and hook files are archive-only. They are preserved in the migration report, not loaded into OpenClaw automatically.",
        ]
      : []),
  ];
  return {
    providerId: "codex",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: [
      "Run openclaw doctor after applying the migration.",
      "Review skipped Codex plugin/config/hook items before installing or recreating them in OpenClaw.",
    ],
    metadata: {
      agentDir: targets.agentDir,
      codexHome: source.codexHome,
      codexSkillsDir: source.codexSkillsDir,
      personalAgentsSkillsDir: source.personalAgentsSkillsDir,
    },
  };
}

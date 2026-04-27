import path from "node:path";
import {
  createMigrationItem,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildConfigItems } from "./config.js";
import { exists, parseHermesConfig, readText } from "./helpers.js";
import { createHermesModelItem } from "./items.js";
import { resolveCurrentModelRef, resolveHermesModelRef } from "./model.js";
import { buildSecretItems } from "./secrets.js";
import { buildSkillItems } from "./skills.js";
import { discoverHermesSource, hasHermesSource } from "./source.js";
import { resolveTargets } from "./targets.js";

async function addFileItem(params: {
  items: MigrationItem[];
  id: string;
  source?: string;
  target: string;
  kind?: MigrationItem["kind"];
  action?: MigrationItem["action"];
  overwrite?: boolean;
}): Promise<void> {
  if (!params.source) {
    return;
  }
  const targetExists = await exists(params.target);
  params.items.push(
    createMigrationItem({
      id: params.id,
      kind: params.kind ?? "file",
      action: params.action ?? "copy",
      source: params.source,
      target: params.target,
      status: targetExists && !params.overwrite ? "conflict" : "planned",
      reason: targetExists && !params.overwrite ? MIGRATION_REASON_TARGET_EXISTS : undefined,
    }),
  );
}

export async function buildHermesPlan(ctx: MigrationProviderContext): Promise<MigrationPlan> {
  const source = await discoverHermesSource(ctx.source);
  if (!hasHermesSource(source)) {
    throw new Error(
      `Hermes state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const targets = resolveTargets(ctx);
  const config = parseHermesConfig(await readText(source.configPath));
  const modelRef = resolveHermesModelRef(config);
  const items: MigrationItem[] = [];

  if (modelRef) {
    const currentModel = resolveCurrentModelRef(ctx);
    items.push(
      createHermesModelItem({
        model: modelRef,
        currentModel,
        overwrite: ctx.overwrite,
      }),
    );
  }
  items.push(
    ...buildConfigItems({
      ctx,
      config,
      modelRef,
      hasMemoryFiles: Boolean(source.memoryPath || source.userPath),
    }),
  );

  await addFileItem({
    items,
    id: "workspace:SOUL.md",
    kind: "workspace",
    source: source.soulPath,
    target: path.join(targets.workspaceDir, "SOUL.md"),
    overwrite: ctx.overwrite,
  });
  await addFileItem({
    items,
    id: "workspace:AGENTS.md",
    kind: "workspace",
    source: source.agentsPath,
    target: path.join(targets.workspaceDir, "AGENTS.md"),
    overwrite: ctx.overwrite,
  });
  if (source.memoryPath) {
    items.push(
      createMigrationItem({
        id: "memory:MEMORY.md",
        kind: "memory",
        action: "append",
        source: source.memoryPath,
        target: path.join(targets.workspaceDir, "MEMORY.md"),
      }),
    );
  }
  if (source.userPath) {
    items.push(
      createMigrationItem({
        id: "memory:USER.md",
        kind: "memory",
        action: "append",
        source: source.userPath,
        target: path.join(targets.workspaceDir, "USER.md"),
      }),
    );
  }
  items.push(...(await buildSkillItems({ source, targets, overwrite: ctx.overwrite })));
  items.push(...(await buildSecretItems({ ctx, source, targets })));
  for (const archivePath of source.archivePaths) {
    items.push(
      createMigrationItem({
        id: archivePath.id,
        kind: "archive",
        action: "archive",
        source: archivePath.path,
        message:
          "Archived in the migration report for manual review; not imported into live config.",
        details: { archiveRelativePath: archivePath.relativePath },
      }),
    );
  }

  const warnings = [
    ...(!ctx.includeSecrets && items.some((item) => item.kind === "secret")
      ? [
          "Secrets were detected but skipped. Re-run with --include-secrets to import supported API keys.",
        ]
      : []),
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups.",
        ]
      : []),
    ...(source.archivePaths.length > 0
      ? [
          "Some Hermes files are archive-only. They will be copied into the migration report for manual review, not loaded into OpenClaw.",
        ]
      : []),
    ...(items.some((item) => item.kind === "manual")
      ? ["Some Hermes settings require manual review before they can be activated safely."]
      : []),
  ];
  return {
    providerId: "hermes",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: ["Run openclaw doctor after applying the migration."],
    metadata: { agentDir: targets.agentDir },
  };
}

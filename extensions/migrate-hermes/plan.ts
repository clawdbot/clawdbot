// Migrate Hermes plugin module implements plan behavior.
import path from "node:path";
import {
  createMigrationItem,
  createMigrationManualItem,
  markMigrationItemConflict,
  MIGRATION_REASON_TARGET_EXISTS,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildAuthItems } from "./auth.js";
import { buildConfigItems } from "./config.js";
import { exists, parseEnv, parseHermesConfig, readText } from "./helpers.js";
import {
  createHermesModelItem,
  findHermesModelProviderDependency,
  HERMES_REASON_MODEL_PROVIDER_CONFLICT,
} from "./items.js";
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
  let config: Record<string, unknown>;
  try {
    config = parseHermesConfig(await readText(source.configPath));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse Hermes config at ${source.configPath}: ${reason}`, {
      cause: err,
    });
  }
  const env = parseEnv(await readText(source.envPath));
  const modelRef = resolveHermesModelRef(config, env);
  const runtimeEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const items: MigrationItem[] = [];

  let modelItemIndex: number | undefined;
  if (modelRef) {
    const currentModel = resolveCurrentModelRef(ctx);
    modelItemIndex = items.length;
    items.push(
      createHermesModelItem({
        model: modelRef,
        currentModel,
        overwrite: ctx.overwrite,
      }),
    );
    if (modelRef.startsWith("qwen-oauth/")) {
      items.push(
        createMigrationManualItem({
          id: "manual:auth-reauthenticate:qwen-oauth",
          source: source.configPath ?? source.root,
          message: "Hermes Qwen OAuth uses the external Qwen CLI credential store.",
          recommendation: "Authenticate qwen-oauth in OpenClaw after migration.",
        }),
      );
    }
  }
  const configItems = buildConfigItems({
    ctx,
    config,
    env,
    runtimeEnv,
    modelRef,
    hasMemoryFiles: Boolean(source.memoryPath || source.userPath),
  });
  if (modelRef && modelItemIndex !== undefined) {
    const modelItem = items[modelItemIndex];
    const dependency = findHermesModelProviderDependency(configItems, modelRef);
    if (modelItem?.status === "planned" && dependency?.status === "conflict") {
      items[modelItemIndex] = markMigrationItemConflict(
        modelItem,
        HERMES_REASON_MODEL_PROVIDER_CONFLICT,
      );
    }
  }
  items.push(...configItems);

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
  items.push(...(await buildAuthItems({ ctx, source, targets })));
  items.push(...(await buildSecretItems({ config, ctx, source, targets })));
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
    ...(!ctx.includeSecrets && items.some((item) => item.kind === "secret" || item.kind === "auth")
      ? [
          "Auth credentials were detected but skipped. Re-run interactively or pass --include-secrets to import supported credentials.",
        ]
      : []),
    ...(items.some(
      (item) => item.kind === "auth" && item.details?.sourceKind === "hermes-auth-json",
    )
      ? [
          "Hermes and OpenClaw must not keep using the same imported OpenAI OAuth refresh grant after migration; reauthenticate one side before running both.",
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

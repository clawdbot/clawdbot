import path from "node:path";
import { markMigrationItemSkipped, summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMigrationFileItem,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { applyConfigItem, applyManualItem } from "./config.js";
import { appendItem } from "./helpers.js";
import { applyModelItem } from "./model.js";
import { buildHermesPlan } from "./plan.js";
import { applySecretItem } from "./secrets.js";
import { resolveTargets } from "./targets.js";

const HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT = "blocked by earlier apply conflict";

function withCachedConfigRuntime(
  runtime: MigrationProviderContext["runtime"] | undefined,
  fallbackConfig: MigrationProviderContext["config"],
): MigrationProviderContext["runtime"] | undefined {
  if (!runtime?.config.writeConfigFile) {
    return runtime;
  }
  let cachedConfig: MigrationProviderContext["config"] | undefined;
  const loadConfig = () => {
    cachedConfig ??= structuredClone(runtime.config.loadConfig?.() ?? fallbackConfig);
    return cachedConfig;
  };
  return {
    ...runtime,
    config: {
      ...runtime.config,
      loadConfig,
      writeConfigFile: async (next, options) => {
        cachedConfig = structuredClone(next);
        await runtime.config.writeConfigFile(next, options);
      },
    },
  };
}

export async function applyHermesPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildHermesPlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "hermes");
  const targets = resolveTargets(params.ctx);
  const items: MigrationItem[] = [];
  const runtime = withCachedConfigRuntime(params.ctx.runtime ?? params.runtime, params.ctx.config);
  const applyCtx = { ...params.ctx, runtime };
  let blockedByApplyConflict = false;
  for (const item of plan.items) {
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (blockedByApplyConflict) {
      items.push(markMigrationItemSkipped(item, HERMES_REASON_BLOCKED_BY_APPLY_CONFLICT));
      continue;
    }
    let appliedItem: MigrationItem;
    if (item.id === "config:default-model") {
      appliedItem = await applyModelItem(applyCtx, item);
    } else if (item.kind === "config") {
      appliedItem = await applyConfigItem(applyCtx, item);
    } else if (item.kind === "manual") {
      appliedItem = applyManualItem(item);
    } else if (item.action === "archive") {
      appliedItem = await archiveMigrationItem(item, reportDir);
    } else if (item.kind === "secret") {
      appliedItem = await applySecretItem(params.ctx, item, targets);
    } else if (item.action === "append") {
      appliedItem = await appendItem(item);
    } else {
      appliedItem = await copyMigrationFileItem(item, reportDir, {
        overwrite: params.ctx.overwrite,
      });
    }
    items.push(appliedItem);
    if (
      item.kind === "config" &&
      (appliedItem.status === "conflict" || appliedItem.status === "error")
    ) {
      blockedByApplyConflict = true;
    }
  }
  const result: MigrationApplyResult = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Hermes Migration Report" });
  return result;
}

import path from "node:path";
import { summarizeMigrationItems } from "openclaw/plugin-sdk/migration";
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
import { buildCodexMigrationPlan } from "./plan.js";

export async function applyCodexMigrationPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildCodexMigrationPlan(params.ctx));
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "codex");
  const items: MigrationItem[] = [];
  for (const item of plan.items) {
    if (item.status !== "planned") {
      items.push(item);
      continue;
    }
    if (item.action === "archive") {
      items.push(await archiveMigrationItem(item, reportDir));
    } else {
      items.push(await copyMigrationFileItem(item, reportDir, { overwrite: params.ctx.overwrite }));
    }
  }
  const result: MigrationApplyResult = {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    backupPath: params.ctx.backupPath,
    reportDir,
  };
  await writeMigrationReport(result, { title: "Codex Migration Report" });
  return result;
}

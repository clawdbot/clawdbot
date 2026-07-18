// Migrate Hermes plugin module implements apply behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  markMigrationItemConflict,
  markMigrationItemError,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import {
  archiveMigrationItem,
  copyMemoryMigrationFileItem,
  copyMigrationFileItem,
  withCachedMigrationConfigRuntime,
  writeMigrationReport,
} from "openclaw/plugin-sdk/migration-runtime";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir, withTempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { applyAuthItem } from "./auth.js";
import { applyConfigItem, applyManualItem } from "./config.js";
import { appendItem } from "./helpers.js";
import {
  findHermesModelProviderDependency,
  HERMES_REASON_MODEL_PROVIDER_CONFLICT,
  readHermesModelDetails,
} from "./items.js";
import { applyModelItem } from "./model.js";
import { buildHermesPlan } from "./plan.js";
import { applySecretItem } from "./secrets.js";
import { resolveTargets } from "./targets.js";

const HERMES_SQLITE_SNAPSHOT_PREFIX = "openclaw-migrate-hermes-sqlite-";

function isHermesMemoryOnlyCopyItem(item: MigrationItem): boolean {
  return (
    item.kind === "memory" &&
    item.action === "copy" &&
    item.details?.sourceType === "hermes-memory" &&
    item.details?.collectionId === "hermes"
  );
}

function assertConsistentMemoryPlan(plan: MigrationPlan): void {
  const hasMemoryOnlyCopy = plan.items.some(isHermesMemoryOnlyCopyItem);
  const hasMemoryAppend = plan.items.some(
    (item) => item.kind === "memory" && item.action === "append",
  );
  if (hasMemoryOnlyCopy && hasMemoryAppend) {
    throw new Error("Hermes migration plan mixes memory-only copy and append items");
  }
}

async function archiveHermesItem(item: MigrationItem, reportDir: string): Promise<MigrationItem> {
  if (!item.source || path.extname(item.source) !== ".db") {
    return await archiveMigrationItem(item, reportDir);
  }
  const sourcePath = item.source;

  let sourceStat: import("node:fs").Stats;
  try {
    sourceStat = await fs.lstat(sourcePath);
  } catch {
    return await archiveMigrationItem(item, reportDir);
  }
  if (!sourceStat.isFile()) {
    return await archiveMigrationItem(item, reportDir);
  }

  try {
    // A raw state.db copy can omit committed rows that still live in state.db-wal.
    // Snapshot the live database into one self-contained archive artifact.
    return await withTempWorkspace(
      { rootDir: resolvePreferredOpenClawTmpDir(), prefix: HERMES_SQLITE_SNAPSHOT_PREFIX },
      async ({ dir: tempDir }) => {
        const snapshotPath = path.join(tempDir, path.basename(sourcePath));
        const { DatabaseSync } = await import("node:sqlite");
        const source = new DatabaseSync(sourcePath, { readOnly: true });
        try {
          source.exec("PRAGMA busy_timeout = 30000;");
          source.prepare("VACUUM INTO ?").run(snapshotPath);
        } finally {
          source.close();
        }
        await fs.chmod(snapshotPath, 0o600);
        const archived = await archiveMigrationItem({ ...item, source: snapshotPath }, reportDir);
        return { ...archived, source: sourcePath };
      },
    );
  } catch (err) {
    const snapshotReason = err instanceof Error ? err.message : String(err);
    let recoveryArchive: MigrationItem;
    try {
      recoveryArchive = await withTempWorkspace(
        { rootDir: resolvePreferredOpenClawTmpDir(), prefix: HERMES_SQLITE_SNAPSHOT_PREFIX },
        async ({ dir: tempDir }) => {
          const recoveryDir = path.join(tempDir, `${path.basename(sourcePath)}-recovery`);
          await fs.mkdir(recoveryDir, { recursive: true });
          for (const candidate of [sourcePath, `${sourcePath}-wal`, `${sourcePath}-shm`]) {
            const stat = await fs.lstat(candidate).catch(() => undefined);
            if (!stat?.isFile()) {
              continue;
            }
            try {
              await fs.copyFile(candidate, path.join(recoveryDir, path.basename(candidate)));
            } catch (copyError) {
              const copyCode = (copyError as NodeJS.ErrnoException).code;
              if (candidate !== sourcePath && copyCode === "ENOENT") {
                continue;
              }
              throw copyError;
            }
          }
          return await archiveMigrationItem({ ...item, source: recoveryDir }, reportDir);
        },
      );
    } catch (recoveryError) {
      const recoveryReason =
        recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      return markMigrationItemError(
        item,
        `SQLite snapshot failed: ${snapshotReason}; recovery archive failed: ${recoveryReason}`,
      );
    }
    if (recoveryArchive.status === "migrated") {
      return markMigrationItemError(
        { ...recoveryArchive, source: sourcePath },
        `SQLite snapshot failed; database recovery files preserved for manual review: ${snapshotReason}`,
      );
    }
    return markMigrationItemError(
      { ...recoveryArchive, source: sourcePath },
      `SQLite snapshot failed: ${snapshotReason}; recovery archive failed: ${recoveryArchive.reason ?? recoveryArchive.status}`,
    );
  }
}

export async function applyHermesPlan(params: {
  ctx: MigrationProviderContext;
  plan?: MigrationPlan;
  runtime?: MigrationProviderContext["runtime"];
}): Promise<MigrationApplyResult> {
  const plan = params.plan ?? (await buildHermesPlan(params.ctx));
  assertConsistentMemoryPlan(plan);
  const reportDir = params.ctx.reportDir ?? path.join(params.ctx.stateDir, "migration", "hermes");
  const targets = resolveTargets(params.ctx);
  // Item ids are report labels, not unique execution keys. Preserve object identity so
  // providers can report repeated source items without cross-wiring their results.
  const appliedByItem = new Map<MigrationItem, MigrationItem>();
  const runtime = withCachedMigrationConfigRuntime(
    params.ctx.runtime ?? params.runtime,
    params.ctx.config,
  );
  const applyCtx = { ...params.ctx, runtime };
  const executionItems = [
    ...plan.items.filter((item) => item.id.startsWith("config:model-provider:")),
    ...plan.items.filter((item) => !item.id.startsWith("config:model-provider:")),
  ];
  for (const item of executionItems) {
    if (item.status !== "planned") {
      appliedByItem.set(item, item);
      continue;
    }
    let appliedItem: MigrationItem;
    if (item.id === "config:default-model") {
      const model = readHermesModelDetails(item)?.model;
      const dependency = model ? findHermesModelProviderDependency(plan.items, model) : undefined;
      const dependencyResult = dependency ? appliedByItem.get(dependency) : undefined;
      if (dependencyResult && dependencyResult.status !== "migrated") {
        appliedItem =
          dependencyResult.status === "conflict"
            ? markMigrationItemConflict(item, HERMES_REASON_MODEL_PROVIDER_CONFLICT)
            : markMigrationItemError(
                item,
                `model provider config failed: ${dependencyResult.reason ?? dependencyResult.status}`,
              );
      } else {
        appliedItem = await applyModelItem(applyCtx, item);
      }
    } else if (item.kind === "config") {
      appliedItem = await applyConfigItem(applyCtx, item);
    } else if (item.kind === "manual") {
      appliedItem = applyManualItem(item);
    } else if (item.action === "archive") {
      appliedItem = await archiveHermesItem(item, reportDir);
    } else if (item.kind === "auth") {
      appliedItem = await applyAuthItem(applyCtx, item, targets);
    } else if (item.kind === "secret") {
      appliedItem = await applySecretItem(applyCtx, item, targets);
    } else if (isHermesMemoryOnlyCopyItem(item)) {
      // Route from the reviewed item shape; ctx.itemKinds is caller metadata and may be absent.
      appliedItem = await copyMemoryMigrationFileItem(item, reportDir, {
        workspaceDir: targets.workspaceDir,
        overwrite: params.ctx.overwrite,
      });
    } else if (item.action === "append") {
      appliedItem = await appendItem(item);
    } else {
      appliedItem = await copyMigrationFileItem(item, reportDir, {
        overwrite: params.ctx.overwrite,
      });
    }
    appliedByItem.set(item, appliedItem);
  }
  const items = plan.items.map((item) => appliedByItem.get(item) ?? item);
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

// Receipt lookup and source-removal bookkeeping for legacy workspace migration.
import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { root } from "@openclaw/fs-safe";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { WORKSPACE_DOCTOR_CLAIM_SUFFIX } from "../agents/workspace-legacy-state.js";
import type { WorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import {
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
  WORKSPACE_SETUP_STATE_VERSION,
} from "../agents/workspace-state-store.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { formatErrorMessage } from "./errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { pathMayExistSync } from "./path-existence.js";
import {
  readLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import type { LegacyWorkspaceStateSource } from "./state-migrations.workspace-setup.types.js";

export { markLegacyMigrationSourceRemoved } from "./state-migrations.receipts.js";

export type MigrationReceipt = {
  sourceKey: string;
  sha256: string | null;
  removedSource: boolean;
  archivePath?: string;
};

type WorkspaceSetupMilestones = {
  workspace_path: string | null;
  bootstrap_seeded_at: string | null;
  setup_completed_at: string | null;
};

export function createWorkspaceSetupFingerprint(setup: WorkspaceSetupMilestones): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "setup",
        workspacePath: setup.workspace_path,
        version: WORKSPACE_SETUP_STATE_VERSION,
        bootstrapSeededAt: setup.bootstrap_seeded_at,
        setupCompletedAt: setup.setup_completed_at,
      }),
    )
    .digest("hex");
}

export function resolveWorkspaceMigrationSourceKey(source: LegacyWorkspaceStateSource): string {
  return resolveLegacyMigrationSourceKey(
    `workspace-${source.kind}`,
    source.sourcePath,
    source.workspaceKey,
  );
}

export function readReceipt(
  source: LegacyWorkspaceStateSource,
  env: NodeJS.ProcessEnv,
): MigrationReceipt | null {
  const receipt = readLegacyMigrationReceipt(resolveWorkspaceMigrationSourceKey(source), env);
  const archivePath = receipt ? safeParseJsonRecord(receipt.reportJson)?.archivePath : undefined;
  return receipt
    ? {
        sourceKey: receipt.sourceKey,
        sha256: receipt.sourceSha256,
        removedSource: receipt.removedSource,
        ...(typeof archivePath === "string" ? { archivePath } : {}),
      }
    : null;
}

type WorkspaceReceiptDatabase = Pick<DB, "migration_sources">;

function receiptMoveFailure(sourcePath: string, reason: string): Error {
  return new Error(
    `Cannot move workspace migration history at ${sourcePath}: ${reason}. ` +
      "Preserve the workspace and database, finish or repair the pending migration with openclaw doctor --fix, then retry the workspace move.",
  );
}

function moveWorkspacePath(
  value: string,
  storedIdentity: WorkspaceStateIdentity,
  currentDirectoryPath: string,
): string {
  const sourceParts = path.resolve(value).split(path.sep);
  const relative = path.relative(
    storedIdentity.workspacePath,
    path.resolve(value).normalize("NFC"),
  );
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return value;
  }
  // Keys use NFC, but backup/source filenames must retain their filesystem bytes.
  const depth = relative.split(path.sep).filter(Boolean).length;
  return path.join(currentDirectoryPath, ...sourceParts.slice(sourceParts.length - depth));
}

function readWorkspaceMoveReceipts(
  database: DatabaseSync,
  storedIdentity: WorkspaceStateIdentity,
  currentIdentity: WorkspaceStateIdentity,
) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<WorkspaceReceiptDatabase>(database)
      .selectFrom("migration_sources")
      .selectAll()
      .where("migration_kind", "in", [
        WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
        WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
      ])
      .orderBy("source_key", "asc"),
  ).rows.filter((row) => {
    const report = safeParseJsonRecord(row.report_json);
    const associated = [storedIdentity, currentIdentity].some((identity) =>
      row.migration_kind === WORKSPACE_LEGACY_STATE_MIGRATION_KIND
        ? ["setup", "attestation"].some(
            (kind) =>
              row.source_key ===
              resolveLegacyMigrationSourceKey(
                `workspace-${kind}`,
                row.source_path,
                identity.workspaceKey,
              ),
          )
        : row.source_path === identity.workspacePath,
    );
    if (associated && !report) {
      throw receiptMoveFailure(row.source_path, "the migration report is unreadable");
    }
    return (
      associated ||
      report?.workspaceKey === storedIdentity.workspaceKey ||
      report?.workspaceKey === currentIdentity.workspaceKey
    );
  });
}

type WorkspaceReceiptRow = ReturnType<typeof readWorkspaceMoveReceipts>[number];

export type WorkspaceMigrationReceiptMove = {
  storedIdentity: WorkspaceStateIdentity;
  currentIdentity: WorkspaceStateIdentity;
  receipts: WorkspaceReceiptRow[];
  replacements: {
    originalKey: string;
    source_key: string;
    source_path: string;
    report_json: string;
  }[];
};

function assertReceiptMoveDestinations(
  database: DatabaseSync,
  plan: WorkspaceMigrationReceiptMove,
) {
  const destinationKeys = new Set<string>();
  for (const replacement of plan.replacements) {
    const existing = executeSqliteQueryTakeFirstSync(
      database,
      getNodeSqliteKysely<WorkspaceReceiptDatabase>(database)
        .selectFrom("migration_sources")
        .select("source_key")
        .where("source_key", "=", replacement.source_key),
    );
    if (
      destinationKeys.has(replacement.source_key) ||
      (existing && existing.source_key !== replacement.originalKey)
    ) {
      throw receiptMoveFailure(replacement.source_path, "the destination already has a receipt");
    }
    destinationKeys.add(replacement.source_key);
  }
}

async function verifyCarriedReceiptFile(
  workspacePath: string,
  filePath: string,
  sha256: string | null,
): Promise<void> {
  try {
    // Setup sources and their archives share the importer's 64 KiB maximum.
    const workspace = await root(workspacePath, {
      hardlinks: "reject",
      symlinks: "reject",
      maxBytes: 64 * 1024,
    });
    const file = await workspace.read(path.relative(workspacePath, filePath));
    if (createHash("sha256").update(file.buffer).digest("hex") !== sha256) {
      throw new Error("the carried file differs from its migration receipt");
    }
  } catch (error) {
    throw receiptMoveFailure(filePath, formatErrorMessage(error));
  }
}

/** Prepare filesystem evidence before the move owner's synchronous write transaction. */
export async function prepareWorkspaceMigrationReceiptMove(params: {
  database: DatabaseSync;
  storedIdentity: WorkspaceStateIdentity;
  currentIdentity: WorkspaceStateIdentity;
  storedSetup: (WorkspaceSetupMilestones & { version: number | null }) | undefined;
  currentDirectoryPath: string;
}): Promise<WorkspaceMigrationReceiptMove> {
  const { database, storedIdentity, currentIdentity, storedSetup, currentDirectoryPath } = params;
  const receipts = readWorkspaceMoveReceipts(database, storedIdentity, currentIdentity);
  const plan: WorkspaceMigrationReceiptMove = {
    storedIdentity,
    currentIdentity,
    receipts,
    replacements: [],
  };
  const oldFingerprint =
    storedSetup?.version === WORKSPACE_SETUP_STATE_VERSION
      ? createWorkspaceSetupFingerprint(storedSetup)
      : undefined;
  for (const receipt of receipts) {
    const report = safeParseJsonRecord(receipt.report_json)!;
    if (report.workspaceKey !== storedIdentity.workspaceKey) {
      throw receiptMoveFailure(
        receipt.source_path,
        report.workspaceKey === currentIdentity.workspaceKey
          ? "the destination already owns migration history"
          : "the migration report has unsupported workspace ownership",
      );
    }
    if (!path.isAbsolute(receipt.source_path)) {
      throw receiptMoveFailure(receipt.source_path, "the migration source path is invalid");
    }
    const sourcePath = moveWorkspacePath(receipt.source_path, storedIdentity, currentDirectoryPath);
    const movedReport: Record<string, unknown> = {
      ...report,
      workspaceKey: currentIdentity.workspaceKey,
    };
    let sourceKey: string;
    if (receipt.migration_kind === WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND) {
      if (receipt.status !== "completed" && receipt.status !== "superseded") {
        throw receiptMoveFailure(
          receipt.source_path,
          "a skill-workshop relocation is still pending",
        );
      }
      // Terminal reports retain their captured filesystem facts. Only their current
      // receipt association moves; rewriting a prepared report could redirect work.
      sourceKey = resolveLegacyMigrationSourceKey(receipt.migration_kind, sourcePath);
      if (
        receipt.source_key !==
        resolveLegacyMigrationSourceKey(receipt.migration_kind, receipt.source_path)
      ) {
        throw receiptMoveFailure(receipt.source_path, "the relocation receipt key is invalid");
      }
    } else {
      if (
        (report.sourceKind !== "setup" && report.sourceKind !== "attestation") ||
        typeof report.canonicalFingerprint !== "string" ||
        typeof report.authoritative !== "boolean" ||
        receipt.status !== "completed"
      ) {
        throw receiptMoveFailure(
          receipt.source_path,
          "the workspace receipt format is unsupported",
        );
      }
      if (
        receipt.source_key !==
        resolveLegacyMigrationSourceKey(
          `workspace-${report.sourceKind}`,
          receipt.source_path,
          storedIdentity.workspaceKey,
        )
      ) {
        throw receiptMoveFailure(receipt.source_path, "the workspace receipt key is invalid");
      }
      if (
        sourcePath === receipt.source_path &&
        (receipt.removed_source !== 1 ||
          pathMayExistSync(sourcePath) ||
          pathMayExistSync(`${sourcePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`))
      ) {
        throw receiptMoveFailure(
          receipt.source_path,
          "an external legacy source has not finished cleanup",
        );
      }
      if (sourcePath !== receipt.source_path && receipt.removed_source !== 1) {
        const claimPath = `${sourcePath}${WORKSPACE_DOCTOR_CLAIM_SUFFIX}`;
        const sourceExists = pathMayExistSync(sourcePath);
        const claimExists = pathMayExistSync(claimPath);
        if (sourceExists && claimExists) {
          throw receiptMoveFailure(
            sourcePath,
            "both the carried source and its interrupted claim exist",
          );
        }
        if (sourceExists || claimExists) {
          await verifyCarriedReceiptFile(
            currentDirectoryPath,
            sourceExists ? sourcePath : claimPath,
            receipt.source_sha256,
          );
        }
      }
      if (
        storedSetup &&
        report.sourceKind === "setup" &&
        oldFingerprint === report.canonicalFingerprint
      ) {
        movedReport.canonicalFingerprint = createWorkspaceSetupFingerprint({
          ...storedSetup,
          workspace_path: currentIdentity.workspacePath,
        });
      }
      if (report.archivePath !== undefined) {
        if (typeof report.archivePath !== "string" || !path.isAbsolute(report.archivePath)) {
          throw receiptMoveFailure(receipt.source_path, "the setup backup path is invalid");
        }
        const archivePath = moveWorkspacePath(
          report.archivePath,
          storedIdentity,
          currentDirectoryPath,
        );
        if (archivePath !== report.archivePath && receipt.removed_source !== 1) {
          await verifyCarriedReceiptFile(currentDirectoryPath, archivePath, receipt.source_sha256);
        }
        movedReport.archivePath = archivePath;
      }
      sourceKey = resolveLegacyMigrationSourceKey(
        `workspace-${report.sourceKind}`,
        sourcePath,
        currentIdentity.workspaceKey,
      );
    }
    plan.replacements.push({
      originalKey: receipt.source_key,
      source_key: sourceKey,
      source_path: sourcePath,
      report_json: JSON.stringify(movedReport),
    });
  }
  assertReceiptMoveDestinations(database, plan);
  return plan;
}

/** Apply with the setup/alias move; preserve run history and every source-cleanup flag. */
export function applyWorkspaceMigrationReceiptMove(
  database: DatabaseSync,
  plan: WorkspaceMigrationReceiptMove,
): void {
  const current = readWorkspaceMoveReceipts(database, plan.storedIdentity, plan.currentIdentity);
  if (!isDeepStrictEqual(current, plan.receipts)) {
    throw receiptMoveFailure(
      plan.storedIdentity.workspacePath,
      "migration history changed during the move",
    );
  }
  assertReceiptMoveDestinations(database, plan);
  const kysely = getNodeSqliteKysely<WorkspaceReceiptDatabase>(database);
  for (const { originalKey, ...replacement } of plan.replacements) {
    executeSqliteQuerySync(
      database,
      kysely
        .updateTable("migration_sources")
        .set(replacement)
        .where("source_key", "=", originalKey),
    );
  }
}

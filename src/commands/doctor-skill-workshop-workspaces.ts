import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  readWorkspaceStateSnapshot,
  retireWorkspaceRelocationAttestation,
  WORKSPACE_ATTESTATION_RECENT_MS,
  WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND,
} from "../agents/workspace-state-store.js";
import { hasErrnoCode } from "../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
  resolveLegacyMigrationSourceKey,
} from "../infra/state-migrations.receipts.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

const MIGRATION_KIND = WORKSPACE_CONTENT_RELOCATION_MIGRATION_KIND;
const absolutePathSchema = z
  .string()
  .refine((value) => path.isAbsolute(value) && path.resolve(value) === value);
const relocationSchema = z.strictObject({
  workspaceDir: absolutePathSchema,
  workspaceKey: z.string(),
  workspacePath: absolutePathSchema,
  directoryIdentity: z.string(),
  attestedAtMs: z.number().int().nonnegative(),
  moves: z
    .array(
      z.strictObject({
        source: absolutePathSchema,
        destination: absolutePathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .min(1),
});
type WorkspaceRelocation = z.infer<typeof relocationSchema>;

async function directoryIdentity(directory: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(directory, { bigint: true });
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : undefined;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function containsOnlyMovingSkills(
  workspaceDir: string,
  sources: readonly string[],
  beforeMove: boolean,
): Promise<boolean> {
  const moving = new Set(beforeMove ? sources : []);
  const parents = new Set<string>();
  for (const source of sources) {
    if (!isPathInside(workspaceDir, source) || source === workspaceDir) {
      return false;
    }
    for (
      let parent = path.dirname(source);
      parent !== workspaceDir;
      parent = path.dirname(parent)
    ) {
      parents.add(parent);
    }
  }
  const pending = [workspaceDir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.name === ".DS_Store" && entry.isFile()) {
        continue;
      }
      if (!entry.isDirectory()) {
        return false;
      }
      if (moving.has(entryPath)) {
        moving.delete(entryPath);
      } else if (parents.has(entryPath)) {
        pending.push(entryPath);
      } else {
        return false;
      }
    }
  }
  return moving.size === 0;
}

/** Persist the pre-move facts; a retry must not infer them from an already empty workspace. */
export async function prepareWorkshopWorkspaceRelocation(
  workspaceDir: string,
  moves: readonly { source: string; destination: string }[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const sourceKey = resolveLegacyMigrationSourceKey(MIGRATION_KIND, workspaceDir);
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<Pick<DB, "migration_sources">>(database.db);
  const existing = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("migration_sources").select("status").where("source_key", "=", sourceKey),
  );
  if (existing?.status === "prepared") {
    return;
  }
  const snapshot = readWorkspaceStateSnapshot(workspaceDir, { env, readOnly: true });
  const attestation = snapshot.attestation;
  const now = Date.now();
  if (
    snapshot.setupExists ||
    !attestation ||
    attestation.generatedHashes.size > 0 ||
    attestation.attestedAtMs > now ||
    now - attestation.attestedAtMs > WORKSPACE_ATTESTATION_RECENT_MS
  ) {
    return;
  }
  const identity = await directoryIdentity(workspaceDir);
  if (
    !identity ||
    !(await containsOnlyMovingSkills(
      workspaceDir,
      moves.map((move) => move.source),
      true,
    ))
  ) {
    return;
  }
  const captured: WorkspaceRelocation = {
    workspaceDir,
    ...snapshot.identity,
    directoryIdentity: identity,
    attestedAtMs: attestation.attestedAtMs,
    moves: await Promise.all(
      moves.map(async (move) => ({
        source: move.source,
        destination: move.destination,
        sha256: await readSkillProposalTargetTreeSha256(move.source, { includeRootMetadata: true }),
      })),
    ),
  };
  if ((await directoryIdentity(workspaceDir)) !== identity) {
    return;
  }
  const reportJson = JSON.stringify(captured);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("migration_sources").select("status").where("source_key", "=", sourceKey),
      );
      if (current?.status === "prepared") {
        return;
      }
      const runId = randomUUID();
      recordLegacyMigrationRun(db, {
        runId,
        startedAt: now,
        finishedAt: null,
        status: "prepared",
        reportJson,
      });
      recordLegacyMigrationSource(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: workspaceDir,
        targetTable: "workspace_setup_state",
        sourceSha256: null,
        sourceSizeBytes: null,
        sourceRecordCount: moves.length,
        runId,
        status: "prepared",
        importedAt: now,
        reportJson,
        upsert: true,
      });
    },
    { env },
  );
}

/** Retire only obsolete skill-only evidence; missing, changed, and refreshed workspaces stay guarded. */
export async function finishWorkshopWorkspaceRelocations(env: NodeJS.ProcessEnv): Promise<void> {
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<Pick<DB, "migration_sources">>(database.db);
  const receipts = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("migration_sources")
      .selectAll()
      .where("migration_kind", "=", MIGRATION_KIND)
      .where("status", "=", "prepared"),
  ).rows;
  for (const receipt of receipts) {
    const captured = relocationSchema.parse(JSON.parse(receipt.report_json));
    const sources = captured.moves.map((move) => move.source);
    let complete = (await directoryIdentity(captured.workspaceDir)) === captured.directoryIdentity;
    if (complete) {
      complete = await containsOnlyMovingSkills(captured.workspaceDir, sources, false);
    }
    for (const move of complete ? captured.moves : []) {
      if (
        (await directoryIdentity(move.source)) !== undefined ||
        (await directoryIdentity(move.destination)) === undefined ||
        (await readSkillProposalTargetTreeSha256(move.destination, {
          includeRootMetadata: true,
        })) !== move.sha256
      ) {
        complete = false;
        break;
      }
    }
    if (complete) {
      complete = (await directoryIdentity(captured.workspaceDir)) === captured.directoryIdentity;
    }
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const current = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("migration_sources")
            .selectAll()
            .where("source_key", "=", receipt.source_key),
        );
        if (current?.status !== "prepared" || current.report_json !== receipt.report_json) {
          return;
        }
        const retired =
          complete &&
          retireWorkspaceRelocationAttestation({
            database: { db },
            identity: captured,
            attestedAtMs: captured.attestedAtMs,
          });
        const status = retired ? "completed" : "superseded";
        const reportJson = JSON.stringify({
          ...captured,
          outcome: retired ? "obsolete attestation retired" : "workspace or attestation changed",
        });
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("migration_sources")
            .set({ status, report_json: reportJson })
            .where("source_key", "=", receipt.source_key),
        );
        recordLegacyMigrationRun(db, {
          runId: current.last_run_id,
          startedAt: current.imported_at,
          finishedAt: Date.now(),
          status,
          reportJson,
          upsert: true,
        });
      },
      { env },
    );
  }
}

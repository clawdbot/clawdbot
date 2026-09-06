import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { sha256Hex } from "./crypto-digest.js";
import { requireDirectorySync, syncDirectory, syncDirectorySync } from "./directory-durability.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  copyCheckpointFile,
  inspectCheckpointFile,
  syncCheckpointTree,
} from "./update-checkpoint-files.js";
import {
  assertSqliteFamilyClosed,
  sameIdentity,
  planSchema,
  sharedBindingSchema,
  UpdateCheckpointRestorePlanIdentitySchema,
  reopenUpdateCheckpointRestorePlan,
  type UpdateCheckpointRestorePlanIdentity,
  type UpdateCheckpointRestorePlanRef,
} from "./update-checkpoint-plan.js";
import {
  assertUpdateCheckpointSqliteSchema,
  carryForwardUpdateCheckpointSqlite,
  createUpdateCheckpointSqliteSnapshot,
  selectUpdateCheckpointSqliteBase,
  UpdateCheckpointPreservationUnavailable,
} from "./update-checkpoint-sqlite.js";
import {
  reopenUpdateCheckpoint,
  type UpdateCheckpointAccess,
  type UpdateCheckpointRef,
} from "./update-checkpoint.js";
import type { UpdateRecoveryDatabaseBinding } from "./update-run-recovery.js";

/**
 * Seal every target before the first live replacement. afterUpdateRef MUST be
 * captured at the update-owned mutation boundary, before ordinary writers resume;
 * capturing current state during rollback would falsely claim ownership of work.
 * Recovery receives the immutable plan locator before writing preparing intent.
 * The final digest exists only after all targets pass validation. Preparing intent
 * alone never permits publication; recovery must bind the returned sealed plan
 * before applying a resource. No checkpoint artifact is rewritten after sealing.
 */
export async function prepareUpdateCheckpointRestore(
  params: UpdateCheckpointAccess & {
    checkpointRef: UpdateCheckpointRef;
    afterUpdateRef: UpdateCheckpointRef;
    /** Resume only the exact durable preparing identity; never supersede a sealed ref. */
    preparingPlan?: UpdateCheckpointRestorePlanIdentity;
    prepareSharedDatabase: (databases: {
      sourceDb: DatabaseSync;
      stagedDb: DatabaseSync;
      restoreId: string;
      /** Persist preparing intent with this locator; no final digest exists yet. */
      planIdentity: Readonly<UpdateCheckpointRestorePlanIdentity>;
    }) => void | {
      sourceBinding: UpdateRecoveryDatabaseBinding;
      stagedBinding: UpdateRecoveryDatabaseBinding;
    };
  },
): Promise<
  | { status: "ready"; planRef: UpdateCheckpointRestorePlanRef }
  | { status: "unavailable"; resource: string }
> {
  const checkpoint = await reopenUpdateCheckpoint(params.checkpointRef, params);
  const afterUpdate = await reopenUpdateCheckpoint(params.afterUpdateRef, params);
  const restoreId = params.preparingPlan?.restoreId ?? randomUUID();
  const planIdentity = Object.freeze({
    restoreId,
    checkpointId: params.checkpointRef.checkpointId,
    planPath: path.join(
      path.dirname(params.checkpointRef.manifestPath),
      `restore-${restoreId}.json`,
    ),
  });
  if (
    params.preparingPlan &&
    JSON.stringify(UpdateCheckpointRestorePlanIdentitySchema.parse(params.preparingPlan)) !==
      JSON.stringify(planIdentity)
  ) {
    throw new Error("Preparing restore identity mismatch");
  }
  if (await inspectCheckpointFile(planIdentity.planPath)) {
    if (!params.preparingPlan) {
      throw new Error("Restore plan already exists");
    }
    // The prior process may have published the immutable artifact and lost its
    // return value. Reopen it, never rewrite it or infer publication authority.
    // Final sealing still checks source authority, all logical data and file IDs.
    const bytes = await fs.readFile(planIdentity.planPath);
    const planRef = { ...planIdentity, planSha256: sha256Hex(bytes) };
    const reopened = await reopenUpdateCheckpointRestorePlan(planRef, params);
    if (
      JSON.stringify(reopened.plan.checkpointRef) !== JSON.stringify(params.checkpointRef) ||
      JSON.stringify(reopened.plan.afterUpdateRef) !== JSON.stringify(params.afterUpdateRef)
    ) {
      throw new Error("Existing preparation belongs to different checkpoint images");
    }
    return { status: "ready", planRef };
  }
  const plan: z.infer<typeof planSchema> = {
    restoreId,
    checkpointRef: params.checkpointRef,
    afterUpdateRef: params.afterUpdateRef,
    resources: [],
  };
  try {
    // Publish the shared owner first. Subsequent cursor writes must go only to
    // the restored copy, never back into the displaced candidate database.
    const sharedPath = path.join(params.binding.stateDir, "state", "openclaw.sqlite");
    const ordered = [...checkpoint.manifest.resources.entries()].toSorted(
      (a, b) => Number(b[1].sourcePath === sharedPath) - Number(a[1].sourcePath === sharedPath),
    );
    for (const [index, resource] of ordered) {
      if (resource.restore === "preserve") {
        continue;
      }
      const mutation = afterUpdate.manifest.resources.find(
        (entry) => entry.sourcePath === resource.sourcePath && entry.kind === resource.kind,
      );
      if (!mutation) {
        throw new UpdateCheckpointPreservationUnavailable(resource.sourcePath);
      }
      params.assertQuiescent();
      let before = await inspectCheckpointFile(resource.sourcePath);
      const sqlite = resource.kind === "sqlite";
      if (sqlite) {
        assertSqliteFamilyClosed(resource.sourcePath);
      }
      if (
        !sqlite &&
        (mutation.sourceBindingValidated !== true ||
          (!isDeepStrictEqual(before, mutation.sourceState) &&
            !isDeepStrictEqual(before, resource.sourceState)))
      ) {
        throw new UpdateCheckpointPreservationUnavailable(resource.sourcePath);
      }
      // Absent checkpoint DBs cannot discard databases created by online work.
      if (
        sqlite &&
        (!resource.artifact || !mutation.artifact || !before) &&
        (resource.artifact || mutation.artifact || before)
      ) {
        throw new UpdateCheckpointPreservationUnavailable(resource.sourcePath);
      }
      const stageDirectory = path.join(
        path.dirname(resource.sourcePath),
        `.openclaw-restore-${restoreId}-${index}`,
      );
      if (
        (await fs.realpath(path.dirname(resource.sourcePath))) !== path.dirname(resource.sourcePath)
      ) {
        throw new Error("Restore source requires a canonical parent directory");
      }
      if (params.preparingPlan && (await inspectCheckpointFile(stageDirectory))) {
        if (
          (await fs.realpath(stageDirectory)) !== stageDirectory ||
          (await inspectCheckpointFile(path.join(stageDirectory, "displaced")))
        ) {
          throw new Error("Cannot restage a published or noncanonical restore family");
        }
        // Preserve failed preparation as evidence. Rebuild from bound snapshots
        // and current state, not from a partially transformed old staging file.
        params.assertQuiescent();
        fsSync.renameSync(stageDirectory, `${stageDirectory}.abandoned-${randomUUID()}`);
        requireDirectorySync(
          syncDirectorySync(path.dirname(stageDirectory)),
          "Checkpoint restaging",
        );
      }
      await fs.mkdir(stageDirectory, { mode: 0o700 });
      const replacement = path.join(stageDirectory, "replacement");
      let after = resource.captured;
      if (resource.artifact && resource.captured) {
        const source = path.join(
          path.dirname(params.checkpointRef.manifestPath),
          resource.artifact,
        );
        if (sqlite && mutation.artifact) {
          const currentCopy = path.join(stageDirectory, "current.sqlite");
          await createUpdateCheckpointSqliteSnapshot({
            sourcePath: resource.sourcePath,
            targetPath: currentCopy,
            assertQuiescent: params.assertQuiescent,
          });
          const baselinePath = path.join(
            path.dirname(params.afterUpdateRef.manifestPath),
            mutation.artifact,
          );
          const previous = openNodeSqliteDatabase(source, { readOnly: true }),
            mutationDb = openNodeSqliteDatabase(baselinePath, { readOnly: true }),
            current = openNodeSqliteDatabase(currentCopy, { readOnly: true });
          let snapshotSource: string;
          try {
            snapshotSource =
              selectUpdateCheckpointSqliteBase({
                checkpoint: previous,
                afterUpdate: mutationDb,
                current,
              }) === "current"
                ? currentCopy
                : source;
          } finally {
            previous.close();
            mutationDb.close();
            current.close();
          }
          await createVerifiedSqliteSnapshot({
            preserveRowIds: true,
            sourcePath: snapshotSource,
            targetPath: replacement,
            transform: (stagedDb) => {
              const oldDb = openNodeSqliteDatabase(source, { readOnly: true });
              const afterDb = openNodeSqliteDatabase(baselinePath, { readOnly: true });
              const currentDb = openNodeSqliteDatabase(currentCopy, { readOnly: true });
              try {
                carryForwardUpdateCheckpointSqlite({
                  checkpoint: oldDb,
                  afterUpdate: afterDb,
                  current: currentDb,
                  staged: stagedDb,
                });
              } finally {
                oldDb.close();
                afterDb.close();
                currentDb.close();
              }
            },
            validate: (stagedDb, label) => {
              if (label === snapshotSource) {
                return;
              }
              const checkpointDb = openNodeSqliteDatabase(source, { readOnly: true });
              try {
                assertUpdateCheckpointSqliteSchema(checkpointDb, stagedDb);
              } finally {
                checkpointDb.close();
              }
            },
            beforePublish: params.assertQuiescent,
          });
          assertSqliteFamilyClosed(resource.sourcePath);
          // The carry-forward owner may have durably advanced its source intent.
          before = await inspectCheckpointFile(resource.sourcePath);
          after = await inspectCheckpointFile(replacement);
        } else {
          after = await copyCheckpointFile(source, replacement, resource.captured);
        }
      }
      await syncCheckpointTree(stageDirectory);
      requireDirectorySync(
        await syncDirectory(path.dirname(stageDirectory)),
        "Checkpoint restore staging",
      );
      plan.resources.push({
        sourcePath: resource.sourcePath,
        stageDirectory,
        before,
        after,
        sqlite,
        userVersion: resource.userVersion,
        recovery: null,
      });
    }
  } catch (error) {
    // Staging remains forensic evidence; nothing has yet been replaced.
    // The canonical snapshot owner wraps transform failures with its file context.
    const preservationError =
      error instanceof Error && error.cause instanceof UpdateCheckpointPreservationUnavailable
        ? error.cause
        : error;
    if (preservationError instanceof UpdateCheckpointPreservationUnavailable) {
      return { status: "unavailable", resource: preservationError.resource };
    }
    throw error;
  }
  // Do not pin a durable preparation until every resource has passed preservation
  // checks. A later resource conflict must leave recovery free to try again.
  const sharedPath = path.join(params.binding.stateDir, "state", "openclaw.sqlite");
  const shared = plan.resources.find(
    (resource) => resource.sourcePath === sharedPath && resource.sqlite,
  );
  if (shared?.before && shared.after) {
    const replacement = path.join(shared.stageDirectory, "replacement");
    const captured = checkpoint.manifest.resources.find(
      (resource) => resource.sourcePath === sharedPath,
    );
    if (!captured?.artifact) {
      throw new Error("Shared checkpoint artifact missing");
    }
    params.assertQuiescent();
    if (!sameIdentity(shared.before.identity, fsSync.lstatSync(sharedPath))) {
      throw new Error("Shared database changed while preparing restoration");
    }
    assertSqliteFamilyClosed(sharedPath);
    const sourceDb = openNodeSqliteDatabase(sharedPath),
      stagedDb = openNodeSqliteDatabase(replacement);
    const checkpointDb = openNodeSqliteDatabase(
      path.join(path.dirname(params.checkpointRef.manifestPath), captured.artifact),
      { readOnly: true },
    );
    try {
      const prepared = params.prepareSharedDatabase({
        sourceDb,
        stagedDb,
        restoreId,
        planIdentity,
      });
      assertUpdateCheckpointSqliteSchema(checkpointDb, stagedDb);
      if (prepared) {
        shared.recovery = sharedBindingSchema.parse({
          sourceBinding: prepared.sourceBinding,
          stagedBinding: prepared.stagedBinding,
        });
        if (
          shared.recovery.sourceBinding.runId !== params.binding.runId ||
          shared.recovery.stagedBinding.runId !== params.binding.runId ||
          shared.recovery.sourceBinding.transactionId !==
            shared.recovery.stagedBinding.transactionId
        ) {
          throw new Error("Recovery database binding does not match checkpoint run");
        }
      }
    } finally {
      checkpointDb.close();
      sourceDb.close();
      stagedDb.close();
    }
    await syncCheckpointTree(sharedPath);
    await syncCheckpointTree(replacement);
    assertSqliteFamilyClosed(sharedPath);
    assertSqliteFamilyClosed(replacement);
    shared.before = await inspectCheckpointFile(sharedPath);
    shared.after = await inspectCheckpointFile(replacement);
  }
  params.assertQuiescent();
  const bytes = JSON.stringify(plan);
  const { planPath } = planIdentity;
  const pendingPath = `${planPath}.pending-${randomUUID()}`;
  await fs.writeFile(pendingPath, bytes, { flag: "wx", mode: 0o600 });
  await syncCheckpointTree(pendingPath);
  params.assertQuiescent();
  fsSync.linkSync(pendingPath, planPath); // Exclusive publication, never overwrite a sealed plan.
  fsSync.unlinkSync(pendingPath);
  requireDirectorySync(await syncDirectory(path.dirname(planPath)), "Checkpoint restore plan");
  return {
    status: "ready",
    planRef: {
      ...planIdentity,
      planSha256: sha256Hex(bytes),
    },
  };
}

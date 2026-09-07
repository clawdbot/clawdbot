import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { z } from "zod";
import { readExistingAgentSchemaMeta } from "../state/openclaw-agent-db-schema-helpers.js";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "./sqlite-file-generation.js";
import {
  checkpointContentMatches,
  inspectCheckpointFile,
  syncCheckpointTree,
} from "./update-checkpoint-files.js";
import {
  assertSqliteFamilyClosed,
  isAbsentUpdateCheckpointRestoreResource,
  sameIdentity,
  reopenUpdateCheckpointRestorePlan,
  type RestoreResource,
  type UpdateCheckpointRestorePlanRef,
} from "./update-checkpoint-plan.js";
import { validateUpdateCheckpointPreviousRuntimeDatabase } from "./update-checkpoint-runtime.js";
import { assertUpdateCheckpointSqliteSchema } from "./update-checkpoint-sqlite.js";
import {
  reopenUpdateCheckpoint,
  type UpdateCheckpointAccess,
  type UpdateCheckpointReadAccess,
  type UpdateCheckpointRef,
} from "./update-checkpoint.js";
import {
  validateUpdateRecoveryPublicationDatabaseAtPath,
  type UpdateRecoveryPublicationLocation,
} from "./update-run-recovery-publication.js";
import {
  loadUpdateRecovery,
  prepareUpdateRecoveryCarryForward,
  validateUpdateRecoveryDatabaseBinding,
  type UpdateRecoveryRecord,
  type UpdateRecoveryFence,
} from "./update-run-recovery.js";

export { prepareUpdateCheckpointRestore } from "./update-checkpoint-prepare.js";
export {
  reopenUpdateCheckpointRestorePlan,
  type UpdateCheckpointRestorePlanRef,
} from "./update-checkpoint-plan.js";

export type UpdateCheckpointRestoreObservation = {
  observed: "before" | "after" | "conflict";
  restoreId: string;
  checkpointId: string;
  resourceCursor: number;
  sourcePath: string;
  before: RestoreResource["before"];
  after: RestoreResource["after"];
  userVersion: number | null;
};
export type UpdateCheckpointRestoreResult = UpdateCheckpointRestoreObservation &
  (
    | { status: "applied" | "already-applied" | "conflict" }
    | { status: "unavailable"; reason: "quiescence-unavailable" | "previous-runtime-unavailable" }
  );

function matchesOwnedFile(
  left: RestoreResource["before"],
  right: RestoreResource["before"],
  renamed = false,
): boolean {
  return (
    checkpointContentMatches(left, right) &&
    (left?.kind !== "directory" ||
      (left.descendantIdentitySha256 !== undefined &&
        left.descendantIdentitySha256 === right?.descendantIdentitySha256)) &&
    (left === null ||
      right === null ||
      (left.identity.dev === right.identity.dev &&
        left.identity.ino === right.identity.ino &&
        left.identity.size === right.identity.size &&
        left.identity.mtimeMs === right.identity.mtimeMs &&
        // Only a verified displacement/publication path may change root ctime.
        (renamed || left.identity.ctimeMs === right.identity.ctimeMs)))
  );
}

function sameOwnedIdentity(
  left: RestoreResource["before"],
  right: RestoreResource["before"],
): boolean {
  return left === null || right === null
    ? left === right
    : left.kind === right.kind &&
        left.mode === right.mode &&
        left.identity.dev === right.identity.dev &&
        left.identity.ino === right.identity.ino;
}

function assertRecordPlan(record: UpdateRecoveryRecord, ref: UpdateCheckpointRestorePlanRef): void {
  if (
    record.restore?.restoreId !== ref.restoreId ||
    record.restore.checkpointId !== ref.checkpointId ||
    record.restore.planPath !== ref.planPath ||
    record.restore.planSha256 !== ref.planSha256 ||
    record.restore.phase === "preparing"
  ) {
    throw new Error("Recovery record has not sealed this restore plan");
  }
}

async function observeResource(
  resource: RestoreResource,
  ref: UpdateCheckpointRestorePlanRef,
  record?: UpdateRecoveryRecord,
) {
  if (resource.before === null && resource.after === null) {
    return {
      observed: isAbsentUpdateCheckpointRestoreResource(resource)
        ? ("after" as const)
        : ("conflict" as const),
      current: null,
      displaced: null,
      staged: null,
    };
  }
  const parent = path.dirname(resource.sourcePath);
  if (
    (await fs.realpath(parent)) !== parent ||
    (await fs.realpath(resource.stageDirectory)) !== resource.stageDirectory
  ) {
    throw new Error("Restore resource parent changed");
  }
  // Never open a live SQLite database during reconciliation. Even read-only SQLite
  // opens can create sidecars. The sealed bytes already bind the verified schema.
  if (resource.sqlite) {
    for (const file of [
      resource.sourcePath,
      path.join(resource.stageDirectory, "replacement"),
      path.join(resource.stageDirectory, "displaced"),
    ]) {
      assertSqliteFamilyClosed(file);
    }
  }
  const current = await inspectCheckpointFile(resource.sourcePath);
  const displaced = await inspectCheckpointFile(path.join(resource.stageDirectory, "displaced"));
  const staged = await inspectCheckpointFile(path.join(resource.stageDirectory, "replacement"));
  let observed: UpdateCheckpointRestoreObservation["observed"] = "conflict";
  if (resource.recovery) {
    const recovery = resource.recovery;
    // Only the recovery owner may exclude its active row from the logical
    // binding. It validates that row against the exact current record or the
    // publication commitment, according to this plan-validated location.
    const matches = (
      file: string,
      actual: typeof current,
      expectedFile: typeof current,
      role: UpdateRecoveryPublicationLocation["role"],
    ) => {
      if (!actual || !record || !sameOwnedIdentity(actual, expectedFile)) {
        return false;
      }
      try {
        assertRecordPlan(record, ref);
        validateUpdateRecoveryPublicationDatabaseAtPath(
          { ...recovery, expected: record, role },
          { path: file },
        );
        return true;
      } catch {
        return false;
      }
    };
    const displacedPath = path.join(resource.stageDirectory, "displaced");
    const replacementPath = path.join(resource.stageDirectory, "replacement");
    const beforeCurrent = matches(resource.sourcePath, current, resource.before, "live-source");
    const beforeDisplaced = matches(displacedPath, displaced, resource.before, "displaced");
    const afterStaged = matches(replacementPath, staged, resource.after, "staged");
    if (afterStaged && ((beforeCurrent && !displaced) || (!current && beforeDisplaced))) {
      observed = "before";
    } else if (
      !staged &&
      beforeDisplaced &&
      matches(resource.sourcePath, current, resource.after, "live-restored")
    ) {
      // Live progress may advance beyond the displaced copy, but the displaced
      // row must still match the publication commitment held by the live record.
      observed = "after";
    }
    return { observed, current, displaced, staged };
  }
  if (
    matchesOwnedFile(current, resource.after, true) &&
    (resource.before === null
      ? displaced === null
      : matchesOwnedFile(displaced, resource.before, true))
  ) {
    observed = "after";
  } else if (
    matchesOwnedFile(staged, resource.after) &&
    ((matchesOwnedFile(current, resource.before) && displaced === null) ||
      (resource.before !== null &&
        current === null &&
        matchesOwnedFile(displaced, resource.before, true)))
  ) {
    observed = "before";
  }
  return { observed, current, displaced, staged };
}

type ResourceReadParams = UpdateCheckpointReadAccess & {
  planRef: UpdateCheckpointRestorePlanRef;
  resourceCursor: number;
  /** Fresh exact owner record, never authority by itself. */
  recoveryRecord?: UpdateRecoveryRecord;
};
async function inspectResource(params: ResourceReadParams) {
  const reopened = await reopenUpdateCheckpointRestorePlan(params.planRef, params);
  const resource = reopened.plan.resources[params.resourceCursor];
  if (!resource || !Number.isInteger(params.resourceCursor)) {
    throw new Error("Restore resource cursor out of range");
  }
  const state = await observeResource(resource, params.planRef, params.recoveryRecord);
  const observation: UpdateCheckpointRestoreObservation = {
    restoreId: params.planRef.restoreId,
    checkpointId: params.planRef.checkpointId,
    resourceCursor: params.resourceCursor,
    sourcePath: resource.sourcePath,
    before: resource.before,
    after: resource.after,
    userVersion: resource.userVersion,
    observed: state.observed,
  };
  return { resource, observation, checkpointRef: reopened.plan.checkpointRef, ...state };
}

/** No claim acquisition, migration, SQLite runtime open, or history write. */
export async function inspectUpdateCheckpointRestoreResource(
  params: ResourceReadParams,
): Promise<UpdateCheckpointRestoreObservation> {
  return (await inspectResource(params)).observation;
}

/** Facts required to rebind live lease owners; never a serialized capability. */
export type UpdateCheckpointSharedPublication = UpdateCheckpointReadAccess & {
  planRef: UpdateCheckpointRestorePlanRef;
  recoveryRecord: UpdateRecoveryRecord;
};

/** Called by the physical lease owner, not replaced with a caller's assertion.
 * Verify original logical bindings, exact live record and displaced commitment,
 * all plan/file identities and closed families before canonical writable admission.
 */
export async function verifyUpdateCheckpointSharedPublication(
  input: UpdateCheckpointSharedPublication,
  databasePath: string,
) {
  const params = structuredClone(input);
  const generation = readStableSqliteFileGeneration(databasePath);
  const inspected = await inspectResource({ ...params, resourceCursor: 0 });
  if (
    !inspected.resource.recovery ||
    inspected.resource.sourcePath !== databasePath ||
    inspected.observation.observed !== "after"
  ) {
    throw new Error("Canonical shared database has no verified checkpoint publication");
  }
  const current = readStableSqliteFileGeneration(databasePath);
  if (!sameSqliteFileGeneration(generation, current)) {
    throw new Error("Canonical shared database changed during publication validation");
  }
  return current;
}

/** Ownership comes from the hash-bound original, never from the derived file being checked. */
async function checkpointDatabaseReader(
  checkpointRef: UpdateCheckpointRef,
  sourcePath: string,
  access: UpdateCheckpointReadAccess,
): Promise<{ agentId?: string } | null> {
  const checkpoint = await reopenUpdateCheckpoint(checkpointRef, access);
  const captured = checkpoint.manifest.resources.find((entry) => entry.sourcePath === sourcePath);
  if (!captured?.artifact) {
    return null;
  }
  const database = openNodeSqliteDatabase(
    resolveImmutableSqliteFileUri(
      path.join(path.dirname(checkpointRef.manifestPath), captured.artifact),
    ),
    { readOnly: true },
  );
  try {
    const owner = readExistingAgentSchemaMeta(database);
    if (owner?.role === "agent" && owner.agentId) {
      return { agentId: owner.agentId };
    }
    return owner?.role === "global" && owner.agentId === null ? {} : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/** Reconcile one exact resource. Recovery owns intent/CAS and its durable cursor. */
export async function restoreUpdateCheckpointResource(
  params: ResourceReadParams & Pick<UpdateCheckpointAccess, "assertQuiescent">,
): Promise<UpdateCheckpointRestoreResult> {
  // Reconciliation is read-only and does not require mutation authority. Keep
  // its evidence separate from the executor's current exclusion check below.
  const initial = await inspectResource(params);
  const { checkpointRef } = initial;
  let { resource, observation, current, staged, displaced } = initial;
  if (observation.observed === "conflict") {
    return { ...observation, status: "conflict" };
  }
  const assertCurrent = (): undefined => {
    const completion: unknown = params.assertQuiescent();
    if (completion !== undefined) {
      // A Promise is not established exclusion. Handle an eventual rejection,
      // but never await it or use it to authorize this publication attempt.
      if (isPromiseLike(completion)) {
        void Promise.resolve(completion).catch(() => {});
      }
      throw new Error("Checkpoint exclusion must complete synchronously");
    }
    return undefined;
  };
  try {
    assertCurrent();
  } catch {
    // No effects have begun. Do not include arbitrary executor error contents
    // or turn failures after displacement/publication into this safe outcome.
    return { ...observation, status: "unavailable", reason: "quiescence-unavailable" };
  }
  if (resource.before === null && resource.after === null) {
    const absent = isAbsentUpdateCheckpointRestoreResource(resource);
    assertCurrent();
    return {
      ...observation,
      observed: absent ? "after" : "conflict",
      status: absent ? "already-applied" : "conflict",
    };
  }
  if (resource.sqlite) {
    for (const file of [
      resource.sourcePath,
      path.join(resource.stageDirectory, "replacement"),
      path.join(resource.stageDirectory, "displaced"),
    ]) {
      assertSqliteFamilyClosed(file);
    }
  }
  const replacement = path.join(resource.stageDirectory, "replacement");
  if (resource.sqlite && resource.after) {
    const reader = await checkpointDatabaseReader(checkpointRef, resource.sourcePath, params);
    if (!reader) {
      return { ...observation, status: "unavailable", reason: "previous-runtime-unavailable" };
    }
    // A previous process may have committed intent and then failed runtime
    // validation. Never treat that durable intent alone as publication proof.
    const file = observation.observed === "after" ? resource.sourcePath : replacement;
    const database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(file), {
      readOnly: true,
    });
    let validation;
    try {
      validation = await validateUpdateCheckpointPreviousRuntimeDatabase({
        database,
        ...reader,
        runtime: params.binding.fromRuntime,
        assertCurrent,
      });
    } finally {
      database.close();
    }
    if (validation.status !== "verified") {
      return { ...observation, status: "unavailable", reason: "previous-runtime-unavailable" };
    }
    // The external reader awaited work. Reconcile the exact owner records and
    // original logical bindings again, then check live authority immediately
    // before the existing physical guards and non-awaiting rename sequence.
    ({ resource, observation, current, staged, displaced } = await inspectResource(params));
    if (observation.observed === "conflict") {
      return { ...observation, status: "conflict" };
    }
    try {
      assertCurrent();
    } catch {
      return { ...observation, status: "unavailable", reason: "quiescence-unavailable" };
    }
    for (const member of [
      resource.sourcePath,
      replacement,
      path.join(resource.stageDirectory, "displaced"),
    ]) {
      assertSqliteFamilyClosed(member);
    }
  }
  const unchanged = (file: string, state: RestoreResource["before"]) =>
    state === null
      ? !fsSync.existsSync(file)
      : sameIdentity(state.identity, fsSync.lstatSync(file));
  if (
    !unchanged(resource.sourcePath, current) ||
    !unchanged(replacement, staged) ||
    !unchanged(path.join(resource.stageDirectory, "displaced"), displaced) ||
    fsSync.realpathSync(path.dirname(resource.sourcePath)) !== path.dirname(resource.sourcePath) ||
    fsSync.realpathSync(resource.stageDirectory) !== resource.stageDirectory
  ) {
    return { ...observation, status: "conflict", observed: "conflict" };
  }
  if (observation.observed === "before") {
    // The displaced file remains evidence for crash reconciliation. No awaited
    // work occurs between the current exclusion check and these effects.
    if (current) {
      fsSync.renameSync(resource.sourcePath, path.join(resource.stageDirectory, "displaced"));
      requireDirectorySync(
        syncDirectorySync(path.dirname(resource.sourcePath)),
        "Checkpoint displacement",
      );
      requireDirectorySync(
        syncDirectorySync(resource.stageDirectory),
        "Checkpoint displacement target",
      );
    }
    if (staged) {
      fsSync.renameSync(replacement, resource.sourcePath);
    }
  }
  // Reapply durability even for a recovered after-image: the previous process
  // could have died after rename but before either parent-directory fsync.
  requireDirectorySync(
    syncDirectorySync(path.dirname(resource.sourcePath)),
    "Checkpoint publication",
  );
  requireDirectorySync(syncDirectorySync(resource.stageDirectory), "Checkpoint publication source");
  const verified = await observeResource(resource, params.planRef, params.recoveryRecord);
  return {
    ...observation,
    observed: verified.observed,
    status:
      verified.observed !== "after"
        ? "conflict"
        : observation.observed === "after"
          ? "already-applied"
          : "applied",
  };
}

/** The consumer may restart the prior runtime only after every resource matches. */
export async function verifyUpdateCheckpointRestore(
  params: UpdateCheckpointReadAccess & {
    planRef: UpdateCheckpointRestorePlanRef;
    recoveryRecord?: UpdateRecoveryRecord;
  },
) {
  const reopened = await reopenUpdateCheckpointRestorePlan(params.planRef, params);
  const observations: UpdateCheckpointRestoreObservation[] = [];
  for (const resourceCursor of reopened.plan.resources.keys()) {
    observations.push(await inspectUpdateCheckpointRestoreResource({ ...params, resourceCursor }));
  }
  return {
    status: observations.some((entry) => entry.observed === "conflict")
      ? ("conflict" as const)
      : observations.every((entry) => entry.observed === "after")
        ? ("verified" as const)
        : ("incomplete" as const),
    restoreId: params.planRef.restoreId,
    checkpointId: params.planRef.checkpointId,
    binding: reopened.binding,
    exclusions: reopened.exclusions,
    observations,
  };
}

/** Attach the sealed plan to both exact owner records without rewriting artifacts. */
export async function sealUpdateCheckpointRestoreSharedDatabase(
  params: UpdateCheckpointAccess & {
    planRef: UpdateCheckpointRestorePlanRef;
    recoveryRecord: UpdateRecoveryRecord;
    fence: UpdateRecoveryFence;
    /** In-transaction checks only; the real retained reader runs after both commits below. */
    validateStagedDatabase: (db: DatabaseSync) => undefined;
  },
): Promise<UpdateRecoveryRecord> {
  const assertCurrent = (): undefined => {
    for (const check of [() => params.assertQuiescent(), () => params.fence.assertCurrent()]) {
      const result: unknown = check();
      if (result !== undefined) {
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => undefined);
        }
        throw new TypeError("Checkpoint sealing requires synchronous current exclusion");
      }
    }
    return undefined;
  };
  const reopened = await reopenUpdateCheckpointRestorePlan(params.planRef, params);
  const resource = reopened.plan.resources[0];
  if (!resource?.recovery || !resource.before || !resource.after) {
    throw new Error("Restore plan has no recovery-bound shared database");
  }
  const replacement = path.join(resource.stageDirectory, "replacement");
  const sourceState = await inspectCheckpointFile(resource.sourcePath);
  const stageState = await inspectCheckpointFile(replacement);
  if (
    !sameOwnedIdentity(sourceState, resource.before) ||
    !sameOwnedIdentity(stageState, resource.after) ||
    (await inspectCheckpointFile(path.join(resource.stageDirectory, "displaced")))
  ) {
    throw new Error("Shared database changed before recovery sealing");
  }
  const captured = (
    await reopenUpdateCheckpoint(reopened.plan.checkpointRef, params)
  ).manifest.resources.find((entry) => entry.sourcePath === resource.sourcePath);
  if (!captured?.artifact) {
    throw new Error("Missing shared checkpoint artifact");
  }
  assertCurrent();
  if (
    !sourceState ||
    !stageState ||
    !sameIdentity(sourceState.identity, fsSync.lstatSync(resource.sourcePath)) ||
    !sameIdentity(stageState.identity, fsSync.lstatSync(replacement)) ||
    fsSync.realpathSync(resource.sourcePath) !== resource.sourcePath ||
    fsSync.realpathSync(replacement) !== replacement
  ) {
    throw new Error("Shared database changed during recovery sealing");
  }
  assertSqliteFamilyClosed(resource.sourcePath);
  assertSqliteFamilyClosed(replacement);
  // A failed first commit can leave a newer active record only in staging.
  // Validate it as data, not authority. The carry-forward owner overwrites it
  // from the current source-authorized intent before publication is permitted.
  const stagedRecord = loadUpdateRecovery(params.recoveryRecord.runId, { path: replacement });
  if (!stagedRecord) {
    throw new Error("Missing staged recovery record");
  }
  assertCurrent();
  const sourceDb = openNodeSqliteDatabase(resource.sourcePath);
  const stagedDb = openNodeSqliteDatabase(replacement);
  let sealed: UpdateRecoveryRecord;
  try {
    validateUpdateRecoveryDatabaseBinding(
      sourceDb,
      params.recoveryRecord,
      resource.recovery.sourceBinding,
    );
    validateUpdateRecoveryDatabaseBinding(stagedDb, stagedRecord, resource.recovery.stagedBinding);
    const checkpointDb = openNodeSqliteDatabase(
      path.join(path.dirname(reopened.plan.checkpointRef.manifestPath), captured.artifact),
      { readOnly: true },
    );
    try {
      const result = prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: params.recoveryRecord,
        nextProgress: { ...params.planRef, resourceCursor: 0, phase: "intent" },
        fence: { assertCurrent },
        validateStagedDatabase(db) {
          assertUpdateCheckpointSqliteSchema(checkpointDb, db);
          const validation: unknown = params.validateStagedDatabase(db);
          if (validation !== undefined) {
            if (isPromiseLike(validation)) {
              void Promise.resolve(validation).catch(() => undefined);
            }
            throw new TypeError("validateStagedDatabase must be synchronous and return undefined");
          }
        },
      });
      sealed = result.record;
      validateUpdateRecoveryDatabaseBinding(sourceDb, sealed, resource.recovery.sourceBinding);
      validateUpdateRecoveryDatabaseBinding(stagedDb, sealed, resource.recovery.stagedBinding);
    } finally {
      checkpointDb.close();
    }
    // The retained release runs in another process. It must see the FINAL
    // committed carry-forward image, including sealed-plan intent, not the old
    // image visible while validateStagedDatabase executes inside a transaction.
    const validation = await validateUpdateCheckpointPreviousRuntimeDatabase({
      database: stagedDb,
      runtime: params.binding.fromRuntime,
      assertCurrent,
    });
    if (validation.status !== "verified") {
      throw new Error("Previous runtime database validation unavailable: " + validation.reason);
    }
    assertCurrent();
    validateUpdateRecoveryDatabaseBinding(sourceDb, sealed, resource.recovery.sourceBinding);
    validateUpdateRecoveryDatabaseBinding(stagedDb, sealed, resource.recovery.stagedBinding);
  } finally {
    sourceDb.close();
    stagedDb.close();
  }
  await syncCheckpointTree(resource.sourcePath);
  await syncCheckpointTree(replacement);
  assertCurrent();
  if ((await observeResource(resource, params.planRef, sealed)).observed !== "before") {
    throw new Error("Recovery sealing did not preserve restore bindings");
  }
  return sealed;
}

/**
 * Read-only discovery before admission when the canonical shared DB is absent.
 * These are untrusted locators, not a selected plan, claim, or recovery verdict.
 * Recovery must read the exact record in the family, reopen its bound immutable
 * plan and reconcile through inspectUpdateCheckpointRestoreResource before writes.
 */
export async function discoverUpdateCheckpointRestoreFamilies(sourcePath: string) {
  const parent = path.dirname(sourcePath);
  if (
    !path.isAbsolute(sourcePath) ||
    path.normalize(sourcePath) !== sourcePath ||
    (await fs.realpath(parent)) !== parent
  ) {
    throw new Error("Noncanonical restore family parent");
  }
  const families: {
    restoreId: string;
    sourcePath: string;
    stageDirectory: string;
    replacementPath: string;
    displacedPath: string;
  }[] = [];
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const match = /^\.openclaw-restore-([a-f0-9-]{36})-([0-9]+)$/u.exec(entry.name);
    if (!match) {
      continue;
    }
    const restoreId = z.string().uuid().parse(match[1]);
    const stageDirectory = path.join(parent, entry.name);
    if (!entry.isDirectory() || (await fs.realpath(stageDirectory)) !== stageDirectory) {
      throw new Error("Invalid restore family directory");
    }
    if (families.length >= 4096) {
      throw new Error("Too many restore families to reconcile");
    }
    families.push({
      restoreId,
      sourcePath,
      stageDirectory,
      replacementPath: path.join(stageDirectory, "replacement"),
      displacedPath: path.join(stageDirectory, "displaced"),
    });
  }
  return families.toSorted((a, b) => a.stageDirectory.localeCompare(b.stageDirectory));
}

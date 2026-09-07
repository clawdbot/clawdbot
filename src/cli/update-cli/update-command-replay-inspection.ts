import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { reopenUpdateCheckpointRestorePlan } from "../../infra/update-checkpoint-plan.js";
import {
  discoverUpdateCheckpointRestoreFamilies,
  inspectUpdateCheckpointRestoreResource,
} from "../../infra/update-checkpoint-restore.js";
import { validateUpdateRecoveryPublicationDatabaseAtPath } from "../../infra/update-run-recovery-publication.js";
import {
  UpdateRecoveryRecordSchema,
  isUpdateRecoveryPending,
} from "../../infra/update-run-recovery-schema.js";
import {
  inspectUpdateRecoveries,
  loadUpdateRecovery,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

async function present(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Read-only evidence. No claim, writer, service effect or executable authority. */
export async function inspectUpdateCommandSealedReplay(
  record: UpdateRecoveryRecord,
  env: NodeJS.ProcessEnv,
) {
  const progress = record.restore;
  const checkpoint = record.checkpoint;
  const source = record.source;
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const intent = record.effects.at(-1);
  if (
    !source ||
    !checkpoint ||
    !progress?.planSha256 ||
    progress.phase === "preparing" ||
    record.terminal ||
    !record.primaryFailure ||
    source.stateDir !== resolveStateDir(env) ||
    source.configPath !== resolveConfigPath(env) ||
    source.profile !== (env.OPENCLAW_PROFILE?.trim() || null) ||
    checkpoint.binding.stateDir !== source.stateDir ||
    intent?.kind !== "checkpoint-restore" ||
    intent.state !== "intent" ||
    intent.runtime !== "previous" ||
    intent.resourceId !== checkpoint.ref.checkpointId
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Interrupted recovery has no matching sealed publication intent.",
    );
  }
  const artifactRoot = path.join(
    path.dirname(source.stateDir),
    `.${path.basename(source.stateDir)}-update-checkpoints`,
  );
  const planRef = {
    restoreId: progress.restoreId,
    checkpointId: progress.checkpointId,
    planPath: progress.planPath,
    planSha256: progress.planSha256,
  };
  const reopened = await reopenUpdateCheckpointRestorePlan(planRef, {
    artifactRoot,
    binding: checkpoint.binding,
  });
  const shared = reopened.plan.resources[0];
  if (
    !shared?.recovery ||
    !shared.sqlite ||
    shared.sourcePath !== databasePath ||
    !isDeepStrictEqual(reopened.plan.checkpointRef, checkpoint.ref)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Sealed publication does not bind the admitted database.",
    );
  }
  const evidencePath = (await present(databasePath))
    ? databasePath
    : path.join(shared.stageDirectory, "displaced");
  if (!isDeepStrictEqual(loadUpdateRecovery(record.runId, { path: evidencePath, env }), record)) {
    throw new UpdateCommandRecoveryPendingError("Interrupted recovery evidence changed.");
  }
  for (let resourceCursor = 0; resourceCursor < reopened.plan.resources.length; resourceCursor++) {
    const observed = await inspectUpdateCheckpointRestoreResource({
      artifactRoot,
      binding: checkpoint.binding,
      planRef,
      resourceCursor,
      recoveryRecord: record,
    });
    if (
      observed.observed === "conflict" ||
      (resourceCursor < progress.resourceCursor && observed.observed !== "after") ||
      (resourceCursor === progress.resourceCursor &&
        progress.phase === "observed" &&
        observed.observed !== "after")
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Interrupted publication conflicts with its immutable resource evidence.",
      );
    }
  }
  return { artifactRoot, planRef, plan: reopened.plan, evidencePath, databasePath };
}

/** Locators select nothing by themselves. Missing/unreadable or competing
 * evidence is a refusal, never a fresh-install decision. */
export async function discoverUpdateCommandRecovery(
  env: NodeJS.ProcessEnv,
): Promise<UpdateRecoveryRecord | undefined> {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const pending = (records: UpdateRecoveryRecord[]) => records.filter(isUpdateRecoveryPending);
  const readCurrent = (file: string) => {
    const inspected = inspectUpdateRecoveries({ path: file, env });
    if (
      inspected.some(
        ({ format, record }) => format !== "current" && isUpdateRecoveryPending(record),
      )
    ) {
      throw new UpdateCommandRecoveryPendingError("Legacy recovery remains unresolved.");
    }
    // Historical terminal diagnostics confer no mutation authority. Only current
    // records may be returned to the executor admission path.
    return inspected
      .filter(({ format }) => format === "current")
      .map(({ record }) => UpdateRecoveryRecordSchema.parse(record));
  };
  if (!(await present(path.dirname(databasePath)))) {
    return undefined;
  }
  const families = await discoverUpdateCheckpointRestoreFamilies(databasePath);
  if (await present(databasePath)) {
    const all = readCurrent(databasePath);
    const records = pending(all);
    if (records.length > 1) {
      throw new UpdateCommandRecoveryPendingError(
        "Multiple interrupted update owners require reconciliation.",
      );
    }
    for (const family of families) {
      const matches = all.filter((record) => record.restore?.restoreId === family.restoreId);
      const record = matches.length === 1 ? matches[0] : undefined;
      if (!record?.source || !record.checkpoint || !record.restore?.planSha256) {
        throw new UpdateCommandRecoveryPendingError(
          "Canonical state has an unmatched recovery family.",
        );
      }
      const artifactRoot = path.join(
        path.dirname(record.source.stateDir),
        `.${path.basename(record.source.stateDir)}-update-checkpoints`,
      );
      const reopened = await reopenUpdateCheckpointRestorePlan(
        {
          restoreId: record.restore.restoreId,
          checkpointId: record.restore.checkpointId,
          planPath: record.restore.planPath,
          planSha256: record.restore.planSha256,
        },
        { artifactRoot, binding: record.checkpoint.binding },
      );
      const shared = reopened.plan.resources[0];
      if (
        record.source.stateDir !== resolveStateDir(env) ||
        shared?.sourcePath !== databasePath ||
        shared.stageDirectory !== family.stageDirectory ||
        !shared.recovery ||
        !isDeepStrictEqual(reopened.plan.checkpointRef, record.checkpoint.ref)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Recovery family differs from its sealed publication.",
        );
      }
      if (await present(family.displacedPath)) {
        validateUpdateRecoveryPublicationDatabaseAtPath(
          {
            role: "displaced",
            expected: record,
            sourceBinding: shared.recovery.sourceBinding,
            stagedBinding: shared.recovery.stagedBinding,
          },
          { path: family.displacedPath, env },
        );
      }
    }
    return records[0];
  }
  if (families.length === 0) {
    return undefined;
  }
  const candidates: UpdateRecoveryRecord[] = [];
  for (const family of families) {
    if (!(await present(family.displacedPath))) {
      continue;
    }
    for (const record of pending(readCurrent(family.displacedPath))) {
      if (record.restore?.restoreId !== family.restoreId) {
        continue;
      }
      const checked = await inspectUpdateCommandSealedReplay(record, env);
      if (checked.plan.resources[0]?.stageDirectory === family.stageDirectory) {
        candidates.push(record);
      }
    }
  }
  if (candidates.length !== 1) {
    throw new UpdateCommandRecoveryPendingError(
      "Missing canonical database has no unique verified recovery family.",
    );
  }
  return candidates[0];
}

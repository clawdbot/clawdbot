import { formatErrorMessage } from "../../infra/errors.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { printResult } from "./progress.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import {
  assertUpdateCommandRecovery,
  finalizeUpdateCommandRecovery,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import {
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { retireSupersededUpdateCommandPair } from "./update-command-retirement.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

/** Recovery must reconcile the publication family before any canonical read or legacy effects. */
export async function finishDurableUpdate(
  params: FinishUpdateParams,
): Promise<UpdateRunResult | undefined> {
  const { opts } = params;
  if (!opts.recovery) {
    try {
      const paths = new Set<string>();
      for (const env of [
        params.preManagedServiceStop?.serviceEnv ??
          params.ownedManagedUpdateEnv ??
          opts.run?.env ??
          process.env,
        opts.run?.env,
      ]) {
        if (!env) {
          continue;
        }
        const file = resolveOpenClawStateSqlitePath(env);
        if (paths.has(file)) {
          continue;
        }
        paths.add(file);
        await assertUpdateRecoveryAdmission({ env });
      }
      assertUpdateCommandRecovery(opts);
      return undefined;
    } catch (error) {
      throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(error), {
        cause: error,
      });
    }
  }

  let result: UpdateRunResult;
  let runningVersion: string | undefined;
  try {
    const record = opts.recovery.getRecord();
    const runtime = record.verification?.runtime;
    if (params.result.status === "error" && runtime !== "previous") {
      const replay = await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, () =>
        rollbackFailedUpdate({
          result: params.result,
          previousRoot: params.root,
          packageTransaction: params.packageTransaction,
          rollbackBlockedReason: params.rollbackBlockedReason,
          schemaVersions: params.schemaVersions,
          candidateSchemaVersions: params.candidateSchemaVersions,
          previousSchemaVersions: params.previousSchemaVersions,
          previousVerified: params.previousVerified,
          configSnapshot: params.configSnapshot,
          activationConfig: params.activationConfig,
          opts,
          preManagedServiceStop: params.preManagedServiceStop,
          timeoutMs: params.updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
          invocationCwd: params.invocationCwd,
        }),
      );
      // Even verified checkpoint files leave package/native restoration and fresh
      // previous-boot serving proof pending. No restart or terminal write follows.
      throw new UpdateCommandPendingRecoveryFailure(replay.result, replay.pendingRecoveryReason);
    }
    assertUpdateCommandRecovery(opts);
    const status =
      params.result.status === "ok" && runtime === "candidate"
        ? "succeeded"
        : params.result.status === "error" && runtime === "previous"
          ? "rolled-back"
          : null;
    if (!status) {
      throw new UpdateCommandRecoveryPendingError(
        "Finish fenced recovery and serving verification before finalization.",
      );
    }
    await finalizeUpdateCommandRecovery(opts, status);
    if (status === "succeeded") {
      await retireSupersededUpdateCommandPair(opts.recovery);
    }
    assertUpdateCommandRecovery(opts);
    result = completeUpdateCommandRun(
      { ...params.result, durationMs: Math.max(0, Date.now() - params.startedAt) },
      opts.run,
    );
    runningVersion = record.verification?.receipt.gateway.version;
  } catch (error) {
    if (error instanceof UpdateCommandPendingRecoveryFailure) {
      throw error;
    }
    throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(error), {
      cause: error,
    });
  }
  printResult(result, opts, {
    nextAction: resolveUpdateResultNextAction({
      result,
      serviceRunning: true,
      runningVersion,
      env: opts.run?.env ?? process.env,
    }),
  });
  if (result.status === "error") {
    throw new UpdateCommandFinalizedRecoveryFailure(result);
  }
  return result;
}

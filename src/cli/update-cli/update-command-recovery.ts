import { isDeepStrictEqual } from "node:util";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { createUpdateRecoveryCheckpointAdapter } from "../../infra/update-run-recovery-checkpoint.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import { createUpdateRecoveryCheckpointReplay } from "../../infra/update-run-recovery-replay.js";
import type { UpdateRecoveryReadinessReceipt } from "../../infra/update-run-recovery-schema.js";
import { commitUpdateRecoveryTerminal } from "../../infra/update-run-recovery-terminal.js";
import {
  assertExactUpdateRecoveryClaim,
  loadUpdateRecovery,
  recordUpdateRecoveryVerification,
  UpdateRecoveryRequiredError,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawStateLeaseContext } from "../../state/openclaw-state-lease.js";
import type { UpdateCommandOptions } from "./shared.js";

/** Live executor context only. Never serialize it into worker options or a descriptor. */
export type UpdateCommandRecovery = Parameters<typeof createUpdateRecoveryPackageHooks>[0] & {
  /** Rechecks final lifecycle readiness, not merely stored proof or a claim ID. */
  assertReady: () => void;
  /**
   * Executor-owned PUBLICATION interval with live lease rebinding, not capture
   * exclusion. No default: the capture-only owner must never be adapted here.
   * Runtime callbacks and the interval fence are supplied only while held.
   */
  checkpointReplay?: {
    withDatabaseFilePublication: NonNullable<
      OpenClawStateLeaseContext["withDatabaseFilePublication"]
    >;
    /** Runtime/resource owners remain responsible for these live assertions. */
    access: Omit<
      Parameters<typeof createUpdateRecoveryCheckpointReplay>[0],
      "expected" | "database" | "fence" | "bindPublishedRecord"
    >;
  };
};

export class UpdateCommandRecoveryPendingError extends Error {
  override name = "UpdateCommandRecoveryPendingError";
}

/** Stop legacy finalization before diagnostic writes, restarts, or backup cleanup. */
export function assertUpdateCommandRecovery(
  opts: UpdateCommandOptions,
  expected = opts.recovery?.getRecord(),
): void {
  if (!opts.run) {
    if (opts.recovery) {
      throw new UpdateCommandRecoveryPendingError("Recovery requires its admitted update run.");
    }
    return;
  }
  const current = loadUpdateRecovery(opts.run.runId, { env: opts.run.env });
  if (!opts.recovery) {
    if (current) {
      throw new UpdateRecoveryRequiredError(current);
    }
    return;
  }
  if (!current || !expected || expected.runId !== opts.run.runId) {
    throw new UpdateCommandRecoveryPendingError("Recovery does not match the admitted run.");
  }
  // The run-selected DB is authoritative; a supplied options object cannot redirect it.
  assertExactUpdateRecoveryClaim(expected, opts.recovery.fence, { env: opts.run.env });
}

export function persistUpdateCommandServingReceipt(
  opts: UpdateCommandOptions,
  receipt: UpdateRecoveryReadinessReceipt,
): UpdateRecoveryRecord | undefined {
  const recovery = opts.recovery;
  if (!recovery) {
    return undefined;
  }
  if (!opts.run) {
    throw new UpdateCommandRecoveryPendingError("Recovery requires its admitted update run.");
  }
  assertUpdateCommandRecovery(opts);
  const record = recovery.getRecord();
  const restart = record.effects.at(-1);
  if (restart?.kind !== "service-restart" || restart.state !== "observed") {
    throw new UpdateCommandRecoveryPendingError("Reconcile the restart before readiness proof.");
  }
  const next = recordUpdateRecoveryVerification(
    record,
    { runtime: restart.runtime, receipt },
    recovery.fence,
    { env: opts.run.env },
  );
  recovery.onRecord(next);
  assertUpdateCommandRecovery(opts, next);
  return next;
}

/**
 * Failure-path consumer of the checkpoint adapter and sealed-plan driver.
 * Fresh preparation, sealing, publication and progress share one live window.
 * Existing preparing records remain pending for explicit owner reconciliation.
 * The admitted environment,
 * never supplied database options, selects the canonical DB. Inspection occurs
 * in the driver before any writable reopen/claim, including absent canonical DB.
 * This does not settle the generic restore effect, package roles, or serving proof.
 */
export async function replayUpdateCommandRecovery(opts: UpdateCommandOptions) {
  const recovery = opts.recovery;
  const run = opts.run;
  if (!recovery || !run) {
    throw new UpdateCommandRecoveryPendingError("Replay requires its admitted recovery executor.");
  }
  const expected = recovery.getRecord();
  if (
    expected.runId !== run.runId ||
    !expected.checkpoint ||
    resolveOpenClawStateSqlitePath(run.env) !==
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: expected.checkpoint.binding.stateDir })
  ) {
    throw new UpdateCommandRecoveryPendingError("Replay does not match the admitted state root.");
  }
  if (expected.terminal || !expected.primaryFailure) {
    throw new UpdateCommandRecoveryPendingError("Replay requires an unresolved update failure.");
  }
  const publication = recovery.checkpointReplay;
  if (!publication) {
    throw new UpdateCommandRecoveryPendingError(
      "Live publication and lease rebinding are unavailable.",
    );
  }
  if (
    expected.restore &&
    (!expected.restore.planSha256 || expected.restore.phase === "preparing")
  ) {
    return { status: "preparing" as const, record: expected };
  }
  let entered = false;
  let completed:
    | Awaited<ReturnType<ReturnType<typeof createUpdateRecoveryCheckpointReplay>["replay"]>>
    | undefined;
  const result = await publication.withDatabaseFilePublication(
    async (assertCurrent, bindPublishedRecord) => {
      const access = publication.access;
      if (entered) {
        throw new UpdateCommandRecoveryPendingError("Publication may enter replay only once.");
      }
      entered = true;
      const fence = {
        assertCurrent() {
          if (recovery.fence.assertCurrent() !== undefined || assertCurrent() !== undefined) {
            throw new UpdateCommandRecoveryPendingError(
              "Replay authority must complete synchronously.",
            );
          }
        },
      };
      fence.assertCurrent();
      const params = {
        ...access,
        expected,
        database: { env: run.env },
        fence,
        bindPublishedRecord,
      };
      let replayRecord = expected;
      if (!expected.restore) {
        // First-time preparation must share the window with seal, physical
        // publication and every progress write: later renewal changes frozen rows.
        const intent = expected.effects.at(-1);
        if (
          intent?.kind !== "checkpoint-restore" ||
          intent.state !== "intent" ||
          intent.runtime !== "previous" ||
          intent.resourceId !== expected.checkpoint?.ref.checkpointId ||
          expected.nativeManager?.effects.at(-1)?.state === "intent" ||
          (expected.nativeManager &&
            !(expected.nativeManager.effects.at(-1)?.after ?? expected.nativeManager.original)
              .stopped)
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Reconcile restore intent before preparation.",
          );
        }
        const adapter = createUpdateRecoveryCheckpointAdapter(params);
        try {
          const prepared = await adapter.prepare();
          if (prepared.status !== "ready") {
            throw new UpdateCommandRecoveryPendingError("Checkpoint preparation is unavailable.");
          }
          replayRecord = await adapter.seal(prepared.planRef);
        } finally {
          if (!isDeepStrictEqual(adapter.record, expected)) {
            recovery.onRecord(adapter.record);
          }
        }
      }
      const driver = createUpdateRecoveryCheckpointReplay({ ...params, expected: replayRecord });
      try {
        completed = await driver.replay();
        fence.assertCurrent();
        if (completed.status !== "verified") {
          // A shared resource may already be published. Returning normally would
          // renew the lease rows and invalidate the bindings still needed by replay.
          throw new UpdateCommandRecoveryPendingError(
            `Checkpoint replay remains ${completed.status}.`,
          );
        }
        const record = completed.record;
        const progress = record.restore;
        if (!record.checkpoint || !progress?.planSha256) {
          throw new UpdateCommandRecoveryPendingError("Verified replay has no immutable plan.");
        }
        return {
          result: completed,
          publication: {
            artifactRoot: access.artifactRoot,
            binding: record.checkpoint.binding,
            planRef: {
              restoreId: progress.restoreId,
              checkpointId: progress.checkpointId,
              planPath: progress.planPath,
              planSha256: progress.planSha256,
            },
            recoveryRecord: record,
          },
        };
      } finally {
        // This is returned durable evidence, not authority. Even when the wrapper
        // later loses its lease, never leave the executor pointing at an old claim.
        if (!isDeepStrictEqual(driver.record, expected)) {
          recovery.onRecord(driver.record);
        }
      }
    },
  );
  // An inner verified result is unusable unless the actual outer owner settled.
  // A wrapper that skipped the operation cannot manufacture restoration success.
  if (!completed || result !== completed) {
    throw new UpdateCommandRecoveryPendingError("Publication did not return its replay outcome.");
  }
  if (recovery.fence.assertCurrent() !== undefined) {
    throw new UpdateCommandRecoveryPendingError("Recovery authority did not survive publication.");
  }
  return result;
}

/**
 * Consume the actual package owner's observation and Recovery's atomic terminal
 * decision. No complete(true/false), filesystem retirement, or checkpoint cleanup.
 */
export async function finalizeUpdateCommandRecovery(
  opts: UpdateCommandOptions,
  status: "succeeded" | "rolled-back",
): Promise<void> {
  const recovery = opts.recovery;
  if (!recovery || !opts.run) {
    throw new UpdateCommandRecoveryPendingError("A current recovery executor is required.");
  }
  try {
    assertUpdateCommandRecovery(opts);
    const expected = recovery.getRecord();
    const descriptor = expected.package?.descriptor;
    if (!descriptor || expected.effects.some((effect) => effect.state === "intent")) {
      throw new UpdateCommandRecoveryPendingError("Reconcile pending package effects first.");
    }
    const options = { env: opts.run.env };
    const hooks = createUpdateRecoveryPackageHooks({ ...recovery, options });
    const opened = await reopenPackageUpdateTransaction({
      descriptor,
      expectedLiveRoot: expected.from.root,
      expectedBinDir: descriptor.binDir,
      expectedTransactionId: expected.transactionId,
      hooks,
    });
    assertExactUpdateRecoveryClaim(expected, recovery.fence, options);
    if (opened.status !== "ready") {
      // Package unavailability may follow mutation. Leave its intent/material untouched.
      throw new UpdateCommandRecoveryPendingError("Package roles require reconciliation.");
    }
    const assertReady = () => {
      if (recovery.fence.assertCurrent() !== undefined || recovery.assertReady() !== undefined) {
        throw new UpdateCommandRecoveryPendingError("Readiness must complete synchronously.");
      }
    };
    let committed: UpdateRecoveryRecord;
    if (expected.terminal) {
      if (expected.terminal.status !== status) {
        throw new UpdateCommandRecoveryPendingError("Durable terminal outcome differs.");
      }
      assertReady();
      committed = expected;
    } else {
      committed = commitUpdateRecoveryTerminal(
        expected,
        { status, package: opened.observed, assertReady },
        recovery.fence,
        options,
      );
      recovery.onRecord(committed);
    }
    const decision = committed.package?.descriptor.retention;
    if (status === "succeeded") {
      if (decision?.state !== "selected") {
        throw new UpdateCommandRecoveryPendingError("The previous pair is not selected.");
      }
      // Retain acknowledges an ALREADY committed selection; it never chooses or deletes.
      const retained = await opened.transaction.retain(decision);
      assertUpdateCommandRecovery(opts);
      assertReady();
      if (retained.status !== "verified") {
        throw new UpdateCommandRecoveryPendingError("Selected package retention is unresolved.");
      }
    }
    // Rolled-back/unselected and superseded material are deliberately left to replay/retirement.
  } catch (cause) {
    if (cause instanceof UpdateCommandRecoveryPendingError) {
      throw cause;
    }
    throw new UpdateCommandRecoveryPendingError("Durable finalization requires reconciliation.", {
      cause,
    });
  }
}

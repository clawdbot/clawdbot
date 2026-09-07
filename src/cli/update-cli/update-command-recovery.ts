import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import { commitUpdateRecoveryTerminal } from "../../infra/update-run-recovery-terminal.js";
import {
  assertExactUpdateRecoveryClaim,
  loadUpdateRecovery,
  recordUpdateRecoveryVerification,
  UpdateRecoveryRequiredError,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import type { UpdateServingReceipt } from "../../infra/update-serving-verification-receipt.js";
import type { UpdateCommandOptions } from "./shared.js";

/** Live executor context only. Never serialize it into worker options or a descriptor. */
export type UpdateCommandRecovery = Parameters<typeof createUpdateRecoveryPackageHooks>[0] & {
  /** Rechecks final lifecycle readiness, not merely stored proof or a claim ID. */
  assertReady: () => void;
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
  receipt: UpdateServingReceipt,
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
    throw new UpdateCommandRecoveryPendingError("Reconcile the restart before serving proof.");
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

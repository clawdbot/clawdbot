/** Fenced cleanup for non-authoritative update-report body artifacts. */
import { randomUUID } from "node:crypto";
import {
  claimUpdateFailureReportArtifactSweep,
  hasUpdateFailureReportArtifactSweepLease,
  releaseUpdateFailureReportArtifactSweep,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  bindSavedReportArtifact,
  listRetiredUpdateFailureReportArtifacts,
  removeRetiredUpdateFailureReportArtifacts,
} from "./update-failure-report-artifact.js";
import { retryUpdateReportStateWrite } from "./update-failure-report-precreate.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export type UpdateFailureReportSweepHooks = {
  beforeList?: () => Promise<void>;
  listCandidates?: typeof listRetiredUpdateFailureReportArtifacts;
};

export type UpdateFailureReportSweepReceipt = Pick<
  UpdateFailureReportReceipt,
  "artifactSweep" | "previewDigest" | "replacementReady" | "reservationId"
>;

/** Deletes one immutable candidate set while the exact SQLite lease generation remains current. */
export async function cleanRetiredUpdateFailureReportArtifacts(
  prepared: PreparedUpdateFailureReport,
  receipt: UpdateFailureReportSweepReceipt,
  stateEnv: NodeJS.ProcessEnv,
  keepCurrent = true,
  hooks: UpdateFailureReportSweepHooks = {},
): Promise<boolean> {
  const sweepOwnerId = randomUUID();
  const sweepGeneration = randomUUID();
  const claimed = retryUpdateReportStateWrite(() =>
    claimUpdateFailureReportArtifactSweep(
      prepared.attemptId,
      receipt.reservationId,
      sweepOwnerId,
      sweepGeneration,
      stateEnv,
    ),
  );
  if (!claimed) {
    return false;
  }
  const keep =
    !keepCurrent || receipt.replacementReady
      ? undefined
      : bindSavedReportArtifact(prepared, receipt.reservationId, receipt.previewDigest);
  let swept = false;
  try {
    await hooks.beforeList?.();
    if (
      !hasUpdateFailureReportArtifactSweepLease(
        prepared.attemptId,
        receipt.reservationId,
        sweepOwnerId,
        sweepGeneration,
        stateEnv,
      )
    ) {
      return false;
    }
    const candidates = await (hooks.listCandidates ?? listRetiredUpdateFailureReportArtifacts)(
      prepared,
      keep,
    );
    if (
      !hasUpdateFailureReportArtifactSweepLease(
        prepared.attemptId,
        receipt.reservationId,
        sweepOwnerId,
        sweepGeneration,
        stateEnv,
      )
    ) {
      return false;
    }
    await removeRetiredUpdateFailureReportArtifacts(candidates);
    swept = true;
  } finally {
    const released = retryUpdateReportStateWrite(() =>
      releaseUpdateFailureReportArtifactSweep(
        prepared.attemptId,
        receipt.reservationId,
        sweepOwnerId,
        sweepGeneration,
        stateEnv,
      ),
    );
    swept &&= released;
  }
  return swept;
}

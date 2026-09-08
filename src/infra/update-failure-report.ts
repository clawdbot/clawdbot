/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import {
  submitGithubIssue,
  type GithubIssueSubmitHooks,
  type GithubIssueSubmitResult,
  type GithubIssueReconcileHooks,
  type GithubIssueReconcileResult,
  reconcileGithubIssue,
  type PreparedGithubIssue,
} from "./github-issue.js";
import {
  beginStaleUpdateFailureReportReceiptCleanup,
  beginUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPrepared,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  refreshUpdateFailureReportReceiptPreparation,
  reserveUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  cleanRetiredUpdateFailureReportArtifacts,
  type UpdateFailureReportSweepHooks,
  type UpdateFailureReportSweepReceipt,
} from "./update-failure-report-artifact-sweep.js";
import {
  bindSavedReportArtifact,
  discardSavedUpdateFailureReport,
  discardSavedUpdateFailureReportBestEffort,
  publishPreparedUpdateFailureReport,
  savePreparedUpdateFailureReport,
  type SavedUpdateFailureReport,
} from "./update-failure-report-artifact.js";
import {
  assertUpdateReportPreCreateState,
  retryUpdateReportStateWrite,
  retryUpdateReportStateWriteAfterNoStart,
  UpdateReportPreCreateGuardError,
} from "./update-failure-report-precreate.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
export type {
  PreparedUpdateFailureReport,
  UpdateFailureReportInput,
} from "./update-failure-report-prepare.js";

export type UpdateFailureReportSubmitResult =
  | { message?: string; savedReportPath: string; status: "created"; url: string }
  | {
      fallbackUrl: string;
      message: string;
      savedReportPath: string;
      status: "fallback";
    }
  | {
      fallbackUrl?: string;
      message: string;
      savedReportPath: string;
      status: "duplicate";
      url?: string;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "pending";
      url?: undefined;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "retryable";
      url?: undefined;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "stale";
      url?: undefined;
    };

function resultFromExistingReceipt(
  receipt: UpdateFailureReportReceipt | null,
  savedReportPath: string,
  expectedPreviewDigest: string,
  expectedFallbackUrl: string | undefined,
): UpdateFailureReportSubmitResult {
  if (receipt?.status === "pending") {
    return {
      message: "This update attempt already has a report submission in progress.",
      savedReportPath,
      status: "pending",
    };
  }
  if (receipt?.status === "preparing") {
    return {
      message: "This update attempt already has a report preparation in progress.",
      savedReportPath,
      status: "retryable",
    };
  }
  if (receipt?.status === "prepared") {
    return {
      message: "This update attempt already has a report publication in progress.",
      savedReportPath,
      status: "retryable",
    };
  }
  if (receipt?.status === "retryable") {
    return {
      message: "No GitHub issue submission was started. This report can be retried.",
      savedReportPath,
      status: "retryable",
    };
  }
  const previewMatches = receipt?.previewDigest === expectedPreviewDigest;
  const matchingFallbackUrl =
    previewMatches && receipt?.status === "fallback" && receipt.fallbackUrl === expectedFallbackUrl
      ? receipt.fallbackUrl
      : undefined;
  return {
    status: "duplicate",
    savedReportPath,
    ...(previewMatches && receipt?.url ? { url: receipt.url } : {}),
    ...(matchingFallbackUrl ? { fallbackUrl: matchingFallbackUrl } : {}),
    message:
      receipt && !previewMatches
        ? "This update attempt has a report result for a different reviewed preview."
        : receipt?.status === "fallback" && !matchingFallbackUrl
          ? "This update attempt has a report handoff for a different reviewed preview."
          : receipt
            ? "This update attempt was already reported."
            : "This update attempt already has a report reservation.",
  };
}

function receiptMatches(
  receipt: UpdateFailureReportReceipt | null,
  expected: UpdateFailureReportReceipt,
): boolean {
  return (
    receipt?.reservationId === expected.reservationId &&
    receipt.status === expected.status &&
    receipt.previewDigest === expected.previewDigest &&
    receipt.cleanup === expected.cleanup &&
    receipt.url === expected.url &&
    receipt.fallbackUrl === expected.fallbackUrl
  );
}

function receiptMatchesBestEffort(
  readReceipt: () => UpdateFailureReportReceipt | null,
  expected: UpdateFailureReportReceipt,
): boolean {
  try {
    return receiptMatches(readReceipt(), expected);
  } catch {
    return false;
  }
}

async function cleanOwnedReportArtifact(
  prepared: PreparedUpdateFailureReport,
  receipt: UpdateFailureReportSweepReceipt,
  stateEnv: NodeJS.ProcessEnv,
  sweepHooks?: UpdateFailureReportSweepHooks,
): Promise<boolean> {
  if (
    receipt.artifactSweep &&
    !(await cleanRetiredUpdateFailureReportArtifacts(
      prepared,
      receipt,
      stateEnv,
      false,
      sweepHooks,
    ))
  ) {
    return false;
  }
  const ownedPrepared = bindSavedReportArtifact(
    prepared,
    receipt.reservationId,
    receipt.previewDigest,
  );
  try {
    await discardSavedUpdateFailureReport(
      ownedPrepared,
      { reportCreated: false, reportDirCreated: false, stagedReportCreated: false },
      true,
    );
  } catch {
    return false;
  }
  return retryUpdateReportStateWrite(() =>
    completeUpdateFailureReportReceiptCleanup(prepared.attemptId, receipt.reservationId, stateEnv),
  );
}

/** Consumes one reviewed preview and invokes the shared GitHub issue creator at most once. */
export async function submitUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  options: {
    createIssue?: (
      issue: PreparedGithubIssue,
      hooks: GithubIssueSubmitHooks,
    ) => GithubIssueSubmitResult | Promise<GithubIssueSubmitResult>;
    env?: NodeJS.ProcessEnv;
    artifactSweepHooks?: UpdateFailureReportSweepHooks;
    finalizeReceipt?: typeof finalizeUpdateFailureReportReceipt;
    hasCurrentAuthority?: () => boolean;
    markPending?: typeof markUpdateFailureReportReceiptPending;
    readReceipt?: typeof readUpdateFailureReportReceipt;
    reconcileIssue?: (
      issue: PreparedGithubIssue,
      hooks: GithubIssueReconcileHooks,
    ) => Promise<GithubIssueReconcileResult>;
    refreshPreparation?: typeof refreshUpdateFailureReportReceiptPreparation;
    stateDir?: string;
    validateCurrentAttempt?: () => boolean | Promise<boolean>;
  } = {},
): Promise<UpdateFailureReportSubmitResult> {
  if (previewDigest !== prepared.previewDigest) {
    throw new Error("The update report preview is stale. Review it again before submitting.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new Error("Update report submission requires a current authenticated client.");
  }
  const finalizeReceipt = options.finalizeReceipt ?? finalizeUpdateFailureReportReceipt;
  const readReceipt = options.readReceipt ?? readUpdateFailureReportReceipt;
  const persistKnownNoStartReceipt = async (
    receipt: UpdateFailureReportReceipt,
  ): Promise<boolean> =>
    await retryUpdateReportStateWriteAfterNoStart(() => {
      try {
        if (finalizeReceipt(prepared.attemptId, receipt, stateEnv)) {
          return true;
        }
      } catch {
        // A lost acknowledgement is resolved by the authoritative read below.
      }
      return receiptMatchesBestEffort(() => readReceipt(prepared.attemptId, stateEnv), receipt);
    });
  let existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  if (existingReceipt?.cleanup === "pending") {
    await cleanOwnedReportArtifact(prepared, existingReceipt, stateEnv, options.artifactSweepHooks);
    existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  }
  if (
    existingReceipt?.status === "pending" &&
    existingReceipt.previewDigest === prepared.previewDigest
  ) {
    const ensureCurrentAuthority = () => {
      if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
        throw new Error("Update report reconciliation requires a current authenticated client.");
      }
    };
    const reconcileIssue =
      options.reconcileIssue ??
      ((issue: PreparedGithubIssue, hooks: GithubIssueReconcileHooks) =>
        reconcileGithubIssue(issue, undefined, hooks));
    let reconciled: GithubIssueReconcileResult;
    try {
      reconciled = await reconcileIssue(prepared, {
        beforeIssueLookup: ensureCurrentAuthority,
      });
      ensureCurrentAuthority();
    } catch {
      reconciled = { status: "unavailable" };
    }
    if (reconciled.status === "created") {
      const receipt: UpdateFailureReportReceipt = {
        cleanup: "pending",
        previewDigest: prepared.previewDigest,
        reservationId: existingReceipt.reservationId,
        status: "created",
        url: reconciled.url,
      };
      const finalized = retryUpdateReportStateWrite(() =>
        finalizeReceipt(prepared.attemptId, receipt, stateEnv),
      );
      const terminalRecorded =
        finalized ||
        receiptMatchesBestEffort(() => readReceipt(prepared.attemptId, stateEnv), receipt);
      if (terminalRecorded) {
        await cleanOwnedReportArtifact(prepared, receipt, stateEnv, options.artifactSweepHooks);
        existingReceipt = receipt;
      }
    }
  }
  if (
    existingReceipt?.artifactSweep &&
    existingReceipt.cleanup === undefined &&
    existingReceipt.status !== "preparing" &&
    existingReceipt.status !== "prepared" &&
    existingReceipt.status !== "retryable"
  ) {
    await cleanRetiredUpdateFailureReportArtifacts(
      prepared,
      existingReceipt,
      stateEnv,
      true,
      options.artifactSweepHooks,
    );
  }
  if (
    existingReceipt &&
    existingReceipt.status !== "preparing" &&
    existingReceipt.status !== "prepared" &&
    existingReceipt.status !== "retryable"
  ) {
    if (existingReceipt.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        bindSavedReportArtifact(
          prepared,
          existingReceipt.reservationId,
          existingReceipt.previewDigest,
        ),
        { reportCreated: false, reportDirCreated: false, stagedReportCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(
      existingReceipt,
      bindSavedReportArtifact(
        prepared,
        existingReceipt.reservationId,
        existingReceipt.previewDigest,
      ).savedReportPath,
      prepared.previewDigest,
      prepared.url,
    );
  }
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    return {
      message: "This failed update attempt is stale or unavailable.",
      savedReportPath: prepared.savedReportPath,
      status: "stale",
    };
  }
  if (existingReceipt?.status === "preparing" || existingReceipt?.status === "prepared") {
    const preparingReceipt = existingReceipt;
    const cleanupRecorded = retryUpdateReportStateWrite(() =>
      beginStaleUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        preparingReceipt.reservationId,
        stateEnv,
      ),
    );
    if (cleanupRecorded) {
      await cleanOwnedReportArtifact(
        prepared,
        preparingReceipt,
        stateEnv,
        options.artifactSweepHooks,
      );
    }
    existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  }
  if (existingReceipt?.status === "retryable" && existingReceipt.replacementReady !== true) {
    const retryableReceipt = existingReceipt;
    const cleanupRecorded = retryUpdateReportStateWrite(() =>
      beginUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        retryableReceipt.reservationId,
        stateEnv,
      ),
    );
    if (cleanupRecorded) {
      await cleanOwnedReportArtifact(
        prepared,
        retryableReceipt,
        stateEnv,
        options.artifactSweepHooks,
      );
    }
  }
  if (existingReceipt?.status === "retryable" && existingReceipt.replacementReady === true) {
    if (
      !(await cleanRetiredUpdateFailureReportArtifacts(
        prepared,
        existingReceipt,
        stateEnv,
        false,
        options.artifactSweepHooks,
      ))
    ) {
      const currentReceipt = readReceipt(prepared.attemptId, stateEnv);
      return resultFromExistingReceipt(
        currentReceipt,
        currentReceipt
          ? bindSavedReportArtifact(
              prepared,
              currentReceipt.reservationId,
              currentReceipt.previewDigest,
            ).savedReportPath
          : prepared.savedReportPath,
        prepared.previewDigest,
        prepared.url,
      );
    }
  }

  const reservationId = randomUUID();
  const reservation = reserveUpdateFailureReportReceipt(
    prepared.attemptId,
    reservationId,
    prepared.previewDigest,
    stateEnv,
  );
  if (!reservation.reserved) {
    if (reservation.receipt?.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        bindSavedReportArtifact(
          prepared,
          reservation.receipt.reservationId,
          reservation.receipt.previewDigest,
        ),
        { reportCreated: false, reportDirCreated: false, stagedReportCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(
      reservation.receipt,
      reservation.receipt
        ? bindSavedReportArtifact(
            prepared,
            reservation.receipt.reservationId,
            reservation.receipt.previewDigest,
          ).savedReportPath
        : prepared.savedReportPath,
      prepared.previewDigest,
      prepared.url,
    );
  }

  const ownedPrepared = bindSavedReportArtifact(prepared, reservationId);
  const saved: SavedUpdateFailureReport = {
    reportCreated: false,
    reportDirCreated: false,
    stagedReportCreated: false,
  };
  const cleanupOwnedPreparation = async (): Promise<boolean> => {
    const cleanupRecorded = retryUpdateReportStateWrite(() =>
      beginUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, stateEnv),
    );
    return cleanupRecorded
      ? await cleanOwnedReportArtifact(
          prepared,
          { previewDigest: prepared.previewDigest, reservationId },
          stateEnv,
          options.artifactSweepHooks,
        )
      : false;
  };
  try {
    await savePreparedUpdateFailureReport(ownedPrepared, saved, options.hasCurrentAuthority);
    if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
      if (!(await cleanupOwnedPreparation())) {
        return resultFromExistingReceipt(
          readReceipt(prepared.attemptId, stateEnv),
          ownedPrepared.savedReportPath,
          prepared.previewDigest,
          prepared.url,
        );
      }
      return {
        message: "This failed update attempt is stale or unavailable.",
        savedReportPath: ownedPrepared.savedReportPath,
        status: "stale",
      };
    }
    if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
      throw new Error("Update report submission requires a current authenticated client.");
    }
    const publicationReserved = retryUpdateReportStateWrite(() =>
      markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        reservationId,
        prepared.previewDigest,
        stateEnv,
      ),
    );
    if (!publicationReserved) {
      await discardSavedUpdateFailureReportBestEffort(ownedPrepared, saved, true);
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        ownedPrepared.savedReportPath,
        prepared.previewDigest,
        prepared.url,
      );
    }
    await publishPreparedUpdateFailureReport(ownedPrepared, saved);
  } catch (error) {
    try {
      await cleanupOwnedPreparation();
    } catch {
      // The original preparation or authority failure remains actionable; a successor keeps custody.
    }
    throw error;
  }

  const assertCurrentPreCreateState = () => assertUpdateReportPreCreateState(options);
  const afterAuthPreflight = assertCurrentPreCreateState;
  const beforeIssueCreate = async () => {
    await assertCurrentPreCreateState();
    // Transport invokes this after its last await, immediately before starting the child.
    return (): undefined => {
      if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
        throw new UpdateReportPreCreateGuardError(
          "Update report submission requires a current authenticated client.",
          "authority",
        );
      }
      const markPending = options.markPending ?? markUpdateFailureReportReceiptPending;
      if (!markPending(prepared.attemptId, reservationId, prepared.previewDigest, stateEnv)) {
        throw new UpdateReportPreCreateGuardError(
          "Update report preparation is no longer owned by this request.",
          "reservation",
        );
      }
    };
  };
  const createIssue =
    options.createIssue ??
    ((issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) =>
      submitGithubIssue(issue, undefined, hooks));
  let created: GithubIssueSubmitResult;
  try {
    created = await createIssue(prepared, {
      afterAuthPreflight,
      beforeIssueCreate,
      beforeIssueLookup: () => {
        if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
          throw new Error("Update report reconciliation requires a current authenticated client.");
        }
      },
    });
  } catch (error) {
    if (!(error instanceof UpdateReportPreCreateGuardError)) {
      throw error;
    }
    if (error.reason === "reservation") {
      await discardSavedUpdateFailureReportBestEffort(ownedPrepared, saved, true);
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        ownedPrepared.savedReportPath,
        prepared.previewDigest,
        prepared.url,
      );
    }
    if (!(await cleanupOwnedPreparation())) {
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        ownedPrepared.savedReportPath,
        prepared.previewDigest,
        prepared.url,
      );
    }
    if (error.reason === "stale") {
      return {
        message: error.message,
        savedReportPath: ownedPrepared.savedReportPath,
        status: "stale",
      };
    }
    throw error;
  }
  if (created.status === "created") {
    const receipt: UpdateFailureReportReceipt = {
      cleanup: "pending",
      previewDigest: prepared.previewDigest,
      reservationId,
      status: "created",
      url: created.url,
    };
    const finalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, receipt, stateEnv),
    );
    const terminalRecorded =
      finalized ||
      receiptMatchesBestEffort(() => readReceipt(prepared.attemptId, stateEnv), receipt);
    if (terminalRecorded) {
      await cleanOwnedReportArtifact(prepared, receipt, stateEnv, options.artifactSweepHooks);
    }
    return {
      ...(!terminalRecorded
        ? {
            message:
              "GitHub issue was created, but its canonical receipt is still pending. Do not submit this report again.",
          }
        : {}),
      savedReportPath: ownedPrepared.savedReportPath,
      status: "created",
      url: created.url,
    };
  }
  if (created.status === "outcome-unknown") {
    return {
      message:
        "GitHub issue submission may have completed, but confirmation was unavailable. Do not submit this report again.",
      savedReportPath: ownedPrepared.savedReportPath,
      status: "pending",
    };
  }
  if (created.status === "fallback-unavailable") {
    const receipt: UpdateFailureReportReceipt = {
      previewDigest: prepared.previewDigest,
      reservationId,
      status: "retryable",
    };
    if (!(await persistKnownNoStartReceipt(receipt))) {
      return {
        message:
          "GitHub issue creation did not start, but retry state could not be saved. Do not retry this report yet.",
        savedReportPath: ownedPrepared.savedReportPath,
        status: "pending",
      };
    }
    return {
      message: "The sanitized report was saved, but it is too large for a browser handoff.",
      savedReportPath: ownedPrepared.savedReportPath,
      status: "retryable",
    };
  }
  const message =
    created.reason === "authentication-unavailable"
      ? "GitHub authentication is unavailable. Review and submit the prefilled issue in your browser."
      : "GitHub submission is unavailable. Review and submit the prefilled issue in your browser.";
  const preparationRefreshed = retryUpdateReportStateWrite(() =>
    (options.refreshPreparation ?? refreshUpdateFailureReportReceiptPreparation)(
      prepared.attemptId,
      reservationId,
      stateEnv,
    ),
  );
  if (!preparationRefreshed) {
    let replacement: UpdateFailureReportReceipt | null = null;
    try {
      replacement = readReceipt(prepared.attemptId, stateEnv);
    } catch {
      // Without an authoritative owner, a browser link must not be published or persisted.
    }
    return resultFromExistingReceipt(
      replacement,
      replacement
        ? bindSavedReportArtifact(prepared, replacement.reservationId, replacement.previewDigest)
            .savedReportPath
        : ownedPrepared.savedReportPath,
      prepared.previewDigest,
      prepared.url,
    );
  }
  const receipt: UpdateFailureReportReceipt = {
    fallbackUrl: created.url,
    previewDigest: prepared.previewDigest,
    reservationId,
    status: "fallback",
  };
  if (!(await persistKnownNoStartReceipt(receipt))) {
    return {
      message:
        "The browser report handoff could not be saved safely. No issue submission was started; retry this action later.",
      savedReportPath: ownedPrepared.savedReportPath,
      status: "retryable",
    };
  }
  return {
    fallbackUrl: created.url,
    message,
    savedReportPath: ownedPrepared.savedReportPath,
    status: "fallback",
  };
}

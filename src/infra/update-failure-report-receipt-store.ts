import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  buildRestartSentinelRow,
  nextRevision,
  readRestartSentinelRowForKeySync,
  type RestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";

export type UpdateFailureReportReceipt = {
  artifactSweep?: "pending";
  cleanup?: "pending";
  fallbackUrl?: string;
  preparingSinceMs?: number;
  previewDigest?: string;
  replacementReady?: true;
  reservationId: string;
  status: "preparing" | "prepared" | "pending" | "retryable" | "created" | "fallback";
  sweepGeneration?: string;
  sweepOwnerId?: string;
  sweepSinceMs?: number;
  url?: string;
};

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;

const RECEIPT_KEY_PREFIX = "update-failure-report:";
const PREPARING_RECEIPT_STALE_AFTER_MS = 2 * 60_000;
const ARTIFACT_SWEEP_STALE_AFTER_MS = 2 * 60_000;

function isCanonicalGithubUrl(
  value: unknown,
  pathname: RegExp,
  options: { allowSearch: boolean },
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.origin === "https://github.com" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (options.allowSearch || !parsed.search) &&
      pathname.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isPreviewDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function retainedArtifactSweep(
  receipt: UpdateFailureReportReceipt,
): Pick<UpdateFailureReportReceipt, "artifactSweep"> {
  return receipt.artifactSweep ? { artifactSweep: receipt.artifactSweep } : {};
}

function isValidTerminalReceipt(receipt: UpdateFailureReportReceipt): boolean {
  if (!isPreviewDigest(receipt.previewDigest) || receipt.preparingSinceMs !== undefined) {
    return false;
  }
  if (receipt.status === "created") {
    return (
      receipt.cleanup === "pending" &&
      receipt.fallbackUrl === undefined &&
      isCanonicalGithubUrl(receipt.url, /^\/openclaw\/openclaw\/issues\/\d+$/u, {
        allowSearch: false,
      })
    );
  }
  if (receipt.status === "fallback") {
    return (
      receipt.cleanup === undefined &&
      receipt.url === undefined &&
      isCanonicalGithubUrl(receipt.fallbackUrl, /^\/openclaw\/openclaw\/issues\/new$/u, {
        allowSearch: true,
      })
    );
  }
  return (
    receipt.status === "retryable" &&
    receipt.cleanup === undefined &&
    receipt.url === undefined &&
    receipt.fallbackUrl === undefined
  );
}

function receiptKey(attemptId: string): string {
  return `${RECEIPT_KEY_PREFIX}${createHash("sha256").update(attemptId).digest("hex")}`;
}

function parseReceipt(sentinel: RestartSentinel | null): UpdateFailureReportReceipt | null {
  if (
    sentinel?.payload.kind !== "update" ||
    sentinel.payload.status !== "skipped" ||
    sentinel.payload.stats?.reason !== "update-failure-report-receipt" ||
    typeof sentinel.payload.message !== "string"
  ) {
    return null;
  }
  const value = safeParseJson(sentinel.payload.message);
  if (
    !isPlainRecord(value) ||
    (value.status !== "preparing" &&
      value.status !== "prepared" &&
      value.status !== "pending" &&
      value.status !== "retryable" &&
      value.status !== "created" &&
      value.status !== "fallback") ||
    typeof value.reservationId !== "string" ||
    ((value.status === "preparing" || value.status === "prepared") &&
      (typeof value.preparingSinceMs !== "number" || !Number.isFinite(value.preparingSinceMs))) ||
    (value.artifactSweep !== undefined && value.artifactSweep !== "pending") ||
    (value.cleanup !== undefined && value.cleanup !== "pending") ||
    (value.previewDigest !== undefined && !isPreviewDigest(value.previewDigest)) ||
    (value.replacementReady !== undefined && value.replacementReady !== true) ||
    (value.replacementReady === true &&
      (value.status !== "retryable" ||
        value.cleanup !== undefined ||
        value.artifactSweep !== "pending")) ||
    (value.sweepOwnerId === undefined) !== (value.sweepSinceMs === undefined) ||
    (value.sweepOwnerId === undefined) !== (value.sweepGeneration === undefined) ||
    (value.sweepGeneration !== undefined && typeof value.sweepGeneration !== "string") ||
    (value.sweepOwnerId !== undefined && typeof value.sweepOwnerId !== "string") ||
    (value.sweepSinceMs !== undefined &&
      (typeof value.sweepSinceMs !== "number" || !Number.isFinite(value.sweepSinceMs))) ||
    (value.sweepOwnerId !== undefined && value.artifactSweep !== "pending") ||
    (value.status === "created" &&
      !isCanonicalGithubUrl(value.url, /^\/openclaw\/openclaw\/issues\/\d+$/u, {
        allowSearch: false,
      })) ||
    (value.status === "fallback" &&
      !isCanonicalGithubUrl(value.fallbackUrl, /^\/openclaw\/openclaw\/issues\/new$/u, {
        allowSearch: true,
      })) ||
    (value.cleanup !== undefined && value.status !== "created" && value.status !== "retryable") ||
    (value.status !== "created" && value.url !== undefined) ||
    (value.status !== "fallback" && value.fallbackUrl !== undefined)
  ) {
    return null;
  }
  return {
    ...(value.artifactSweep === "pending" ? { artifactSweep: value.artifactSweep } : {}),
    reservationId: value.reservationId,
    status: value.status,
    ...(value.cleanup === "pending" ? { cleanup: value.cleanup } : {}),
    ...(typeof value.preparingSinceMs === "number"
      ? { preparingSinceMs: value.preparingSinceMs }
      : {}),
    ...(typeof value.previewDigest === "string" ? { previewDigest: value.previewDigest } : {}),
    ...(value.replacementReady === true ? { replacementReady: value.replacementReady } : {}),
    ...(typeof value.sweepGeneration === "string"
      ? { sweepGeneration: value.sweepGeneration }
      : {}),
    ...(typeof value.sweepOwnerId === "string" ? { sweepOwnerId: value.sweepOwnerId } : {}),
    ...(typeof value.sweepSinceMs === "number" ? { sweepSinceMs: value.sweepSinceMs } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.fallbackUrl === "string" ? { fallbackUrl: value.fallbackUrl } : {}),
  };
}

function readReceipt(db: DatabaseSync, attemptId: string): UpdateFailureReportReceipt | null {
  const current = readRestartSentinelRowForKeySync(db, receiptKey(attemptId));
  return parseReceipt(current.kind === "valid" ? current.sentinel : null);
}

/** Reads one existing report receipt without creating state. */
export function readUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
): UpdateFailureReportReceipt | null {
  return readReceipt(db, attemptId);
}

function buildReceiptPayload(receipt: UpdateFailureReportReceipt): RestartSentinelPayload {
  return {
    kind: "update",
    status: "skipped",
    ts: Date.now(),
    message: JSON.stringify(receipt),
    stats: { reason: "update-failure-report-receipt" },
  };
}

/** Atomically owns one report attempt in the canonical state database. */
export function reserveUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
  previewDigest: string,
): { receipt: UpdateFailureReportReceipt | null; reserved: boolean } {
  const sentinelKey = receiptKey(attemptId);
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const nowMs = Date.now();
  const receipt: UpdateFailureReportReceipt = {
    preparingSinceMs: nowMs,
    previewDigest,
    reservationId,
    status: "preparing",
  };
  const row = buildRestartSentinelRow(buildReceiptPayload(receipt), nowMs, sentinelKey);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("gateway_restart_sentinel")
      .values(row)
      .onConflict((conflict) => conflict.column("sentinel_key").doNothing()),
  );
  if (result.numAffectedRows === 1n) {
    return { receipt, reserved: true };
  }
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind === "valid" &&
    currentReceipt?.status === "retryable" &&
    currentReceipt.cleanup === undefined &&
    currentReceipt.replacementReady === true &&
    currentReceipt.sweepOwnerId === undefined
  ) {
    const replacement: UpdateFailureReportReceipt = {
      preparingSinceMs: nowMs,
      previewDigest,
      ...retainedArtifactSweep(currentReceipt),
      reservationId,
      status: "preparing",
    };
    const replacementRow = buildRestartSentinelRow(
      buildReceiptPayload(replacement),
      nextRevision(current.sentinel.revision),
      sentinelKey,
    );
    const replaced = executeSqliteQuerySync(
      db,
      stateDb
        .updateTable("gateway_restart_sentinel")
        .set(replacementRow)
        .where("sentinel_key", "=", sentinelKey)
        .where("updated_at_ms", "=", current.sentinel.revision),
    );
    return replaced.numAffectedRows === 1n
      ? { receipt: replacement, reserved: true }
      : { receipt: readReceipt(db, attemptId), reserved: false };
  }
  return { receipt: currentReceipt, reserved: false };
}

/** CAS-refreshes one owned, definitely-unstarted phase before fallback publication. */
export function refreshUpdateFailureReportReceiptPreparationRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    (currentReceipt.status !== "prepared" && currentReceipt.status !== "pending") ||
    currentReceipt.sweepOwnerId !== undefined ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  const refreshed: UpdateFailureReportReceipt = {
    ...(currentReceipt.previewDigest ? { previewDigest: currentReceipt.previewDigest } : {}),
    ...retainedArtifactSweep(currentReceipt),
    reservationId,
    status: currentReceipt.status,
    ...(currentReceipt.status === "prepared" ? { preparingSinceMs: Date.now() } : {}),
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(refreshed),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Fences final artifact publication behind one process-owned preparation. */
export function markUpdateFailureReportReceiptPreparedRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
  previewDigest: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== "preparing" ||
    currentReceipt.sweepOwnerId !== undefined ||
    currentReceipt.reservationId !== reservationId ||
    currentReceipt.previewDigest !== previewDigest
  ) {
    return false;
  }
  const prepared: UpdateFailureReportReceipt = {
    preparingSinceMs: Date.now(),
    previewDigest,
    ...retainedArtifactSweep(currentReceipt),
    reservationId,
    status: "prepared",
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(prepared),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Makes one published preparation ambiguity-safe immediately before issue creation starts. */
export function markUpdateFailureReportReceiptPendingRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
  previewDigest: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.status !== "prepared" ||
    currentReceipt.sweepOwnerId !== undefined ||
    currentReceipt.reservationId !== reservationId ||
    currentReceipt.previewDigest !== previewDigest
  ) {
    return false;
  }
  const pending: UpdateFailureReportReceipt = {
    ...(currentReceipt.previewDigest ? { previewDigest: currentReceipt.previewDigest } : {}),
    ...retainedArtifactSweep(currentReceipt),
    reservationId,
    status: "pending",
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(pending),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Finalizes only a process-owned reservation in the required prior phase. */
export function finalizeUpdateFailureReportReceiptRowSync(
  db: DatabaseSync,
  attemptId: string,
  receipt: UpdateFailureReportReceipt,
): boolean {
  if (!isValidTerminalReceipt(receipt)) {
    return false;
  }
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.sweepOwnerId !== undefined ||
    // Auth can refuse creation while still prepared. Only created requires a pending transport.
    (receipt.status === "fallback" || receipt.status === "retryable"
      ? currentReceipt.status !== "prepared" && currentReceipt.status !== "pending"
      : currentReceipt.status !== "pending") ||
    currentReceipt.reservationId !== receipt.reservationId ||
    currentReceipt.previewDigest === undefined ||
    currentReceipt.previewDigest !== receipt.previewDigest
  ) {
    return false;
  }
  const terminalReceipt: UpdateFailureReportReceipt = {
    ...receipt,
    ...retainedArtifactSweep(currentReceipt),
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(terminalReceipt),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Records post-commit cleanup intent without performing filesystem work in SQLite. */
export function beginUpdateFailureReportReceiptCleanupRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.sweepOwnerId !== undefined ||
    (currentReceipt.status !== "preparing" &&
      currentReceipt.status !== "prepared" &&
      currentReceipt.status !== "retryable") ||
    currentReceipt.cleanup !== undefined ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  const cleanupReceipt: UpdateFailureReportReceipt = {
    cleanup: "pending",
    ...(currentReceipt.previewDigest ? { previewDigest: currentReceipt.previewDigest } : {}),
    ...retainedArtifactSweep(currentReceipt),
    reservationId,
    status: "retryable",
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(cleanupReceipt),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Atomically transfers an expired preparation into durable cleanup custody. */
export function beginStaleUpdateFailureReportReceiptCleanupRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  const nowMs = Date.now();
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.sweepOwnerId !== undefined ||
    (currentReceipt.status !== "preparing" && currentReceipt.status !== "prepared") ||
    currentReceipt.preparingSinceMs === undefined ||
    currentReceipt.preparingSinceMs > nowMs - PREPARING_RECEIPT_STALE_AFTER_MS ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  if (!currentReceipt.previewDigest) {
    return false;
  }
  const cleanupReceipt: UpdateFailureReportReceipt = {
    artifactSweep: "pending",
    cleanup: "pending",
    previewDigest: currentReceipt.previewDigest,
    reservationId,
    status: "retryable",
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(cleanupReceipt),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Serializes one attempt-wide retired-artifact sweep against successor publication. */
export function claimUpdateFailureReportArtifactSweepRowSync(
  db: DatabaseSync,
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  const nowMs = Date.now();
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.artifactSweep !== "pending" ||
    currentReceipt.reservationId !== expectedReservationId ||
    (currentReceipt.sweepOwnerId !== undefined &&
      currentReceipt.sweepSinceMs !== undefined &&
      currentReceipt.sweepSinceMs > nowMs - ARTIFACT_SWEEP_STALE_AFTER_MS)
  ) {
    return false;
  }
  const claimed: UpdateFailureReportReceipt = {
    ...currentReceipt,
    sweepGeneration,
    sweepOwnerId,
    sweepSinceMs: nowMs,
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(claimed),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Checks the exact sweep generation without renewing or otherwise mutating it. */
export function hasUpdateFailureReportArtifactSweepLeaseRowSync(
  db: DatabaseSync,
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
): boolean {
  const currentReceipt = readReceipt(db, attemptId);
  return (
    currentReceipt?.artifactSweep === "pending" &&
    currentReceipt.reservationId === expectedReservationId &&
    currentReceipt.sweepOwnerId === sweepOwnerId &&
    currentReceipt.sweepGeneration === sweepGeneration
  );
}

/** Releases only the exact attempt-wide artifact sweep lease held by this worker. */
export function releaseUpdateFailureReportArtifactSweepRowSync(
  db: DatabaseSync,
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.reservationId !== expectedReservationId ||
    currentReceipt.sweepOwnerId !== sweepOwnerId ||
    currentReceipt.sweepGeneration !== sweepGeneration
  ) {
    return false;
  }
  const {
    sweepGeneration: _generation,
    sweepOwnerId: _owner,
    sweepSinceMs: _since,
    ...released
  } = currentReceipt;
  const row = buildRestartSentinelRow(
    buildReceiptPayload(released),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

/** Completes one idempotent artifact cleanup after the cleanup intent has committed. */
export function completeUpdateFailureReportReceiptCleanupRowSync(
  db: DatabaseSync,
  attemptId: string,
  reservationId: string,
): boolean {
  const sentinelKey = receiptKey(attemptId);
  const current = readRestartSentinelRowForKeySync(db, sentinelKey);
  const currentReceipt = parseReceipt(current.kind === "valid" ? current.sentinel : null);
  if (
    current.kind !== "valid" ||
    !currentReceipt ||
    currentReceipt.cleanup !== "pending" ||
    currentReceipt.sweepOwnerId !== undefined ||
    currentReceipt.reservationId !== reservationId
  ) {
    return false;
  }
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  if (currentReceipt.status === "retryable") {
    if (currentReceipt.artifactSweep) {
      const completed: UpdateFailureReportReceipt = {
        artifactSweep: currentReceipt.artifactSweep,
        ...(currentReceipt.previewDigest ? { previewDigest: currentReceipt.previewDigest } : {}),
        replacementReady: true,
        reservationId,
        status: "retryable",
      };
      const completedRow = buildRestartSentinelRow(
        buildReceiptPayload(completed),
        nextRevision(current.sentinel.revision),
        sentinelKey,
      );
      const result = executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("gateway_restart_sentinel")
          .set(completedRow)
          .where("sentinel_key", "=", sentinelKey)
          .where("updated_at_ms", "=", current.sentinel.revision),
      );
      return result.numAffectedRows === 1n;
    }
    const result = executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("gateway_restart_sentinel")
        .where("sentinel_key", "=", sentinelKey)
        .where("updated_at_ms", "=", current.sentinel.revision),
    );
    return result.numAffectedRows === 1n;
  }
  if (currentReceipt.status !== "created" || !currentReceipt.url) {
    return false;
  }
  const completed: UpdateFailureReportReceipt = {
    ...(currentReceipt.previewDigest ? { previewDigest: currentReceipt.previewDigest } : {}),
    ...retainedArtifactSweep(currentReceipt),
    reservationId,
    status: "created",
    ...(currentReceipt.url ? { url: currentReceipt.url } : {}),
  };
  const row = buildRestartSentinelRow(
    buildReceiptPayload(completed),
    nextRevision(current.sentinel.revision),
    sentinelKey,
  );
  const result = executeSqliteQuerySync(
    db,
    stateDb
      .updateTable("gateway_restart_sentinel")
      .set(row)
      .where("sentinel_key", "=", sentinelKey)
      .where("updated_at_ms", "=", current.sentinel.revision),
  );
  return result.numAffectedRows === 1n;
}

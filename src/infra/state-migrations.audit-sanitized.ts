import { createHash } from "node:crypto";
import type { LegacyAuditRawCheckpoint } from "./state-migrations.audit-checkpoints.js";
import {
  readLegacyAuditSourceSnapshot,
  type AuditMigrationRoot,
} from "./state-migrations.audit-recovery.js";

export async function writeRecoveredSanitizedAuditArchive(params: {
  sourceLabel: string;
  root: AuditMigrationRoot;
  relativePath: string;
  allRecordsJsonl: string;
  candidateRecordsJsonl: string;
  previousCheckpoint: LegacyAuditRawCheckpoint | undefined;
  warnings: string[];
}): Promise<boolean> {
  const current = (await params.root.exists(params.relativePath))
    ? await readLegacyAuditSourceSnapshot(params.root, params.relativePath)
    : undefined;
  let desired: Buffer;
  if (params.previousCheckpoint) {
    if (!current || current.rawBytes.length < params.previousCheckpoint.sanitizedSize) {
      params.warnings.push(
        `Skipped ${params.sourceLabel} recovery because its sanitized archive is missing or truncated`,
      );
      return false;
    }
    const checkpointedPrefix = current.rawBytes.subarray(
      0,
      params.previousCheckpoint.sanitizedSize,
    );
    if (
      createHash("sha256").update(checkpointedPrefix).digest("hex") !==
      params.previousCheckpoint.sanitizedContentHash
    ) {
      params.warnings.push(
        `Skipped ${params.sourceLabel} recovery because its sanitized archive changed after checkpoint`,
      );
      return false;
    }
    // The caller already removed checkpointed raw records. For merge-intent,
    // this sanitized prefix also contains that previously materialized batch.
    desired = Buffer.concat([
      checkpointedPrefix,
      Buffer.from(params.candidateRecordsJsonl, "utf8"),
    ]);
    if (current.rawBytes.equals(desired)) {
      return true;
    }
    const currentIsVerifiedDesiredPrefix = desired
      .subarray(0, current.rawBytes.length)
      .equals(current.rawBytes);
    if (
      current.rawBytes.length !== params.previousCheckpoint.sanitizedSize &&
      !currentIsVerifiedDesiredPrefix
    ) {
      params.warnings.push(
        `Skipped ${params.sourceLabel} recovery because its sanitized archive has an uncheckpointed tail`,
      );
      return false;
    }
  } else {
    // A checkpointless unscrubbed raw archive is authoritative. Replacing from
    // the complete sanitized projection is idempotent before checkpoint commit.
    desired = Buffer.from(params.allRecordsJsonl, "utf8");
    if (current?.rawBytes.equals(desired)) {
      return true;
    }
  }
  await params.root.write(params.relativePath, desired, { mkdir: false, mode: 0o600 });
  return true;
}

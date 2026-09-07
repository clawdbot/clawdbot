/** Filesystem lifecycle for a non-authoritative, sanitized update report body. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export type SavedUpdateFailureReport = {
  reportCreated: boolean;
  reportDirCreated: boolean;
  stagedReportCreated: boolean;
};

export function bindSavedReportArtifact(
  prepared: PreparedUpdateFailureReport,
  reservationId: string,
  previewDigest = prepared.previewDigest,
): PreparedUpdateFailureReport {
  const parsed = path.parse(prepared.savedReportPath);
  const artifactKey = createHash("sha256")
    .update(`${reservationId}\0${previewDigest}`)
    .digest("hex");
  return {
    ...prepared,
    savedReportPath: path.join(parsed.dir, `${parsed.name}.${artifactKey}${parsed.ext}`),
  };
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function stagedReportPath(prepared: PreparedUpdateFailureReport): string {
  return `${prepared.savedReportPath}.pending`;
}

function isAttemptArtifactName(base: path.ParsedPath, entry: string): boolean {
  if (!entry.startsWith(`${base.name}.`)) {
    return false;
  }
  const withoutStageSuffix = entry.endsWith(".pending") ? entry.slice(0, -8) : entry;
  if (!withoutStageSuffix.endsWith(base.ext)) {
    return false;
  }
  const artifactKey = withoutStageSuffix.slice(
    base.name.length + 1,
    withoutStageSuffix.length - base.ext.length,
  );
  return /^[a-f0-9]{64}$/u.test(artifactKey);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function discardSavedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  // Remove the rename source first. After receipt ownership is revoked, this
  // ordering prevents a paused publisher from moving staged content back into
  // the final report path between cleanup operations.
  if (saved.stagedReportCreated || removeExistingReport) {
    await fs.rm(stagedReportPath(prepared), { force: true });
  }
  if (saved.reportCreated || removeExistingReport) {
    await fs.rm(prepared.savedReportPath, { force: true });
  }
  if (saved.reportDirCreated || removeExistingReport) {
    await fs.rmdir(path.dirname(prepared.savedReportPath)).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT", "ENOTEMPTY")) {
        throw error;
      }
    });
  }
}

export async function discardSavedUpdateFailureReportBestEffort(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  await discardSavedUpdateFailureReport(prepared, saved, removeExistingReport).catch(() => {});
}

/** Captures the immutable retired-artifact set for one fenced sweep generation. */
export async function listRetiredUpdateFailureReportArtifacts(
  prepared: PreparedUpdateFailureReport,
  keep?: PreparedUpdateFailureReport,
): Promise<string[]> {
  const base = path.parse(prepared.savedReportPath);
  const keepPaths = new Set(keep ? [keep.savedReportPath, stagedReportPath(keep)] : []);
  const entries = await fs.readdir(base.dir).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => isAttemptArtifactName(base, entry))
    .map((entry) => path.join(base.dir, entry))
    .filter((artifactPath) => !keepPaths.has(artifactPath));
}

/** Deletes only a previously captured set; this function never performs a fresh scan. */
export async function removeRetiredUpdateFailureReportArtifacts(
  artifactPaths: readonly string[],
): Promise<void> {
  for (const artifactPath of artifactPaths) {
    await fs.rm(artifactPath, { force: true }).catch(() => {});
  }
}

/** Writes reviewed content to a non-public staging name under live client authority. */
export async function savePreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  hasCurrentAuthority?: () => boolean,
): Promise<void> {
  const ensureCurrentAuthority = () => {
    if (hasCurrentAuthority && !hasCurrentAuthority()) {
      throw new Error("Update report persistence requires a current authenticated client.");
    }
  };
  const reportDir = path.dirname(prepared.savedReportPath);
  ensureCurrentAuthority();
  const reportDirExisted = await pathExists(reportDir);
  ensureCurrentAuthority();
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  saved.reportDirCreated = !reportDirExisted;
  ensureCurrentAuthority();
  try {
    await fs.writeFile(stagedReportPath(prepared), prepared.body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    saved.stagedReportCreated = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await fs
      .readFile(stagedReportPath(prepared), "utf8")
      .catch((readError: unknown) => {
        if (hasErrorCode(readError, "ENOENT")) {
          return undefined;
        }
        throw readError;
      });
    if (existing !== undefined && existing !== prepared.body) {
      throw new Error("The saved update report does not match the reviewed preview.", {
        cause: error,
      });
    }
  }
  ensureCurrentAuthority();
  if (saved.stagedReportCreated) {
    await fs.chmod(stagedReportPath(prepared), 0o600);
  }
  ensureCurrentAuthority();
}

/** Publishes staged content only after the caller acquired the durable receipt phase. */
export async function publishPreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
): Promise<void> {
  await fs.rename(stagedReportPath(prepared), prepared.savedReportPath);
  saved.stagedReportCreated = false;
  saved.reportCreated = true;
  await fs.chmod(prepared.savedReportPath, 0o600);
}

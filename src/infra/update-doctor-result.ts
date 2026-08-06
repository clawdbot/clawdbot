import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

// IPC contract between package update parents and the post-install doctor child.
export const UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV =
  "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH";
export const UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE = 86;
const UPDATE_POST_INSTALL_DOCTOR_RESULT_FILENAME_RE =
  /^openclaw-update-doctor-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu;

export type PackageUpdateStepAdvisory = {
  kind: "package-post-install-doctor";
  message: string;
};

export const PACKAGE_POST_INSTALL_DOCTOR_ADVISORY: PackageUpdateStepAdvisory = {
  kind: "package-post-install-doctor",
  message:
    "Post-install doctor reported a recoverable update-time repair warning after the package install was verified; continuing with post-core plugin convergence.",
};

export type UpdatePostInstallDoctorResult = {
  status: "advisory";
  advisory: PackageUpdateStepAdvisory & {
    reason: "deferred-configured-plugin-repair";
    details: string[];
  };
};

export function createUpdatePostInstallDoctorResultPath(): string {
  return path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-update-doctor-${process.pid}-${randomUUID()}.json`,
  );
}

function resolveSafeUpdatePostInstallDoctorResultPath(resultPath: string): string {
  const tempRoot = path.resolve(resolvePreferredOpenClawTmpDir());
  const resolvedPath = path.resolve(resultPath);
  if (
    path.dirname(resolvedPath) !== tempRoot ||
    !UPDATE_POST_INSTALL_DOCTOR_RESULT_FILENAME_RE.test(path.basename(resolvedPath))
  ) {
    throw new Error("Unsafe post-install doctor result path");
  }
  return resolvedPath;
}

export function createDeferredConfiguredPluginRepairDoctorResult(
  details: readonly string[],
): UpdatePostInstallDoctorResult {
  return {
    status: "advisory",
    advisory: {
      ...PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
      reason: "deferred-configured-plugin-repair",
      details: details.filter((line) => line.trim()),
    },
  };
}

export async function writeUpdatePostInstallDoctorResult(params: {
  resultPath: string;
  result: UpdatePostInstallDoctorResult;
}): Promise<void> {
  const resultPath = resolveSafeUpdatePostInstallDoctorResultPath(params.resultPath);
  // Advisory details can contain config-derived IDs; pre-existing paths must fail closed.
  await fs.writeFile(resultPath, `${JSON.stringify(params.result)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function consumeUpdatePostInstallDoctorResult(
  resultPath: string,
): Promise<UpdatePostInstallDoctorResult | null> {
  let safeResultPath: string;
  try {
    safeResultPath = resolveSafeUpdatePostInstallDoctorResultPath(resultPath);
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(safeResultPath, "utf8");
    return parseUpdatePostInstallDoctorResult(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    await fs.rm(safeResultPath, { force: true }).catch(() => {});
  }
}

function parseUpdatePostInstallDoctorResult(value: unknown): UpdatePostInstallDoctorResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.status !== "advisory") {
    return null;
  }
  const advisory = record.advisory;
  if (!advisory || typeof advisory !== "object") {
    return null;
  }
  const advisoryRecord = advisory as Record<string, unknown>;
  const details = advisoryRecord.details;
  if (
    advisoryRecord.kind !== "package-post-install-doctor" ||
    advisoryRecord.reason !== "deferred-configured-plugin-repair" ||
    typeof advisoryRecord.message !== "string" ||
    !Array.isArray(details) ||
    details.length === 0 ||
    !details.every((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
  ) {
    return null;
  }
  return {
    status: "advisory",
    advisory: {
      kind: "package-post-install-doctor",
      reason: "deferred-configured-plugin-repair",
      message: PACKAGE_POST_INSTALL_DOCTOR_ADVISORY.message,
      details,
    },
  };
}

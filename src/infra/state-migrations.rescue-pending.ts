// Doctor-only cleanup for retired system-agent rescue approval directories.
import fs from "node:fs";
import path from "node:path";
import type { LegacyRescuePendingDetection, MigrationMessages } from "./state-migrations.types.js";

function resolveLegacyRescuePendingPaths(stateDir: string): string[] {
  return ["crestodian", "openclaw"].map((owner) => path.join(stateDir, owner, "rescue-pending"));
}

function isSafeLegacyOwnerDirectory(stateDir: string, sourcePath: string): boolean {
  const ownerPath = path.dirname(sourcePath);
  try {
    const owner = fs.lstatSync(ownerPath);
    return (
      owner.isDirectory() &&
      !owner.isSymbolicLink() &&
      path.resolve(path.dirname(ownerPath)) === path.resolve(stateDir)
    );
  } catch {
    return false;
  }
}

/** Detect retired security capabilities only during an explicit doctor run. */
export function detectLegacyRescuePending(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyRescuePendingDetection {
  const sourcePaths = resolveLegacyRescuePendingPaths(params.stateDir);
  return {
    sourcePaths,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      sourcePaths.some((sourcePath) => fs.existsSync(sourcePath)),
  };
}

/** Discard retired one-shot capabilities; importing them could reactivate stale writes. */
export function discardLegacyRescuePending(params: {
  detected: LegacyRescuePendingDetection;
  stateDir: string;
}): MigrationMessages {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }

  const removed: string[] = [];
  const warnings: string[] = [];
  // Recompute fixed owner paths instead of trusting paths carried through a
  // stale detection result; doctor must never turn detection data into rm authority.
  for (const sourcePath of resolveLegacyRescuePendingPaths(params.stateDir)) {
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    if (!isSafeLegacyOwnerDirectory(params.stateDir, sourcePath)) {
      warnings.push(`Refused to remove retired rescue approvals through unsafe path ${sourcePath}`);
      continue;
    }
    try {
      fs.rmSync(sourcePath, { recursive: true, force: true });
      removed.push(sourcePath);
    } catch (error) {
      warnings.push(`Failed removing retired rescue approvals at ${sourcePath}: ${String(error)}`);
    }
  }

  return {
    changes:
      removed.length > 0
        ? [`Discarded retired system-agent rescue approvals from ${removed.join(", ")}`]
        : [],
    warnings,
  };
}

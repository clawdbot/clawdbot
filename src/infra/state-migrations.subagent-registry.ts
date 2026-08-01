// Doctor-only removal for the retired subagent run registry JSON store.
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  legacyMigrationSourceOrClaimMayExist as sourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as sourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import {
  markLegacySubagentRegistrySourceRemoved,
  recordLegacySubagentRegistryDiscard,
} from "./state-migrations.subagent-registry-db.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_SUBAGENT_REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";

function resolveLegacySubagentRegistryPath(stateDir: string): string {
  return path.join(stateDir, "subagents", "runs.json");
}

/** Detect retired subagent state only when an explicit Doctor flow opts in. */
export function detectLegacySubagentRegistry(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["subagentRegistry"] {
  const sourcePath = resolveLegacySubagentRegistryPath(params.stateDir);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourceOrClaimMayExist(sourcePath),
  };
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "subagent registry");
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<LegacySourceSnapshot> {
  return readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: LEGACY_SUBAGENT_REGISTRY_MAX_BYTES,
    label: "subagent registry",
  });
}

async function recoverInterruptedClaim(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const claimRelativePath = relativeLegacyPath(stateDir, claimPath);
  const sourceRelativePath = relativeLegacyPath(stateDir, sourcePath);
  if (!(await stateRoot.exists(claimRelativePath))) {
    return;
  }
  const claimed = await readLegacySourceSnapshot(stateRoot, stateDir, claimPath);
  if (!(await stateRoot.exists(sourceRelativePath))) {
    await stateRoot.move(claimRelativePath, sourceRelativePath);
    return;
  }
  await readLegacySourceSnapshot(stateRoot, stateDir, sourcePath);
  // The interrupted claim and recreated source are two separate retirements.
  // Record the older bytes before deletion; the recreated source is processed next.
  const result = recordLegacySubagentRegistryDiscard({
    env,
    sourcePath,
    sourceSha256: claimed.sha256,
    sourceSize: claimed.size,
  });
  await stateRoot.remove(claimRelativePath);
  markLegacySubagentRegistrySourceRemoved(result.sourceKey, env);
}

async function restoreClaim(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<string | null> {
  const claimPath = `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  try {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath)))) {
      return null;
    }
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.sourcePath))) {
      return `source path already exists: ${params.sourcePath}`;
    }
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, claimPath),
      relativeLegacyPath(params.stateDir, params.sourcePath),
    );
    return null;
  } catch (error) {
    return String(error);
  }
}

async function migrateWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  detected: LegacyStateDetection["subagentRegistry"];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const sourcePath = params.detected.sourcePath;
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    await recoverInterruptedClaim(params.stateRoot, params.stateDir, sourcePath, params.env);
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath)))) {
      return { changes, warnings };
    }
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
  } catch (error) {
    warnings.push(`Failed reading legacy subagent registry: ${String(error)}`);
    return { changes, warnings };
  }

  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  try {
    params.beforeVerify?.();
    const current = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
    if (!sourceSnapshotsMatch(current, snapshot)) {
      throw new Error("legacy subagent registry changed after Doctor loaded it");
    }
    params.beforeClaim?.();
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, sourcePath),
      relativeLegacyPath(params.stateDir, claimPath),
    );
    const claimed = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
    if (!sourceSnapshotsMatch(claimed, snapshot)) {
      throw new Error("legacy subagent registry changed before Doctor could claim it");
    }
  } catch (error) {
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
    });
    warnings.push(
      `Failed migrating legacy subagent registry: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  let result: ReturnType<typeof recordLegacySubagentRegistryDiscard>;
  try {
    result = recordLegacySubagentRegistryDiscard({
      env: params.env,
      sourcePath: snapshot.sourcePath,
      sourceSha256: snapshot.sha256,
      sourceSize: snapshot.size,
    });
  } catch (error) {
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
    });
    warnings.push(
      `Failed migrating legacy subagent registry: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) {
      throw new Error(`legacy subagent registry reappeared during retirement: ${sourcePath}`);
    }
    if (params.removeSource) {
      await params.removeSource(claimPath);
    } else {
      await params.stateRoot.remove(relativeLegacyPath(params.stateDir, claimPath));
    }
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) {
      throw new Error(`legacy subagent registry reappeared during cleanup: ${sourcePath}`);
    }
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath))) {
      throw new Error(`legacy subagent registry Doctor claim remains after cleanup: ${claimPath}`);
    }
  } catch (error) {
    warnings.push(`Legacy subagent registry retirement cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    markLegacySubagentRegistrySourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    warnings.push(
      `Legacy subagent registry was removed, but its receipt could not be finalized: ${String(error)}`,
    );
  }
  changes.push(
    result.decision === "receipt-authoritative"
      ? "Discarded recreated retired subagent JSON without importing it."
      : "Discarded retired subagent JSON without importing transient run state.",
  );
  notices.push("Removed retired subagents/runs.json after the discard decision was recorded.");
  return { changes, warnings, notices };
}

/** Discard retired transient state while excluding active Gateway owners. */
export async function migrateLegacySubagentRegistry(params: {
  detected: LegacyStateDetection["subagentRegistry"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy subagent registry",
    releaseLabel: "Subagent registry",
    errorLabel: "Failed reading legacy subagent registry",
    retryGuidance: "Stop the Gateway, then run `openclaw doctor --fix` again.",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: LEGACY_SUBAGENT_REGISTRY_MAX_BYTES,
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
    },
  });
}

// Doctor-only removal for the retired subagent run registry JSON store.
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { markLegacyMigrationSourceRemoved } from "./state-migrations.receipts.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist as sourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as sourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import { recordLegacySubagentRegistryDiscard } from "./state-migrations.subagent-registry-db.js";
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

async function recoverInterruptedClaim(params: {
  source: LegacyMigrationSourceClaim;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!(await params.source.exists(true))) {
    return;
  }
  const claimed = await params.source.read(true);
  if (!(await params.source.exists())) {
    const restoreError = await params.source.restore();
    if (restoreError) {
      throw new Error(restoreError);
    }
    return;
  }
  await params.source.read();
  // The interrupted claim and recreated source are two separate retirements.
  // Record the older bytes before deletion; the recreated source is processed next.
  const result = recordLegacySubagentRegistryDiscard({
    env: params.env,
    sourcePath: params.source.sourcePath,
    sourceSha256: claimed.sha256,
    sourceSize: claimed.size,
  });
  await params.source.remove({ skipSourceCheck: true });
  markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
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
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "subagent registry",
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacyMigrationSourceSnapshot({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath: snapshotPath,
        maxBytes: LEGACY_SUBAGENT_REGISTRY_MAX_BYTES,
        label: "subagent registry",
      }),
  });
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    await recoverInterruptedClaim({ source, env: params.env });
    if (!(await source.exists())) {
      return { changes, warnings };
    }
    snapshot = await source.read();
  } catch (error) {
    warnings.push(`Failed reading legacy subagent registry: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    params.beforeVerify?.();
    const current = await source.read();
    if (!sourceSnapshotsMatch(current, snapshot)) {
      throw new Error("legacy subagent registry changed after Doctor loaded it");
    }
    await source.claim({
      snapshot,
      mismatchMessage: "legacy subagent registry changed before Doctor could claim it",
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    const restoreError = await source.restore();
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
    const restoreError = await source.restore();
    warnings.push(
      `Failed migrating legacy subagent registry: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: `legacy subagent registry reappeared during retirement: ${sourcePath}`,
      sourceRemainingMessage: `legacy subagent registry reappeared during cleanup: ${sourcePath}`,
      claimRemainingMessage: `legacy subagent registry Doctor claim remains after cleanup: ${source.claimPath}`,
    });
  } catch (error) {
    warnings.push(`Legacy subagent registry retirement cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
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

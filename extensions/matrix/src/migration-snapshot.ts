import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { detectLegacyMatrixCrypto } from "./legacy-crypto.js";
import { detectLegacyMatrixState } from "./legacy-state.js";
import {
  maybeCreateMatrixMigrationSnapshot,
  resolveMatrixMigrationSnapshotMarkerPath,
  resolveMatrixMigrationSnapshotOutputDir,
} from "./migration-snapshot-backup.js";

export type MatrixMigrationStatus = {
  legacyState: ReturnType<typeof detectLegacyMatrixState>;
  legacyCrypto: ReturnType<typeof detectLegacyMatrixCrypto>;
  pending: boolean;
  actionable: boolean;
};

export function resolveMatrixMigrationStatus(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixMigrationStatus {
  const env = params.env ?? process.env;
  const legacyState = detectLegacyMatrixState({ cfg: params.cfg, env });
  const legacyCrypto = detectLegacyMatrixCrypto({ cfg: params.cfg, env });
  const actionableLegacyState = legacyState !== null && !("warning" in legacyState);
  const actionableLegacyCrypto = legacyCrypto.plans.length > 0 && legacyCrypto.inspectorAvailable;
  return {
    legacyState,
    legacyCrypto,
    pending:
      legacyState !== null || legacyCrypto.plans.length > 0 || legacyCrypto.warnings.length > 0,
    actionable: actionableLegacyState || actionableLegacyCrypto,
  };
}

export function hasPendingMatrixMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveMatrixMigrationStatus(params).pending;
}

export function hasActionableMatrixMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveMatrixMigrationStatus(params).actionable;
}

export {
  maybeCreateMatrixMigrationSnapshot,
  resolveMatrixMigrationSnapshotMarkerPath,
  resolveMatrixMigrationSnapshotOutputDir,
};

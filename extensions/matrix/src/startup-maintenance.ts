import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  autoMigrateLegacyMatrixState,
  autoPrepareLegacyMatrixCrypto,
  maybeCreateMatrixMigrationSnapshot,
  resolveMatrixMigrationStatus,
  type MatrixMigrationStatus,
} from "./matrix-migration.runtime.js";

type MatrixStartupLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

function logWarningOnlyMatrixMigrationReasons(params: {
  status: MatrixMigrationStatus;
  log: MatrixStartupLogger;
}): void {
  if (params.status.legacyState && "warning" in params.status.legacyState) {
    params.log.warn?.(`matrix: ${params.status.legacyState.warning}`);
  }

  if (params.status.legacyCrypto.warnings.length > 0) {
    params.log.warn?.(
      `matrix: legacy encrypted-state warnings:\n${params.status.legacyCrypto.warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
}

async function runBestEffortMatrixMigrationStep(params: {
  label: string;
  log: MatrixStartupLogger;
  logPrefix?: string;
  run: () => Promise<unknown>;
}): Promise<void> {
  try {
    await params.run();
  } catch (err) {
    params.log.warn?.(
      `${params.logPrefix?.trim() || "gateway"}: ${params.label} failed during Matrix migration; continuing startup: ${String(err)}`,
    );
  }
}

export async function runMatrixStartupMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: MatrixStartupLogger;
  trigger?: string;
  logPrefix?: string;
  deps?: {
    maybeCreateMatrixMigrationSnapshot?: typeof maybeCreateMatrixMigrationSnapshot;
    autoMigrateLegacyMatrixState?: typeof autoMigrateLegacyMatrixState;
    autoPrepareLegacyMatrixCrypto?: typeof autoPrepareLegacyMatrixCrypto;
  };
}): Promise<void> {
  const env = params.env ?? process.env;
  const createSnapshot =
    params.deps?.maybeCreateMatrixMigrationSnapshot ?? maybeCreateMatrixMigrationSnapshot;
  const migrateLegacyState =
    params.deps?.autoMigrateLegacyMatrixState ?? autoMigrateLegacyMatrixState;
  const prepareLegacyCrypto =
    params.deps?.autoPrepareLegacyMatrixCrypto ?? autoPrepareLegacyMatrixCrypto;
  const trigger = params.trigger?.trim() || "gateway-startup";
  const logPrefix = params.logPrefix?.trim() || "gateway";
  const migrationStatus = resolveMatrixMigrationStatus({ cfg: params.cfg, env });

  if (!migrationStatus.pending) {
    return;
  }
  if (!migrationStatus.actionable) {
    params.log.info?.(
      "matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet",
    );
    logWarningOnlyMatrixMigrationReasons({ status: migrationStatus, log: params.log });
    return;
  }

  try {
    await createSnapshot({
      trigger,
      env,
      log: params.log,
    });
  } catch (err) {
    params.log.warn?.(
      `${logPrefix}: failed creating a Matrix migration snapshot; skipping Matrix migration for now: ${String(err)}`,
    );
    return;
  }

  await runBestEffortMatrixMigrationStep({
    label: "legacy Matrix state migration",
    log: params.log,
    logPrefix,
    run: () =>
      migrateLegacyState({
        cfg: params.cfg,
        env,
        log: params.log,
      }),
  });
  await runBestEffortMatrixMigrationStep({
    label: "legacy Matrix encrypted-state preparation",
    log: params.log,
    logPrefix,
    run: () =>
      prepareLegacyCrypto({
        cfg: params.cfg,
        env,
        log: params.log,
      }),
  });
}

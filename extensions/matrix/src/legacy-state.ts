import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveLegacyMatrixFlatStoreTarget } from "./migration-config.js";
import { resolveMatrixLegacyFlatStoragePaths } from "./storage-paths.js";

export type MatrixLegacyStateMigrationResult = {
  migrated: boolean;
  changes: string[];
  warnings: string[];
};

type MatrixLegacyStatePlan = {
  accountId: string;
  legacyStoragePath: string;
  legacyCryptoPath: string;
  targetRootDir: string;
  targetStoragePath: string;
  targetCryptoPath: string;
  selectionNote?: string;
};

function resolveLegacyMatrixPaths(env: NodeJS.ProcessEnv): {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
} {
  const stateDir = resolveStateDir(env, os.homedir);
  return resolveMatrixLegacyFlatStoragePaths(stateDir);
}

function resolveMatrixMigrationPlan(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | { warning: string } | null {
  const legacy = resolveLegacyMatrixPaths(params.env);
  if (!fs.existsSync(legacy.storagePath) && !fs.existsSync(legacy.cryptoPath)) {
    return null;
  }

  const target = resolveLegacyMatrixFlatStoreTarget({
    cfg: params.cfg,
    env: params.env,
    detectedPath: legacy.rootDir,
    detectedKind: "state",
  });
  if ("warning" in target) {
    return target;
  }

  return {
    accountId: target.accountId,
    legacyStoragePath: legacy.storagePath,
    legacyCryptoPath: legacy.cryptoPath,
    targetRootDir: target.rootDir,
    targetStoragePath: path.join(target.rootDir, "bot-storage.json"),
    targetCryptoPath: path.join(target.rootDir, "crypto"),
    selectionNote: target.selectionNote,
  };
}

export function detectLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyStatePlan | { warning: string } | null {
  return resolveMatrixMigrationPlan({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
}

function moveLegacyPath(params: {
  sourcePath: string;
  targetPath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): void {
  if (!fs.existsSync(params.sourcePath)) {
    return;
  }
  if (fs.existsSync(params.targetPath)) {
    params.warnings.push(
      `Matrix legacy ${params.label} not migrated because the target already exists (${params.targetPath}).`,
    );
    return;
  }
  try {
    fs.mkdirSync(path.dirname(params.targetPath), { recursive: true });
    fs.renameSync(params.sourcePath, params.targetPath);
    params.changes.push(
      `Migrated Matrix legacy ${params.label}: ${params.sourcePath} -> ${params.targetPath}`,
    );
  } catch (err) {
    params.warnings.push(
      `Failed migrating Matrix legacy ${params.label} (${params.sourcePath} -> ${params.targetPath}): ${String(err)}`,
    );
  }
}

export async function autoMigrateLegacyMatrixState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
}): Promise<MatrixLegacyStateMigrationResult> {
  const env = params.env ?? process.env;
  const detection = detectLegacyMatrixState({ cfg: params.cfg, env });
  if (!detection) {
    return { migrated: false, changes: [], warnings: [] };
  }
  if ("warning" in detection) {
    params.log?.warn?.(`matrix: ${detection.warning}`);
    return { migrated: false, changes: [], warnings: [detection.warning] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  moveLegacyPath({
    sourcePath: detection.legacyStoragePath,
    targetPath: detection.targetStoragePath,
    label: "sync store",
    changes,
    warnings,
  });
  moveLegacyPath({
    sourcePath: detection.legacyCryptoPath,
    targetPath: detection.targetCryptoPath,
    label: "crypto store",
    changes,
    warnings,
  });

  if (changes.length > 0) {
    const details = [
      ...changes.map((entry) => `- ${entry}`),
      ...(detection.selectionNote ? [`- ${detection.selectionNote}`] : []),
      "- No user action required.",
    ];
    params.log?.info?.(
      `matrix: plugin upgraded in place for account "${detection.accountId}".\n${details.join("\n")}`,
    );
  }
  if (warnings.length > 0) {
    params.log?.warn?.(
      `matrix: legacy state migration warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  return {
    migrated: changes.length > 0,
    changes,
    warnings,
  };
}

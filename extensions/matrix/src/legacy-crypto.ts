import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  loadJsonFile,
  writeJsonFileAtomically as writeJsonFileAtomicallyImpl,
} from "openclaw/plugin-sdk/json-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveConfiguredMatrixAccountIds } from "./account-selection.js";
import { isMatrixLegacyCryptoInspectorAvailable } from "./legacy-crypto-inspector-availability.js";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import {
  resolveLegacyMatrixFlatStoreTarget,
  resolveMatrixMigrationAccountTarget,
} from "./migration-config.js";
import { resolveMatrixLegacyFlatStoragePaths } from "./storage-paths.js";

const MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE =
  "Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.";

type MatrixLegacyCryptoCounts = {
  total: number;
  backedUp: number;
};

type MatrixLegacyCryptoSummary = {
  deviceId: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
};

type MatrixLegacyCryptoMigrationState = {
  version: 1;
  source: "matrix-bot-sdk-rust";
  accountId: string;
  deviceId: string | null;
  roomKeyCounts: MatrixLegacyCryptoCounts | null;
  backupVersion: string | null;
  decryptionKeyImported: boolean;
  restoreStatus: "pending" | "completed" | "manual-action-required";
  detectedAt: string;
  restoredAt?: string;
  importedCount?: number;
  totalCount?: number;
  lastError?: string | null;
};

type MatrixLegacyCryptoPlan = {
  accountId: string;
  rootDir: string;
  recoveryKeyPath: string;
  statePath: string;
  legacyCryptoPath: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
};

type MatrixLegacyCryptoDetection = {
  inspectorAvailable: boolean;
  plans: MatrixLegacyCryptoPlan[];
  warnings: string[];
};

type MatrixLegacyCryptoPreparationResult = {
  migrated: boolean;
  changes: string[];
  warnings: string[];
};

type MatrixLegacyCryptoPrepareDeps = {
  inspectLegacyStore: MatrixLegacyCryptoInspector;
  writeJsonFileAtomically: typeof writeJsonFileAtomicallyImpl;
};

type MatrixLegacyCryptoInspectorParams = {
  cryptoRootDir: string;
  userId: string;
  deviceId: string;
  log?: (message: string) => void;
};

type MatrixLegacyCryptoInspectorResult = {
  deviceId: string | null;
  roomKeyCounts: {
    total: number;
    backedUp: number;
  } | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
};

type MatrixLegacyCryptoInspector = (
  params: MatrixLegacyCryptoInspectorParams,
) => Promise<MatrixLegacyCryptoInspectorResult>;

type MatrixLegacyBotSdkMetadata = {
  deviceId: string | null;
};

type MatrixStoredRecoveryKey = {
  version: 1;
  createdAt: string;
  keyId?: string | null;
  encodedPrivateKey?: string;
  privateKeyBase64: string;
  keyInfo?: {
    passphrase?: unknown;
    name?: string;
  };
};

async function loadMatrixLegacyCryptoInspector(): Promise<MatrixLegacyCryptoInspector> {
  const module = await import("./matrix/legacy-crypto-inspector.js");
  return module.inspectLegacyMatrixCryptoStore as MatrixLegacyCryptoInspector;
}

function detectLegacyBotSdkCryptoStore(cryptoRootDir: string): {
  detected: boolean;
  warning?: string;
} {
  try {
    const stat = fs.statSync(cryptoRootDir);
    if (!stat.isDirectory()) {
      return {
        detected: false,
        warning:
          `Legacy Matrix encrypted state path exists but is not a directory: ${cryptoRootDir}. ` +
          "OpenClaw skipped automatic crypto migration for that path.",
      };
    }
  } catch (err) {
    return {
      detected: false,
      warning:
        `Failed reading legacy Matrix encrypted state path (${cryptoRootDir}): ${String(err)}. ` +
        "OpenClaw skipped automatic crypto migration for that path.",
    };
  }

  try {
    return {
      detected:
        fs.existsSync(path.join(cryptoRootDir, "bot-sdk.json")) ||
        fs.existsSync(path.join(cryptoRootDir, "matrix-sdk-crypto.sqlite3")) ||
        fs
          .readdirSync(cryptoRootDir, { withFileTypes: true })
          .some(
            (entry) =>
              entry.isDirectory() &&
              fs.existsSync(path.join(cryptoRootDir, entry.name, "matrix-sdk-crypto.sqlite3")),
          ),
    };
  } catch (err) {
    return {
      detected: false,
      warning:
        `Failed scanning legacy Matrix encrypted state path (${cryptoRootDir}): ${String(err)}. ` +
        "OpenClaw skipped automatic crypto migration for that path.",
    };
  }
}

function resolveMatrixAccountIds(cfg: OpenClawConfig): string[] {
  return resolveConfiguredMatrixAccountIds(cfg);
}

function resolveLegacyMatrixFlatStorePlan(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): MatrixLegacyCryptoPlan | { warning: string } | null {
  const legacy = resolveMatrixLegacyFlatStoragePaths(resolveStateDir(params.env, os.homedir));
  if (!fs.existsSync(legacy.cryptoPath)) {
    return null;
  }
  const legacyStore = detectLegacyBotSdkCryptoStore(legacy.cryptoPath);
  if (legacyStore.warning) {
    return { warning: legacyStore.warning };
  }
  if (!legacyStore.detected) {
    return null;
  }

  const target = resolveLegacyMatrixFlatStoreTarget({
    cfg: params.cfg,
    env: params.env,
    detectedPath: legacy.cryptoPath,
    detectedKind: "encrypted state",
  });
  if ("warning" in target) {
    return target;
  }

  const metadata = loadLegacyBotSdkMetadata(legacy.cryptoPath);
  return {
    accountId: target.accountId,
    rootDir: target.rootDir,
    recoveryKeyPath: path.join(target.rootDir, "recovery-key.json"),
    statePath: path.join(target.rootDir, "legacy-crypto-migration.json"),
    legacyCryptoPath: legacy.cryptoPath,
    homeserver: target.homeserver,
    userId: target.userId,
    accessToken: target.accessToken,
    deviceId: metadata.deviceId ?? target.storedDeviceId,
  };
}

function loadLegacyBotSdkMetadata(cryptoRootDir: string): MatrixLegacyBotSdkMetadata {
  const metadataPath = path.join(cryptoRootDir, "bot-sdk.json");
  const fallback: MatrixLegacyBotSdkMetadata = { deviceId: null };
  const parsed = loadJsonFile<{ deviceId?: unknown }>(metadataPath);
  return {
    deviceId:
      typeof parsed?.deviceId === "string" && parsed.deviceId.trim()
        ? parsed.deviceId
        : fallback.deviceId,
  };
}

function resolveMatrixLegacyCryptoPlans(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Omit<MatrixLegacyCryptoDetection, "inspectorAvailable"> {
  const warnings: string[] = [];
  const plans: MatrixLegacyCryptoPlan[] = [];

  const flatPlan = resolveLegacyMatrixFlatStorePlan(params);
  if (flatPlan) {
    if ("warning" in flatPlan) {
      warnings.push(flatPlan.warning);
    } else {
      plans.push(flatPlan);
    }
  }

  for (const accountId of resolveMatrixAccountIds(params.cfg)) {
    const target = resolveMatrixMigrationAccountTarget({
      cfg: params.cfg,
      env: params.env,
      accountId,
    });
    if (!target) {
      continue;
    }
    const legacyCryptoPath = path.join(target.rootDir, "crypto");
    if (!fs.existsSync(legacyCryptoPath)) {
      continue;
    }
    const detectedStore = detectLegacyBotSdkCryptoStore(legacyCryptoPath);
    if (detectedStore.warning) {
      warnings.push(detectedStore.warning);
      continue;
    }
    if (!detectedStore.detected) {
      continue;
    }
    if (
      plans.some(
        (plan) =>
          plan.accountId === accountId &&
          path.resolve(plan.legacyCryptoPath) === path.resolve(legacyCryptoPath),
      )
    ) {
      continue;
    }
    const metadata = loadLegacyBotSdkMetadata(legacyCryptoPath);
    plans.push({
      accountId: target.accountId,
      rootDir: target.rootDir,
      recoveryKeyPath: path.join(target.rootDir, "recovery-key.json"),
      statePath: path.join(target.rootDir, "legacy-crypto-migration.json"),
      legacyCryptoPath,
      homeserver: target.homeserver,
      userId: target.userId,
      accessToken: target.accessToken,
      deviceId: metadata.deviceId ?? target.storedDeviceId,
    });
  }

  return { plans, warnings };
}

function loadStoredRecoveryKey(filePath: string): MatrixStoredRecoveryKey | null {
  return loadJsonFile<MatrixStoredRecoveryKey>(filePath) ?? null;
}

function loadLegacyCryptoMigrationState(filePath: string): MatrixLegacyCryptoMigrationState | null {
  return loadJsonFile<MatrixLegacyCryptoMigrationState>(filePath) ?? null;
}

async function persistLegacyMigrationState(params: {
  filePath: string;
  state: MatrixLegacyCryptoMigrationState;
  writeJsonFileAtomically: typeof writeJsonFileAtomicallyImpl;
}): Promise<void> {
  await params.writeJsonFileAtomically(params.filePath, params.state);
}

export function detectLegacyMatrixCrypto(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MatrixLegacyCryptoDetection {
  const detection = resolveMatrixLegacyCryptoPlans({
    cfg: params.cfg,
    env: params.env ?? process.env,
  });
  const inspectorAvailable =
    detection.plans.length === 0 || isMatrixLegacyCryptoInspectorAvailable();
  if (!inspectorAvailable && detection.plans.length > 0) {
    return {
      inspectorAvailable,
      plans: detection.plans,
      warnings: [...detection.warnings, MATRIX_LEGACY_CRYPTO_INSPECTOR_UNAVAILABLE_MESSAGE],
    };
  }
  return {
    inspectorAvailable,
    plans: detection.plans,
    warnings: detection.warnings,
  };
}

export async function autoPrepareLegacyMatrixCrypto(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log?: { info?: (message: string) => void; warn?: (message: string) => void };
  deps?: Partial<MatrixLegacyCryptoPrepareDeps>;
}): Promise<MatrixLegacyCryptoPreparationResult> {
  const env = params.env ?? process.env;
  const detection = params.deps?.inspectLegacyStore
    ? resolveMatrixLegacyCryptoPlans({ cfg: params.cfg, env })
    : detectLegacyMatrixCrypto({ cfg: params.cfg, env });
  const inspectorAvailable =
    "inspectorAvailable" in detection ? detection.inspectorAvailable : true;
  const warnings = [...detection.warnings];
  const changes: string[] = [];
  const writeJsonFileAtomically =
    params.deps?.writeJsonFileAtomically ?? writeJsonFileAtomicallyImpl;
  if (detection.plans.length === 0) {
    if (warnings.length > 0) {
      params.log?.warn?.(
        `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    return {
      migrated: false,
      changes,
      warnings,
    };
  }
  if (!params.deps?.inspectLegacyStore && !inspectorAvailable) {
    if (warnings.length > 0) {
      params.log?.warn?.(
        `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
      );
    }
    return {
      migrated: false,
      changes,
      warnings,
    };
  }

  let inspectLegacyStore = params.deps?.inspectLegacyStore;
  if (!inspectLegacyStore) {
    try {
      inspectLegacyStore = await loadMatrixLegacyCryptoInspector();
    } catch (err) {
      const message = formatMatrixErrorMessage(err);
      if (!warnings.includes(message)) {
        warnings.push(message);
      }
      if (warnings.length > 0) {
        params.log?.warn?.(
          `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
        );
      }
      return {
        migrated: false,
        changes,
        warnings,
      };
    }
  }
  if (!inspectLegacyStore) {
    return {
      migrated: false,
      changes,
      warnings,
    };
  }

  for (const plan of detection.plans) {
    const existingState = loadLegacyCryptoMigrationState(plan.statePath);
    if (existingState?.version === 1) {
      continue;
    }
    if (!plan.deviceId) {
      warnings.push(
        `Legacy Matrix encrypted state detected at ${plan.legacyCryptoPath}, but no device ID was found for account "${plan.accountId}". ` +
          `OpenClaw will continue, but old encrypted history cannot be recovered automatically.`,
      );
      continue;
    }

    let summary: MatrixLegacyCryptoSummary;
    try {
      summary = await inspectLegacyStore({
        cryptoRootDir: plan.legacyCryptoPath,
        userId: plan.userId,
        deviceId: plan.deviceId,
        log: params.log?.info,
      });
    } catch (err) {
      warnings.push(
        `Failed inspecting legacy Matrix encrypted state for account "${plan.accountId}" (${plan.legacyCryptoPath}): ${String(err)}`,
      );
      continue;
    }

    let decryptionKeyImported = false;
    if (summary.decryptionKeyBase64) {
      const existingRecoveryKey = loadStoredRecoveryKey(plan.recoveryKeyPath);
      if (
        existingRecoveryKey?.privateKeyBase64 &&
        existingRecoveryKey.privateKeyBase64 !== summary.decryptionKeyBase64
      ) {
        warnings.push(
          `Legacy Matrix backup key was found for account "${plan.accountId}", but ${plan.recoveryKeyPath} already contains a different recovery key. Leaving the existing file unchanged.`,
        );
      } else if (!existingRecoveryKey?.privateKeyBase64) {
        const payload: MatrixStoredRecoveryKey = {
          version: 1,
          createdAt: new Date().toISOString(),
          keyId: null,
          privateKeyBase64: summary.decryptionKeyBase64,
        };
        try {
          await writeJsonFileAtomically(plan.recoveryKeyPath, payload);
          changes.push(
            `Imported Matrix legacy backup key for account "${plan.accountId}": ${plan.recoveryKeyPath}`,
          );
          decryptionKeyImported = true;
        } catch (err) {
          warnings.push(
            `Failed writing Matrix recovery key for account "${plan.accountId}" (${plan.recoveryKeyPath}): ${String(err)}`,
          );
        }
      } else {
        decryptionKeyImported = true;
      }
    }

    const localOnlyKeys =
      summary.roomKeyCounts && summary.roomKeyCounts.total > summary.roomKeyCounts.backedUp
        ? summary.roomKeyCounts.total - summary.roomKeyCounts.backedUp
        : 0;
    if (localOnlyKeys > 0) {
      warnings.push(
        `Legacy Matrix encrypted state for account "${plan.accountId}" contains ${localOnlyKeys} room key(s) that were never backed up. ` +
          "Backed-up keys can be restored automatically, but local-only encrypted history may remain unavailable after upgrade.",
      );
    }
    if (!summary.decryptionKeyBase64 && (summary.roomKeyCounts?.backedUp ?? 0) > 0) {
      warnings.push(
        `Legacy Matrix encrypted state for account "${plan.accountId}" has backed-up room keys, but no local backup decryption key was found. ` +
          `Ask the operator to run "openclaw matrix verify backup restore --recovery-key <key>" after upgrade if they have the recovery key.`,
      );
    }
    if (!summary.decryptionKeyBase64 && (summary.roomKeyCounts?.total ?? 0) > 0) {
      warnings.push(
        `Legacy Matrix encrypted state for account "${plan.accountId}" cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.`,
      );
    }
    // If recovery-key persistence failed, leave the migration state absent so the next startup can retry.
    if (
      summary.decryptionKeyBase64 &&
      !decryptionKeyImported &&
      !loadStoredRecoveryKey(plan.recoveryKeyPath)
    ) {
      continue;
    }

    const state: MatrixLegacyCryptoMigrationState = {
      version: 1,
      source: "matrix-bot-sdk-rust",
      accountId: plan.accountId,
      deviceId: summary.deviceId,
      roomKeyCounts: summary.roomKeyCounts,
      backupVersion: summary.backupVersion,
      decryptionKeyImported,
      restoreStatus: decryptionKeyImported ? "pending" : "manual-action-required",
      detectedAt: new Date().toISOString(),
      lastError: null,
    };
    try {
      await persistLegacyMigrationState({
        filePath: plan.statePath,
        state,
        writeJsonFileAtomically,
      });
      changes.push(
        `Prepared Matrix legacy encrypted-state migration for account "${plan.accountId}": ${plan.statePath}`,
      );
    } catch (err) {
      warnings.push(
        `Failed writing Matrix legacy encrypted-state migration record for account "${plan.accountId}" (${plan.statePath}): ${String(err)}`,
      );
    }
  }

  if (changes.length > 0) {
    params.log?.info?.(
      `matrix: prepared encrypted-state upgrade.\n${changes.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  if (warnings.length > 0) {
    params.log?.warn?.(
      `matrix: legacy encrypted-state warnings:\n${warnings.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }

  return {
    migrated: changes.length > 0,
    changes,
    warnings,
  };
}

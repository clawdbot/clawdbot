// Doctor-only detection and replacement for invalid canonical device identity rows.
import fs from "node:fs";
import path from "node:path";
import {
  DeviceIdentityStorageError,
  generateStoredDeviceIdentity,
  readStoredDeviceIdentityReadOnly,
  repairInvalidStoredDeviceIdentity,
} from "./device-identity-store.js";
import { formatErrorMessage } from "./errors.js";
import type { LegacyDeviceIdentityDetection } from "./state-migrations.device-identity.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_IDENTITY_RELATIVE_PATH = path.join("identity", "device.json");
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const NATIVE_CLAIM_SUFFIX = ".native-importing";
const IDENTITY_KEY = "primary";

function pathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Detect the exact retired paths and invalid canonical row only with Doctor authority. */
export function detectLegacyDeviceIdentity(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): LegacyDeviceIdentityDetection {
  const sourcePath = path.join(params.stateDir, LEGACY_IDENTITY_RELATIVE_PATH);
  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const nativeClaimPath = `${sourcePath}${NATIVE_CLAIM_SUFFIX}`;
  const doctorAuthorized = params.doctorOnlyStateMigrations === true;
  let hasInvalidCanonical = false;
  if (doctorAuthorized) {
    try {
      readStoredDeviceIdentityReadOnly({
        env: { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir },
        identityKey: IDENTITY_KEY,
      });
    } catch (error) {
      hasInvalidCanonical = error instanceof DeviceIdentityStorageError;
    }
  }
  return {
    sourcePath,
    claimPath,
    nativeClaimPath,
    hasLegacy:
      doctorAuthorized &&
      (pathMayExist(claimPath) || pathMayExist(nativeClaimPath) || pathMayExist(sourcePath)),
    hasInvalidCanonical,
  };
}

export function hasLegacyDeviceIdentityPath(detected: LegacyDeviceIdentityDetection): boolean {
  return (
    pathMayExist(detected.claimPath) ||
    pathMayExist(detected.nativeClaimPath) ||
    pathMayExist(detected.sourcePath)
  );
}

/** Generate a replacement only after the caller acquires Doctor's exclusive state lock. */
export function repairInvalidCanonicalIdentity(env: NodeJS.ProcessEnv): MigrationMessages {
  try {
    const result = repairInvalidStoredDeviceIdentity(generateStoredDeviceIdentity(), {
      env,
      identityKey: IDENTITY_KEY,
    });
    if (!result.repaired) {
      return { changes: [], warnings: [] };
    }
    if (!result.rotated) {
      return {
        changes: ["Repaired invalid primary device identity metadata in SQLite."],
        warnings: [],
      };
    }
    return {
      changes: ["Replaced invalid primary device identity in SQLite."],
      warnings: [],
      notices: ["The repaired device has a new identity and must be approved again."],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed repairing invalid SQLite device identity: ${formatErrorMessage(error)}`],
    };
  }
}

import { compareOpenClawVersions } from "../config/version.js";
// Durable transition state for installs upgrading from the retired Control UI device-auth bypass.
import {
  importConfigMachineState,
  readConfigMachineState,
  updateConfigMachineState,
  writeConfigMachineState,
} from "./config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

export const CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY = "gateway.controlUi.deviceAuthMigration";
const DEVICE_AUTH_MIGRATION_CUTOVER_VERSION = "2026.7.2";

export type ControlUiDeviceAuthMigrationState =
  | {
      version: 1;
      status: "pending";
      detectedAtMs: number;
      claimedDeviceId?: string;
      claimedAtMs?: number;
    }
  | {
      version: 1;
      status: "completed";
      detectedAtMs: number;
      completedAtMs: number;
      deviceId: string;
    };

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeState(value: unknown): ControlUiDeviceAuthMigrationState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<ControlUiDeviceAuthMigrationState>;
  if (candidate.version !== 1 || !isFiniteTimestamp(candidate.detectedAtMs)) {
    return undefined;
  }
  if (candidate.status === "pending") {
    const claimedDeviceId =
      typeof candidate.claimedDeviceId === "string" && candidate.claimedDeviceId.trim()
        ? candidate.claimedDeviceId.trim()
        : undefined;
    const claimedAtMs = isFiniteTimestamp(candidate.claimedAtMs)
      ? candidate.claimedAtMs
      : undefined;
    return {
      version: 1,
      status: "pending",
      detectedAtMs: candidate.detectedAtMs,
      ...(claimedDeviceId && claimedAtMs !== undefined ? { claimedDeviceId, claimedAtMs } : {}),
    };
  }
  if (
    candidate.status === "completed" &&
    isFiniteTimestamp(candidate.completedAtMs) &&
    typeof candidate.deviceId === "string" &&
    candidate.deviceId.trim()
  ) {
    return {
      version: 1,
      status: "completed",
      detectedAtMs: candidate.detectedAtMs,
      completedAtMs: candidate.completedAtMs,
      deviceId: candidate.deviceId.trim(),
    };
  }
  return undefined;
}

export function isLegacyControlUiDeviceAuthMigrationInput(params: {
  disabledDeviceAuth: boolean;
  lastTouchedVersion?: string;
}): boolean {
  return (
    params.disabledDeviceAuth &&
    (typeof params.lastTouchedVersion !== "string" ||
      compareOpenClawVersions(params.lastTouchedVersion, DEVICE_AUTH_MIGRATION_CUTOVER_VERSION) ===
        -1)
  );
}

export function readControlUiDeviceAuthMigrationState(
  options: OpenClawStateDatabaseOptions = {},
): ControlUiDeviceAuthMigrationState | undefined {
  return normalizeState(
    readConfigMachineState(CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY, options),
  );
}

/**
 * Capture the shipped break-glass flag before Doctor removes it. Import semantics
 * preserve a completed receipt so stale config cannot reopen migration access.
 */
export function importPendingControlUiDeviceAuthMigration(
  options: OpenClawStateDatabaseOptions = {},
): ControlUiDeviceAuthMigrationState {
  const pending: ControlUiDeviceAuthMigrationState = {
    version: 1,
    status: "pending",
    detectedAtMs: Date.now(),
  };
  importConfigMachineState([[CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY, pending]], options);
  return readControlUiDeviceAuthMigrationState(options) ?? pending;
}

export function completeControlUiDeviceAuthMigration(
  deviceId: string,
  options: OpenClawStateDatabaseOptions = {},
): ControlUiDeviceAuthMigrationState {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    throw new Error("device auth migration completion requires a device id");
  }
  const current = readControlUiDeviceAuthMigrationState(options);
  const completed: ControlUiDeviceAuthMigrationState = {
    version: 1,
    status: "completed",
    detectedAtMs: current?.detectedAtMs ?? Date.now(),
    completedAtMs: Date.now(),
    deviceId: normalizedDeviceId,
  };
  writeConfigMachineState(CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY, completed, options);
  return completed;
}

export function recoverControlUiDeviceAuthMigrationClaim(
  options: OpenClawStateDatabaseOptions = {},
): ControlUiDeviceAuthMigrationState | undefined {
  const initial = readControlUiDeviceAuthMigrationState(options);
  if (initial?.status !== "pending" || !initial.claimedDeviceId) {
    return initial;
  }
  return updateConfigMachineState<ControlUiDeviceAuthMigrationState>(
    CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY,
    (raw) => {
      const current = normalizeState(raw) ?? initial;
      if (current?.status !== "pending" || !current.claimedDeviceId) {
        return current;
      }
      return {
        version: 1,
        status: "pending",
        detectedAtMs: current.detectedAtMs,
      };
    },
    options,
  );
}

export function claimControlUiDeviceAuthMigration(
  deviceId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    return false;
  }
  const initial = readControlUiDeviceAuthMigrationState(options);
  if (initial?.status !== "pending" || initial.claimedDeviceId) {
    return false;
  }
  let claimed = false;
  updateConfigMachineState<ControlUiDeviceAuthMigrationState>(
    CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY,
    (raw) => {
      const current = normalizeState(raw) ?? initial;
      if (current?.status !== "pending" || current.claimedDeviceId) {
        return current;
      }
      claimed = true;
      return {
        ...current,
        claimedDeviceId: normalizedDeviceId,
        claimedAtMs: Date.now(),
      };
    },
    options,
  );
  return claimed;
}

export function releaseControlUiDeviceAuthMigrationClaim(
  deviceId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const normalizedDeviceId = deviceId.trim();
  const initial = readControlUiDeviceAuthMigrationState(options);
  if (initial?.status !== "pending" || initial.claimedDeviceId !== normalizedDeviceId) {
    return;
  }
  updateConfigMachineState<ControlUiDeviceAuthMigrationState>(
    CONTROL_UI_DEVICE_AUTH_MIGRATION_STATE_KEY,
    (raw) => {
      const current = normalizeState(raw) ?? initial;
      if (current?.status !== "pending" || current.claimedDeviceId !== normalizedDeviceId) {
        return current;
      }
      return {
        version: 1,
        status: "pending",
        detectedAtMs: current.detectedAtMs,
      };
    },
    options,
  );
}

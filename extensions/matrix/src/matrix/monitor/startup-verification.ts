import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import type { MatrixConfig } from "../../types.js";
import { resolveMatrixStoragePaths } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import { formatMatrixErrorMessage } from "../errors.js";
import type { MatrixClient, MatrixOwnDeviceVerificationStatus } from "../sdk.js";

const STARTUP_VERIFICATION_STATE_FILENAME = "startup-verification.json";
const DEFAULT_STARTUP_VERIFICATION_MODE = "if-unverified" as const;
const DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS = 24;
const DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

type MatrixStartupVerificationState = {
  userId?: string | null;
  deviceId?: string | null;
  attemptedAt?: string;
  outcome?: "requested" | "failed";
  requestId?: string;
  transactionId?: string;
  error?: string;
};

export type MatrixStartupVerificationOutcome =
  | {
      kind: "disabled" | "verified" | "cooldown" | "pending" | "requested" | "request-failed";
      verification: MatrixOwnDeviceVerificationStatus;
      requestId?: string;
      transactionId?: string;
      error?: string;
      retryAfterMs?: number;
    }
  | {
      kind: "unsupported";
      verification?: undefined;
    };

function normalizeCooldownHours(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_STARTUP_VERIFICATION_COOLDOWN_HOURS;
  }
  return Math.max(0, value);
}

function resolveStartupVerificationStatePath(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
}): string {
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.auth.accountId,
    deviceId: params.auth.deviceId,
    env: params.env,
  });
  return path.join(storagePaths.rootDir, STARTUP_VERIFICATION_STATE_FILENAME);
}

async function readStartupVerificationState(
  filePath: string,
): Promise<MatrixStartupVerificationState | null> {
  const { value } = await readJsonFileWithFallback<MatrixStartupVerificationState | null>(
    filePath,
    null,
  );
  return value && typeof value === "object" ? value : null;
}

async function clearStartupVerificationState(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true }).catch(() => {});
}

function resolveStateCooldownMs(
  state: MatrixStartupVerificationState | null,
  cooldownMs: number,
): number {
  if (state?.outcome === "failed") {
    return Math.min(cooldownMs, DEFAULT_STARTUP_VERIFICATION_FAILURE_COOLDOWN_MS);
  }
  return cooldownMs;
}

function resolveRetryAfterMs(params: {
  attemptedAt?: string;
  cooldownMs: number;
  nowMs: number;
}): number | undefined {
  const attemptedAtMs = Date.parse(params.attemptedAt ?? "");
  if (!Number.isFinite(attemptedAtMs)) {
    return undefined;
  }
  const remaining = attemptedAtMs + params.cooldownMs - params.nowMs;
  return remaining > 0 ? remaining : undefined;
}

function shouldHonorCooldown(params: {
  state: MatrixStartupVerificationState | null;
  verification: MatrixOwnDeviceVerificationStatus;
  stateCooldownMs: number;
  nowMs: number;
}): boolean {
  if (!params.state || params.stateCooldownMs <= 0) {
    return false;
  }
  if (
    params.state.userId &&
    params.verification.userId &&
    params.state.userId !== params.verification.userId
  ) {
    return false;
  }
  if (
    params.state.deviceId &&
    params.verification.deviceId &&
    params.state.deviceId !== params.verification.deviceId
  ) {
    return false;
  }
  return (
    resolveRetryAfterMs({
      attemptedAt: params.state.attemptedAt,
      cooldownMs: params.stateCooldownMs,
      nowMs: params.nowMs,
    }) !== undefined
  );
}

function hasPendingSelfVerification(
  verifications: Array<{
    isSelfVerification: boolean;
    completed: boolean;
    pending: boolean;
  }>,
): boolean {
  return verifications.some(
    (entry) => entry.isSelfVerification && !entry.completed && entry.pending,
  );
}

export async function ensureMatrixStartupVerification(params: {
  client: Pick<MatrixClient, "crypto" | "getOwnDeviceVerificationStatus">;
  auth: MatrixAuth;
  accountConfig: Pick<MatrixConfig, "startupVerification" | "startupVerificationCooldownHours">;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  stateFilePath?: string;
}): Promise<MatrixStartupVerificationOutcome> {
  if (params.auth.encryption !== true || !params.client.crypto) {
    return { kind: "unsupported" };
  }

  const verification = await params.client.getOwnDeviceVerificationStatus();
  const statePath =
    params.stateFilePath ??
    resolveStartupVerificationStatePath({
      auth: params.auth,
      env: params.env,
    });

  if (verification.verified) {
    await clearStartupVerificationState(statePath);
    return {
      kind: "verified",
      verification,
    };
  }

  const mode = params.accountConfig.startupVerification ?? DEFAULT_STARTUP_VERIFICATION_MODE;
  if (mode === "off") {
    await clearStartupVerificationState(statePath);
    return {
      kind: "disabled",
      verification,
    };
  }

  const verifications = await params.client.crypto.listVerifications().catch(() => []);
  if (hasPendingSelfVerification(verifications)) {
    return {
      kind: "pending",
      verification,
    };
  }

  const cooldownHours = normalizeCooldownHours(
    params.accountConfig.startupVerificationCooldownHours,
  );
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const nowMs = params.nowMs ?? Date.now();
  const state = await readStartupVerificationState(statePath);
  const stateCooldownMs = resolveStateCooldownMs(state, cooldownMs);
  if (shouldHonorCooldown({ state, verification, stateCooldownMs, nowMs })) {
    return {
      kind: "cooldown",
      verification,
      retryAfterMs: resolveRetryAfterMs({
        attemptedAt: state?.attemptedAt,
        cooldownMs: stateCooldownMs,
        nowMs,
      }),
    };
  }

  try {
    const request = await params.client.crypto.requestVerification({ ownUser: true });
    await writeJsonFileAtomically(statePath, {
      userId: verification.userId,
      deviceId: verification.deviceId,
      attemptedAt: new Date(nowMs).toISOString(),
      outcome: "requested",
      requestId: request.id,
      transactionId: request.transactionId,
    } satisfies MatrixStartupVerificationState);
    return {
      kind: "requested",
      verification,
      requestId: request.id,
      transactionId: request.transactionId ?? undefined,
    };
  } catch (err) {
    const error = formatMatrixErrorMessage(err);
    await writeJsonFileAtomically(statePath, {
      userId: verification.userId,
      deviceId: verification.deviceId,
      attemptedAt: new Date(nowMs).toISOString(),
      outcome: "failed",
      error,
    } satisfies MatrixStartupVerificationState).catch(() => {});
    return {
      kind: "request-failed",
      verification,
      error,
    };
  }
}

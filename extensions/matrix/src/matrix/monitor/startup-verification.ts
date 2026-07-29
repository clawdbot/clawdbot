// Matrix plugin module implements startup verification behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import { timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { MatrixConfig } from "../../types.js";
import { recordCurrentStorageMetaDeviceId, resolveMatrixStoragePaths } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import { formatMatrixErrorMessage } from "../errors.js";
import type { MatrixClient, MatrixOwnDeviceVerificationStatus } from "../sdk.js";
import { resolveMatrixSqliteStateEnv } from "../sqlite-state.js";

const STARTUP_VERIFICATION_STATE_FILENAME = "startup-verification.json";
const STARTUP_VERIFICATION_NAMESPACE = "startup-verification";
const STARTUP_VERIFICATION_MIGRATIONS_NAMESPACE = "startup-verification-migrations";
const STARTUP_VERIFICATION_MAX_ENTRIES = 1_000;
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

type MatrixStartupVerificationMigrationMarker = {
  importedAt: number;
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
  stateDir?: string;
}): string {
  const storagePaths = resolveMatrixStoragePaths({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.auth.accountId,
    deviceId: params.auth.deviceId,
    env: params.env,
    stateDir: params.stateDir,
  });
  return path.join(storagePaths.rootDir, STARTUP_VERIFICATION_STATE_FILENAME);
}

function buildStartupVerificationKey(auth: MatrixAuth): string {
  return auth.accountId.trim() || "default";
}

function createStartupVerificationStore(params: { env?: NodeJS.ProcessEnv; stateDir?: string }) {
  return getMatrixRuntime().state.openKeyedStore<MatrixStartupVerificationState>({
    namespace: STARTUP_VERIFICATION_NAMESPACE,
    maxEntries: STARTUP_VERIFICATION_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv(params),
  });
}

function createStartupVerificationMigrationStore(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}) {
  return getMatrixRuntime().state.openKeyedStore<MatrixStartupVerificationMigrationMarker>({
    namespace: STARTUP_VERIFICATION_MIGRATIONS_NAMESPACE,
    maxEntries: STARTUP_VERIFICATION_MAX_ENTRIES,
    env: resolveMatrixSqliteStateEnv(params),
  });
}

function buildStartupVerificationImportKey(params: {
  auth: MatrixAuth;
  legacyFilePath: string;
}): string {
  const accountId = params.auth.accountId.trim() || "default";
  const digest = createHash("sha256")
    .update(accountId)
    .update("\0")
    .update(params.legacyFilePath)
    .digest("hex");
  return `${accountId}:${digest}`;
}

async function readLegacyStartupVerificationState(
  filePath: string,
): Promise<MatrixStartupVerificationState | null> {
  const { value } = await readJsonFileWithFallback<MatrixStartupVerificationState | null>(
    filePath,
    null,
  );
  return value && typeof value === "object" ? value : null;
}

async function readStartupVerificationState(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  legacyFilePath: string;
}): Promise<MatrixStartupVerificationState | null> {
  const store = createStartupVerificationStore(params);
  const key = buildStartupVerificationKey(params.auth);
  const value = await store.lookup(key);
  if (value && typeof value === "object") {
    return value;
  }
  const migrationStore = createStartupVerificationMigrationStore(params);
  const legacyImportKey = buildStartupVerificationImportKey({
    auth: params.auth,
    legacyFilePath: params.legacyFilePath,
  });
  if (await migrationStore.lookup(legacyImportKey)) {
    return null;
  }
  const legacy = await readLegacyStartupVerificationState(params.legacyFilePath);
  if (legacy) {
    await store
      .register(key, legacy)
      .then(async () => {
        if (typeof legacy.deviceId === "string" && legacy.deviceId.trim()) {
          recordCurrentStorageMetaDeviceId({
            rootDir: path.dirname(params.legacyFilePath),
            deviceId: legacy.deviceId,
          });
        }
        await migrationStore.register(legacyImportKey, { importedAt: Date.now() });
        await fs.rm(params.legacyFilePath, { force: true }).catch(() => {});
      })
      .catch(() => {});
  }
  return legacy;
}

async function writeStartupVerificationState(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  legacyFilePath: string;
  state: MatrixStartupVerificationState;
}): Promise<void> {
  await createStartupVerificationStore(params).register(
    buildStartupVerificationKey(params.auth),
    params.state,
  );
  await createStartupVerificationMigrationStore(params)
    .register(
      buildStartupVerificationImportKey({
        auth: params.auth,
        legacyFilePath: params.legacyFilePath,
      }),
      { importedAt: Date.now() },
    )
    .catch(() => {});
  if (typeof params.state.deviceId === "string" && params.state.deviceId.trim()) {
    recordCurrentStorageMetaDeviceId({
      rootDir: path.dirname(params.legacyFilePath),
      deviceId: params.state.deviceId,
    });
  }
  await fs.rm(params.legacyFilePath, { force: true }).catch(() => {});
}

async function clearStartupVerificationState(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  legacyFilePath: string;
}): Promise<void> {
  await createStartupVerificationStore(params)
    .delete(buildStartupVerificationKey(params.auth))
    .catch(() => {});
  await createStartupVerificationMigrationStore(params)
    .register(
      buildStartupVerificationImportKey({
        auth: params.auth,
        legacyFilePath: params.legacyFilePath,
      }),
      { importedAt: Date.now() },
    )
    .catch(() => {});
  await fs.rm(params.legacyFilePath, { force: true }).catch(() => {});
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

function resolveStartupVerificationTimestamp(nowMs: unknown): string {
  return (
    timestampMsToIsoString(nowMs) ??
    timestampMsToIsoString(Date.now()) ??
    "1970-01-01T00:00:00.000Z"
  );
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
  stateDir?: string;
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
      stateDir: params.stateDir,
    });
  const stateDir = params.stateDir ?? path.dirname(statePath);

  if (verification.verified) {
    await clearStartupVerificationState({
      auth: params.auth,
      env: params.env,
      stateDir,
      legacyFilePath: statePath,
    });
    return {
      kind: "verified",
      verification,
    };
  }

  const mode = params.accountConfig.startupVerification ?? DEFAULT_STARTUP_VERIFICATION_MODE;
  if (mode === "off") {
    await clearStartupVerificationState({
      auth: params.auth,
      env: params.env,
      stateDir,
      legacyFilePath: statePath,
    });
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
  const attemptedAt = resolveStartupVerificationTimestamp(nowMs);
  const state = await readStartupVerificationState({
    auth: params.auth,
    env: params.env,
    stateDir,
    legacyFilePath: statePath,
  });
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
    await writeStartupVerificationState({
      auth: params.auth,
      env: params.env,
      stateDir,
      legacyFilePath: statePath,
      state: {
        userId: verification.userId,
        deviceId: verification.deviceId,
        attemptedAt,
        outcome: "requested",
        requestId: request.id,
        transactionId: request.transactionId,
      },
    });
    return {
      kind: "requested",
      verification,
      requestId: request.id,
      transactionId: request.transactionId ?? undefined,
    };
  } catch (err) {
    const error = formatMatrixErrorMessage(err);
    await writeStartupVerificationState({
      auth: params.auth,
      env: params.env,
      stateDir,
      legacyFilePath: statePath,
      state: {
        userId: verification.userId,
        deviceId: verification.deviceId,
        attemptedAt,
        outcome: "failed",
        error,
      },
    }).catch(() => {});
    return {
      kind: "request-failed",
      verification,
      error,
    };
  }
}

import { ClientEvent, SyncState, type MatrixClient } from "matrix-js-sdk";

import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";

export type MatrixResolvedConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
  encryption: boolean;
  initialSyncLimit?: number;
};

export type MatrixAuth = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  deviceName?: string;
  encryption: boolean;
  initialSyncLimit?: number;
};

type MatrixSdk = typeof import("matrix-js-sdk");

export function isBunRuntime(): boolean {
  const versions = process.versions as { bun?: string };
  return typeof versions.bun === "string";
}

async function loadMatrixSdk(): Promise<MatrixSdk> {
  return (await import("matrix-js-sdk")) as MatrixSdk;
}

function clean(value?: string): string {
  return value?.trim() ?? "";
}

export function resolveMatrixConfig(
  cfg: ClawdbotConfig = loadConfig(),
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const matrix = cfg.matrix ?? {};
  const homeserver =
    clean(env.MATRIX_HOMESERVER) || clean(matrix.homeserver);
  const userId = clean(env.MATRIX_USER_ID) || clean(matrix.userId);
  const accessToken =
    clean(env.MATRIX_ACCESS_TOKEN) || clean(matrix.accessToken) || undefined;
  const password =
    clean(env.MATRIX_PASSWORD) || clean(matrix.password) || undefined;
  const deviceId = clean(env.MATRIX_DEVICE_ID) || clean(matrix.deviceId);
  const deviceName =
    clean(env.MATRIX_DEVICE_NAME) || clean(matrix.deviceName) || undefined;
  const encryption = matrix.encryption !== false;
  const initialSyncLimit =
    typeof matrix.initialSyncLimit === "number"
      ? Math.max(1, Math.floor(matrix.initialSyncLimit))
      : undefined;
  return {
    homeserver,
    userId,
    accessToken,
    password,
    deviceId: deviceId || undefined,
    deviceName,
    encryption,
    initialSyncLimit,
  };
}

export async function resolveMatrixAuth(params?: {
  cfg?: ClawdbotConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MatrixAuth> {
  const cfg = params?.cfg ?? loadConfig();
  const env = params?.env ?? process.env;
  const resolved = resolveMatrixConfig(cfg, env);
  if (!resolved.homeserver) {
    throw new Error("Matrix homeserver is required (matrix.homeserver)");
  }
  if (!resolved.userId) {
    throw new Error("Matrix userId is required (matrix.userId)");
  }
  if (resolved.accessToken) {
    return {
      homeserver: resolved.homeserver,
      userId: resolved.userId,
      accessToken: resolved.accessToken,
      deviceId: resolved.deviceId,
      deviceName: resolved.deviceName,
      encryption: resolved.encryption,
      initialSyncLimit: resolved.initialSyncLimit,
    };
  }
  if (!resolved.password) {
    throw new Error(
      "Matrix access token or password is required (matrix.accessToken or matrix.password)",
    );
  }

  const sdk = await loadMatrixSdk();
  const loginClient = sdk.createClient({
    baseUrl: resolved.homeserver,
  });
  const login = await loginClient.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: resolved.userId },
    password: resolved.password,
    device_id: resolved.deviceId,
    initial_device_display_name:
      resolved.deviceName ?? "Clawdbot Gateway",
  });
  const accessToken = login.access_token?.trim();
  if (!accessToken) {
    throw new Error("Matrix login did not return an access token");
  }
  return {
    homeserver: resolved.homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken,
    deviceId: login.device_id ?? resolved.deviceId,
    deviceName: resolved.deviceName,
    encryption: resolved.encryption,
    initialSyncLimit: resolved.initialSyncLimit,
  };
}

export async function createMatrixClient(params: {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  localTimeoutMs?: number;
}): Promise<MatrixClient> {
  const sdk = await loadMatrixSdk();
  const store = new sdk.MemoryStore();
  return sdk.createClient({
    baseUrl: params.homeserver,
    userId: params.userId,
    accessToken: params.accessToken,
    deviceId: params.deviceId,
    localTimeoutMs: params.localTimeoutMs,
    store,
  });
}

export async function ensureMatrixCrypto(
  client: MatrixClient,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  if (client.getCrypto()) return;
  await client.initRustCrypto({ useIndexedDB: false });
}

export async function waitForMatrixSync(params: {
  client: MatrixClient;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const timeoutMs = Math.max(1000, params.timeoutMs ?? 15_000);
  if (params.client.getSyncState() === SyncState.Syncing) return;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (done) return;
      done = true;
      params.client.removeListener(ClientEvent.Sync, onSync);
      if (params.abortSignal) {
        params.abortSignal.removeEventListener("abort", onAbort);
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const onSync = (state: SyncState) => {
      if (done) return;
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        cleanup();
        resolve();
      }
      if (state === SyncState.Error) {
        cleanup();
        reject(new Error("Matrix sync failed"));
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Matrix sync aborted"));
    };
    params.client.on(ClientEvent.Sync, onSync);
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Matrix sync timed out"));
    }, timeoutMs);
  });
}

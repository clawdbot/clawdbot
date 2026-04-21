import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";

export type MatrixEnvConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
};

function cleanEnv(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveGlobalMatrixEnvConfig(env: NodeJS.ProcessEnv): MatrixEnvConfig {
  return {
    homeserver: cleanEnv(env.MATRIX_HOMESERVER),
    userId: cleanEnv(env.MATRIX_USER_ID),
    accessToken: cleanEnv(env.MATRIX_ACCESS_TOKEN) || undefined,
    password: cleanEnv(env.MATRIX_PASSWORD) || undefined,
    deviceId: cleanEnv(env.MATRIX_DEVICE_ID) || undefined,
    deviceName: cleanEnv(env.MATRIX_DEVICE_NAME) || undefined,
  };
}

export function hasReadyMatrixEnvAuth(config: {
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
}): boolean {
  const homeserver = cleanEnv(config.homeserver);
  const userId = cleanEnv(config.userId);
  const accessToken = cleanEnv(config.accessToken);
  const password = cleanEnv(config.password);
  return Boolean(homeserver && (accessToken || (userId && password)));
}

export function resolveScopedMatrixEnvConfig(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixEnvConfig {
  const keys = getMatrixScopedEnvVarNames(accountId);
  return {
    homeserver: cleanEnv(env[keys.homeserver]),
    userId: cleanEnv(env[keys.userId]),
    accessToken: cleanEnv(env[keys.accessToken]) || undefined,
    password: cleanEnv(env[keys.password]) || undefined,
    deviceId: cleanEnv(env[keys.deviceId]) || undefined,
    deviceName: cleanEnv(env[keys.deviceName]) || undefined,
  };
}

export function resolveMatrixEnvAuthReadiness(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  ready: boolean;
  homeserver?: string;
  userId?: string;
  sourceHint: string;
  missingMessage: string;
} {
  const normalizedAccountId = normalizeAccountId(accountId);
  const scoped = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
  const scopedReady = hasReadyMatrixEnvAuth(scoped);
  if (normalizedAccountId !== DEFAULT_ACCOUNT_ID) {
    const keys = getMatrixScopedEnvVarNames(normalizedAccountId);
    return {
      ready: scopedReady,
      homeserver: scoped.homeserver || undefined,
      userId: scoped.userId || undefined,
      sourceHint: `${keys.homeserver} (+ auth vars)`,
      missingMessage: `Set per-account env vars for "${normalizedAccountId}" (for example ${keys.homeserver} + ${keys.accessToken} or ${keys.userId} + ${keys.password}).`,
    };
  }

  const defaultScoped = resolveScopedMatrixEnvConfig(DEFAULT_ACCOUNT_ID, env);
  const global = resolveGlobalMatrixEnvConfig(env);
  const defaultScopedReady = hasReadyMatrixEnvAuth(defaultScoped);
  const globalReady = hasReadyMatrixEnvAuth(global);
  const defaultKeys = getMatrixScopedEnvVarNames(DEFAULT_ACCOUNT_ID);
  return {
    ready: defaultScopedReady || globalReady,
    homeserver: defaultScoped.homeserver || global.homeserver || undefined,
    userId: defaultScoped.userId || global.userId || undefined,
    sourceHint: "MATRIX_* or MATRIX_DEFAULT_*",
    missingMessage:
      `Set Matrix env vars for the default account ` +
      `(for example MATRIX_HOMESERVER + MATRIX_ACCESS_TOKEN, MATRIX_USER_ID + MATRIX_PASSWORD, ` +
      `or ${defaultKeys.homeserver} + ${defaultKeys.accessToken}).`,
  };
}

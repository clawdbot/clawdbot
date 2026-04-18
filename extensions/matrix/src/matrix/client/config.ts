import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import {
  coerceSecretRef,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../../account-selection.js";
import { resolveMatrixAccountStringValues } from "../../auth-precedence.js";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import {
  findMatrixAccountConfig,
  resolveMatrixBaseConfig,
  listNormalizedMatrixAccountIds,
} from "../account-config.js";
import { resolveMatrixConfigFieldPath } from "../config-paths.js";
import type { MatrixStoredCredentials } from "../credentials-read.js";
import {
  DEFAULT_ACCOUNT_ID,
  assertHttpUrlTargetsPrivateNetwork,
  isPrivateOrLoopbackHost,
  isPrivateNetworkOptInEnabled,
  type LookupFn,
  normalizeAccountId,
  normalizeOptionalAccountId,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "./config-runtime-api.js";
import { repairCurrentTokenStorageMetaDeviceId } from "./storage.js";
import type { MatrixAuth, MatrixResolvedConfig } from "./types.js";

type MatrixAuthClientDeps = {
  MatrixClient: typeof import("../sdk.js").MatrixClient;
  ensureMatrixSdkLoggingConfigured: typeof import("./logging.js").ensureMatrixSdkLoggingConfigured;
  retryMinDelayMs?: number;
};

type MatrixCredentialsReadDeps = {
  loadMatrixCredentials: typeof import("../credentials-read.js").loadMatrixCredentials;
  credentialsMatchConfig: typeof import("../credentials-read.js").credentialsMatchConfig;
};

type MatrixSecretInputDeps = {
  resolveConfiguredSecretInputString: typeof import("./config-secret-input.runtime.js").resolveConfiguredSecretInputString;
};

let matrixAuthClientDepsPromise: Promise<MatrixAuthClientDeps> | undefined;
let matrixCredentialsReadDepsPromise: Promise<MatrixCredentialsReadDeps> | undefined;
let matrixSecretInputDepsPromise: Promise<MatrixSecretInputDeps> | undefined;
let matrixAuthClientDepsForTest: MatrixAuthClientDeps | undefined;

const MATRIX_AUTH_REQUEST_RETRY_RE =
  /\b(fetch failed|econnreset|econnrefused|enotfound|etimedout|ehostunreach|enetunreach|eai_again|und_err_|socket hang up|network|headers timeout|body timeout|connect timeout)\b/i;

export function setMatrixAuthClientDepsForTest(deps?: {
  MatrixClient: typeof import("../sdk.js").MatrixClient;
  ensureMatrixSdkLoggingConfigured: typeof import("./logging.js").ensureMatrixSdkLoggingConfigured;
  retryMinDelayMs?: number;
}): void {
  matrixAuthClientDepsForTest = deps;
}

async function loadMatrixAuthClientDeps(): Promise<MatrixAuthClientDeps> {
  if (matrixAuthClientDepsForTest) {
    return matrixAuthClientDepsForTest;
  }
  matrixAuthClientDepsPromise ??= Promise.all([import("../sdk.js"), import("./logging.js")]).then(
    ([sdkModule, loggingModule]) => ({
      MatrixClient: sdkModule.MatrixClient,
      ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured,
    }),
  );
  return await matrixAuthClientDepsPromise;
}

async function loadMatrixCredentialsReadDeps(): Promise<MatrixCredentialsReadDeps> {
  matrixCredentialsReadDepsPromise ??= import("../credentials-read.js").then(
    (credentialsReadModule) => ({
      loadMatrixCredentials: credentialsReadModule.loadMatrixCredentials,
      credentialsMatchConfig: credentialsReadModule.credentialsMatchConfig,
    }),
  );
  return await matrixCredentialsReadDepsPromise;
}

async function loadMatrixSecretInputDeps(): Promise<MatrixSecretInputDeps> {
  matrixSecretInputDepsPromise ??= import("./config-secret-input.runtime.js").then((runtime) => ({
    resolveConfiguredSecretInputString: runtime.resolveConfiguredSecretInputString,
  }));
  return await matrixSecretInputDepsPromise;
}

function shouldRetryMatrixAuthRequest(err: unknown): boolean {
  return MATRIX_AUTH_REQUEST_RETRY_RE.test(formatErrorMessage(err));
}

function isAbortSignalTriggered(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function credentialsMatchBackfillAuthLineage(params: {
  stored: MatrixStoredCredentials | null;
  auth: Pick<MatrixAuth, "homeserver" | "userId" | "accessToken">;
}): boolean {
  if (!params.stored) {
    return true;
  }
  return (
    params.stored.homeserver === params.auth.homeserver &&
    params.stored.userId === params.auth.userId &&
    params.stored.accessToken === params.auth.accessToken
  );
}

async function retryMatrixAuthRequest<T>(label: string, run: () => Promise<T>): Promise<T> {
  return await retryAsync(run, {
    attempts: 3,
    minDelayMs: matrixAuthClientDepsForTest?.retryMinDelayMs ?? 250,
    maxDelayMs: 1_500,
    jitter: 0.1,
    label,
    shouldRetry: (err) => shouldRetryMatrixAuthRequest(err),
  });
}

async function fetchMatrixWhoamiIdentity(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  ssrfPolicy?: MatrixResolvedConfig["ssrfPolicy"];
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<{
  user_id?: string;
  device_id?: string;
}> {
  const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixAuthClientDeps();
  ensureMatrixSdkLoggingConfigured();
  const tempClient = new MatrixClient(params.homeserver, params.accessToken, {
    userId: params.userId,
    ssrfPolicy: params.ssrfPolicy,
    dispatcherPolicy: params.dispatcherPolicy,
  });
  return (await retryMatrixAuthRequest("matrix auth whoami", async () => {
    return (await tempClient.doRequest("GET", "/_matrix/client/v3/account/whoami")) as {
      user_id?: string;
      device_id?: string;
    };
  })) as {
    user_id?: string;
    device_id?: string;
  };
}

function readEnvSecretRefFallback(params: {
  value: unknown;
  env?: NodeJS.ProcessEnv;
  config?: Pick<CoreConfig, "secrets">;
}): string | undefined {
  const ref = coerceSecretRef(params.value, params.config?.secrets?.defaults);
  if (!ref || ref.source !== "env" || !params.env) {
    return undefined;
  }

  const providerConfig = params.config?.secrets?.providers?.[ref.provider];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      throw new Error(
        `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
      );
    }
    if (providerConfig.allowlist && !providerConfig.allowlist.includes(ref.id)) {
      throw new Error(
        `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${ref.provider}.allowlist.`,
      );
    }
  } else if (ref.provider !== (params.config?.secrets?.defaults?.env?.trim() || "default")) {
    throw new Error(
      `Secret provider "${ref.provider}" is not configured (ref: ${ref.source}:${ref.provider}:${ref.id}).`,
    );
  }

  const resolved = params.env[ref.id];
  if (typeof resolved !== "string") {
    return undefined;
  }

  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clean(
  value: unknown,
  path: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    config?: Pick<CoreConfig, "secrets">;
    allowEnvSecretRefFallback?: boolean;
    suppressSecretRef?: boolean;
  },
): string {
  const ref = coerceSecretRef(value, opts?.config?.secrets?.defaults);
  if (opts?.suppressSecretRef && ref) {
    return "";
  }
  const normalizedValue = opts?.allowEnvSecretRefFallback
    ? ref?.source === "env"
      ? (readEnvSecretRefFallback({
          value,
          env: opts.env,
          config: opts.config,
        }) ?? value)
      : ref
        ? ""
        : value
    : value;
  return (
    normalizeResolvedSecretInputString({
      value: normalizedValue,
      path,
      defaults: opts?.config?.secrets?.defaults,
    }) ?? ""
  );
}

type MatrixEnvConfig = {
  homeserver: string;
  userId: string;
  accessToken?: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
};

type MatrixConfigStringField =
  | "homeserver"
  | "userId"
  | "accessToken"
  | "password"
  | "deviceId"
  | "deviceName";

function resolveMatrixBaseConfigFieldPath(field: MatrixConfigStringField): string {
  return `channels.matrix.${field}`;
}

function shouldAllowEnvSecretRefFallback(field: MatrixConfigStringField): boolean {
  return field === "accessToken" || field === "password";
}

type MatrixAuthSecretField = "accessToken" | "password";

type MatrixConfiguredAuthInput = {
  value: unknown;
  path: string;
};

function hasConfiguredSecretInputValue(value: unknown, cfg: Pick<CoreConfig, "secrets">): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    Boolean(coerceSecretRef(value, cfg.secrets?.defaults))
  );
}

function hasConfiguredMatrixAccessTokenSource(params: {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): boolean {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
  const scopedAccessTokenVar = getMatrixScopedEnvVarNames(normalizedAccountId).accessToken;
  if (
    hasConfiguredSecretInputValue(account.accessToken, params.cfg) ||
    clean(params.env[scopedAccessTokenVar], scopedAccessTokenVar).length > 0
  ) {
    return true;
  }
  if (normalizedAccountId !== DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const matrix = resolveMatrixBaseConfig(params.cfg);
  return (
    hasConfiguredSecretInputValue(matrix.accessToken, params.cfg) ||
    clean(params.env.MATRIX_ACCESS_TOKEN, "MATRIX_ACCESS_TOKEN").length > 0
  );
}

function resolveConfiguredMatrixAuthInput(params: {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
  field: MatrixAuthSecretField;
}): MatrixConfiguredAuthInput | undefined {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const account = findMatrixAccountConfig(params.cfg, normalizedAccountId) ?? {};
  const accountValue = account[params.field];
  if (accountValue !== undefined) {
    return {
      value: accountValue,
      path: resolveMatrixConfigFieldPath(params.cfg, normalizedAccountId, params.field),
    };
  }

  const scopedKeys = getMatrixScopedEnvVarNames(normalizedAccountId);
  const scopedEnv = resolveScopedMatrixEnvConfig(normalizedAccountId, params.env);
  const scopedValue = scopedEnv[params.field];
  if (scopedValue !== undefined) {
    return {
      value: scopedValue,
      path: params.field === "accessToken" ? scopedKeys.accessToken : scopedKeys.password,
    };
  }

  if (normalizedAccountId !== DEFAULT_ACCOUNT_ID) {
    return undefined;
  }

  const matrix = resolveMatrixBaseConfig(params.cfg);
  const baseValue = matrix[params.field];
  if (baseValue !== undefined) {
    return {
      value: baseValue,
      path: resolveMatrixBaseConfigFieldPath(params.field),
    };
  }

  const globalValue =
    params.field === "accessToken" ? params.env.MATRIX_ACCESS_TOKEN : params.env.MATRIX_PASSWORD;
  if (globalValue !== undefined) {
    return {
      value: globalValue,
      path: params.field === "accessToken" ? "MATRIX_ACCESS_TOKEN" : "MATRIX_PASSWORD",
    };
  }

  return undefined;
}

async function resolveConfiguredMatrixAuthSecretInput(params: {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
  field: MatrixAuthSecretField;
}): Promise<string | undefined> {
  const configured = resolveConfiguredMatrixAuthInput(params);
  if (!configured) {
    return undefined;
  }

  const ref = coerceSecretRef(configured.value, params.cfg.secrets?.defaults);
  if (!ref) {
    return normalizeResolvedSecretInputString({
      value: configured.value,
      path: configured.path,
      defaults: params.cfg.secrets?.defaults,
    });
  }

  const { resolveConfiguredSecretInputString } = await loadMatrixSecretInputDeps();
  const resolved = await resolveConfiguredSecretInputString({
    config: params.cfg,
    env: params.env,
    value: configured.value,
    path: configured.path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.value !== undefined) {
    return resolved.value;
  }

  throw new Error(
    resolved.unresolvedRefReason ?? `${configured.path} SecretRef could not be resolved.`,
  );
}

function readMatrixBaseConfigField(
  matrix: ReturnType<typeof resolveMatrixBaseConfig>,
  field: MatrixConfigStringField,
  opts?: {
    env?: NodeJS.ProcessEnv;
    config?: Pick<CoreConfig, "secrets">;
    suppressSecretRef?: boolean;
  },
): string {
  return clean(matrix[field], resolveMatrixBaseConfigFieldPath(field), {
    env: opts?.env,
    config: opts?.config,
    allowEnvSecretRefFallback: shouldAllowEnvSecretRefFallback(field),
    suppressSecretRef: opts?.suppressSecretRef,
  });
}

function readMatrixAccountConfigField(
  cfg: CoreConfig,
  accountId: string,
  account: Partial<Record<MatrixConfigStringField, unknown>>,
  field: MatrixConfigStringField,
  opts?: {
    env?: NodeJS.ProcessEnv;
    config?: Pick<CoreConfig, "secrets">;
    suppressSecretRef?: boolean;
  },
): string {
  return clean(account[field], resolveMatrixConfigFieldPath(cfg, accountId, field), {
    env: opts?.env,
    config: opts?.config,
    allowEnvSecretRefFallback: shouldAllowEnvSecretRefFallback(field),
    suppressSecretRef: opts?.suppressSecretRef,
  });
}

function clampMatrixInitialSyncLimit(value: unknown): number | undefined {
  return typeof value === "number" ? Math.max(0, Math.floor(value)) : undefined;
}

const MATRIX_HTTP_HOMESERVER_ERROR =
  "Matrix homeserver must use https:// unless it targets a private or loopback host";

function buildMatrixNetworkFields(params: {
  allowPrivateNetwork: boolean | undefined;
  proxy?: string;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Pick<MatrixResolvedConfig, "allowPrivateNetwork" | "ssrfPolicy" | "dispatcherPolicy"> {
  const dispatcherPolicy: PinnedDispatcherPolicy | undefined =
    params.dispatcherPolicy ??
    (params.proxy ? { mode: "explicit-proxy", proxyUrl: params.proxy } : undefined);
  if (!params.allowPrivateNetwork && !dispatcherPolicy) {
    return {};
  }
  return {
    ...(params.allowPrivateNetwork
      ? {
          allowPrivateNetwork: true,
          ssrfPolicy: ssrfPolicyFromDangerouslyAllowPrivateNetwork(true),
        }
      : {}),
    ...(dispatcherPolicy ? { dispatcherPolicy } : {}),
  };
}

export function resolveGlobalMatrixEnvConfig(env: NodeJS.ProcessEnv): MatrixEnvConfig {
  return {
    homeserver: clean(env.MATRIX_HOMESERVER, "MATRIX_HOMESERVER"),
    userId: clean(env.MATRIX_USER_ID, "MATRIX_USER_ID"),
    accessToken: clean(env.MATRIX_ACCESS_TOKEN, "MATRIX_ACCESS_TOKEN") || undefined,
    password: clean(env.MATRIX_PASSWORD, "MATRIX_PASSWORD") || undefined,
    deviceId: clean(env.MATRIX_DEVICE_ID, "MATRIX_DEVICE_ID") || undefined,
    deviceName: clean(env.MATRIX_DEVICE_NAME, "MATRIX_DEVICE_NAME") || undefined,
  };
}

export { getMatrixScopedEnvVarNames } from "../../env-vars.js";

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

export function resolveScopedMatrixEnvConfig(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixEnvConfig {
  const keys = getMatrixScopedEnvVarNames(accountId);
  return {
    homeserver: clean(env[keys.homeserver], keys.homeserver),
    userId: clean(env[keys.userId], keys.userId),
    accessToken: clean(env[keys.accessToken], keys.accessToken) || undefined,
    password: clean(env[keys.password], keys.password) || undefined,
    deviceId: clean(env[keys.deviceId], keys.deviceId) || undefined,
    deviceName: clean(env[keys.deviceName], keys.deviceName) || undefined,
  };
}

function hasScopedMatrixEnvConfig(accountId: string, env: NodeJS.ProcessEnv): boolean {
  const scoped = resolveScopedMatrixEnvConfig(accountId, env);
  return Boolean(
    scoped.homeserver ||
    scoped.userId ||
    scoped.accessToken ||
    scoped.password ||
    scoped.deviceId ||
    scoped.deviceName,
  );
}

export function hasReadyMatrixEnvAuth(config: {
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  password?: string;
}): boolean {
  const homeserver = clean(config.homeserver, "matrix.env.homeserver");
  const userId = clean(config.userId, "matrix.env.userId");
  const accessToken = clean(config.accessToken, "matrix.env.accessToken");
  const password = clean(config.password, "matrix.env.password");
  return Boolean(homeserver && (accessToken || (userId && password)));
}

export function validateMatrixHomeserverUrl(
  homeserver: string,
  opts?: { allowPrivateNetwork?: boolean },
): string {
  const trimmed = clean(homeserver, "matrix.homeserver");
  if (!trimmed) {
    throw new Error("Matrix homeserver is required (matrix.homeserver)");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Matrix homeserver must be a valid http(s) URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Matrix homeserver must use http:// or https://");
  }
  if (!parsed.hostname) {
    throw new Error("Matrix homeserver must include a hostname");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Matrix homeserver URL must not include embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Matrix homeserver URL must not include query strings or fragments");
  }
  if (
    parsed.protocol === "http:" &&
    opts?.allowPrivateNetwork !== true &&
    !isPrivateOrLoopbackHost(parsed.hostname)
  ) {
    throw new Error(MATRIX_HTTP_HOMESERVER_ERROR);
  }

  return trimmed;
}

export async function resolveValidatedMatrixHomeserverUrl(
  homeserver: string,
  opts?: {
    dangerouslyAllowPrivateNetwork?: boolean;
    allowPrivateNetwork?: boolean;
    lookupFn?: LookupFn;
  },
): Promise<string> {
  const allowPrivateNetwork =
    typeof opts?.dangerouslyAllowPrivateNetwork === "boolean"
      ? opts.dangerouslyAllowPrivateNetwork
      : opts?.allowPrivateNetwork;
  const normalized = validateMatrixHomeserverUrl(homeserver, {
    allowPrivateNetwork,
  });
  await assertHttpUrlTargetsPrivateNetwork(normalized, {
    dangerouslyAllowPrivateNetwork: opts?.dangerouslyAllowPrivateNetwork,
    allowPrivateNetwork,
    lookupFn: opts?.lookupFn,
    errorMessage: MATRIX_HTTP_HOMESERVER_ERROR,
  });
  return normalized;
}

export function resolveMatrixConfigForAccount(
  cfg: CoreConfig,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  const matrix = resolveMatrixBaseConfig(cfg);
  const account = findMatrixAccountConfig(cfg, accountId) ?? {};
  const normalizedAccountId = normalizeAccountId(accountId);
  const suppressInactivePasswordSecretRef = hasConfiguredMatrixAccessTokenSource({
    cfg,
    env,
    accountId: normalizedAccountId,
  });
  const fieldReadOptions = {
    env,
    config: cfg,
  };
  const scopedEnv = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
  const globalEnv = resolveGlobalMatrixEnvConfig(env);
  const accountField = (field: MatrixConfigStringField) =>
    readMatrixAccountConfigField(cfg, normalizedAccountId, account, field, {
      ...fieldReadOptions,
      suppressSecretRef: field === "password" ? suppressInactivePasswordSecretRef : undefined,
    });
  const resolvedStrings = resolveMatrixAccountStringValues({
    accountId: normalizedAccountId,
    account: {
      homeserver: accountField("homeserver"),
      userId: accountField("userId"),
      accessToken: accountField("accessToken"),
      password: accountField("password"),
      deviceId: accountField("deviceId"),
      deviceName: accountField("deviceName"),
    },
    scopedEnv,
    channel: {
      homeserver: readMatrixBaseConfigField(matrix, "homeserver", fieldReadOptions),
      userId: readMatrixBaseConfigField(matrix, "userId", fieldReadOptions),
      accessToken: readMatrixBaseConfigField(matrix, "accessToken", fieldReadOptions),
      password: readMatrixBaseConfigField(matrix, "password", {
        ...fieldReadOptions,
        suppressSecretRef: suppressInactivePasswordSecretRef,
      }),
      deviceId: readMatrixBaseConfigField(matrix, "deviceId", fieldReadOptions),
      deviceName: readMatrixBaseConfigField(matrix, "deviceName", fieldReadOptions),
    },
    globalEnv,
  });

  const accountInitialSyncLimit = clampMatrixInitialSyncLimit(account.initialSyncLimit);
  const initialSyncLimit =
    accountInitialSyncLimit ?? clampMatrixInitialSyncLimit(matrix.initialSyncLimit);
  const encryption =
    typeof account.encryption === "boolean" ? account.encryption : (matrix.encryption ?? false);
  const allowPrivateNetwork =
    isPrivateNetworkOptInEnabled(account) || isPrivateNetworkOptInEnabled(matrix)
      ? true
      : undefined;

  return {
    homeserver: resolvedStrings.homeserver,
    userId: resolvedStrings.userId,
    accessToken: resolvedStrings.accessToken || undefined,
    password: resolvedStrings.password || undefined,
    deviceId: resolvedStrings.deviceId || undefined,
    deviceName: resolvedStrings.deviceName || undefined,
    initialSyncLimit,
    encryption,
    ...buildMatrixNetworkFields({
      allowPrivateNetwork,
      proxy: account.proxy ?? matrix.proxy,
    }),
  };
}

function resolveImplicitMatrixAccountId(
  cfg: CoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (requiresExplicitMatrixDefaultAccount(cfg, env)) {
    return null;
  }
  return normalizeAccountId(resolveMatrixDefaultOrOnlyAccountId(cfg, env));
}

export function resolveMatrixAuthContext(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
  resolved: MatrixResolvedConfig;
} {
  const cfg = params?.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
  const env = params?.env ?? process.env;
  const explicitAccountId = normalizeOptionalAccountId(params?.accountId);
  const effectiveAccountId = explicitAccountId ?? resolveImplicitMatrixAccountId(cfg, env);
  if (!effectiveAccountId) {
    throw new Error(
      'Multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set. Set "channels.matrix.defaultAccount" to the intended account or pass --account <id>.',
    );
  }
  if (
    explicitAccountId &&
    explicitAccountId !== DEFAULT_ACCOUNT_ID &&
    !listNormalizedMatrixAccountIds(cfg).includes(explicitAccountId) &&
    !hasScopedMatrixEnvConfig(explicitAccountId, env)
  ) {
    throw new Error(
      `Matrix account "${explicitAccountId}" is not configured. Add channels.matrix.accounts.${explicitAccountId} or define scoped ${getMatrixScopedEnvVarNames(explicitAccountId).accessToken.replace(/_ACCESS_TOKEN$/, "")}_* variables.`,
    );
  }
  const resolved = resolveMatrixConfigForAccount(cfg, effectiveAccountId, env);

  return {
    cfg,
    env,
    accountId: effectiveAccountId,
    resolved,
  };
}

export async function resolveMatrixAuth(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): Promise<MatrixAuth> {
  const { cfg, env, accountId, resolved } = resolveMatrixAuthContext(params);
  const accessToken =
    (await resolveConfiguredMatrixAuthSecretInput({
      cfg,
      env,
      accountId,
      field: "accessToken",
    })) ?? resolved.accessToken;
  const tokenAuthPassword = resolved.password;
  const homeserver = await resolveValidatedMatrixHomeserverUrl(resolved.homeserver, {
    dangerouslyAllowPrivateNetwork: resolved.allowPrivateNetwork,
  });
  let credentialsWriter: typeof import("../credentials-write.runtime.js") | undefined;
  const loadCredentialsWriter = async () => {
    credentialsWriter ??= await import("../credentials-write.runtime.js");
    return credentialsWriter;
  };

  const { loadMatrixCredentials, credentialsMatchConfig } = await loadMatrixCredentialsReadDeps();
  const cached = loadMatrixCredentials(env, accountId);
  const cachedCredentials =
    cached &&
    credentialsMatchConfig(cached, {
      homeserver,
      userId: resolved.userId || "",
      accessToken,
    })
      ? cached
      : null;

  // If we have an access token, we can fetch userId via whoami if not provided
  if (accessToken) {
    let userId = resolved.userId;
    const hasMatchingCachedToken = cachedCredentials?.accessToken === accessToken;
    let knownDeviceId = hasMatchingCachedToken
      ? cachedCredentials?.deviceId || resolved.deviceId
      : resolved.deviceId;

    if (!userId) {
      // Only block startup on whoami when token auth still needs the user ID.
      // A missing device ID alone is optional and should not force a network round-trip.
      const whoami = await fetchMatrixWhoamiIdentity({
        homeserver,
        accessToken,
        userId,
        ssrfPolicy: resolved.ssrfPolicy,
        dispatcherPolicy: resolved.dispatcherPolicy,
      });
      const fetchedUserId = whoami.user_id?.trim();
      if (!fetchedUserId) {
        throw new Error("Matrix whoami did not return user_id");
      }
      userId = fetchedUserId;
      knownDeviceId = knownDeviceId || whoami.device_id?.trim() || resolved.deviceId;
    }

    const shouldRefreshCachedCredentials =
      !cachedCredentials ||
      !hasMatchingCachedToken ||
      cachedCredentials.userId !== userId ||
      (cachedCredentials.deviceId || undefined) !== knownDeviceId;
    if (shouldRefreshCachedCredentials) {
      const { saveMatrixCredentials } = await loadCredentialsWriter();
      await saveMatrixCredentials(
        {
          homeserver,
          userId,
          accessToken,
          deviceId: knownDeviceId,
        },
        env,
        accountId,
      );
    } else if (hasMatchingCachedToken) {
      const { touchMatrixCredentials } = await loadCredentialsWriter();
      await touchMatrixCredentials(env, accountId);
    }
    return {
      accountId,
      homeserver,
      userId,
      accessToken,
      password: tokenAuthPassword,
      deviceId: knownDeviceId,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
      ...buildMatrixNetworkFields({
        allowPrivateNetwork: resolved.allowPrivateNetwork,
        dispatcherPolicy: resolved.dispatcherPolicy,
      }),
    };
  }

  if (cachedCredentials) {
    const { touchMatrixCredentials } = await loadCredentialsWriter();
    await touchMatrixCredentials(env, accountId);
    return {
      accountId,
      homeserver: cachedCredentials.homeserver,
      userId: cachedCredentials.userId,
      accessToken: cachedCredentials.accessToken,
      password: tokenAuthPassword,
      deviceId: cachedCredentials.deviceId || resolved.deviceId,
      deviceName: resolved.deviceName,
      initialSyncLimit: resolved.initialSyncLimit,
      encryption: resolved.encryption,
      ...buildMatrixNetworkFields({
        allowPrivateNetwork: resolved.allowPrivateNetwork,
        dispatcherPolicy: resolved.dispatcherPolicy,
      }),
    };
  }

  if (!resolved.userId) {
    throw new Error("Matrix userId is required when no access token is configured (matrix.userId)");
  }

  const password =
    (await resolveConfiguredMatrixAuthSecretInput({
      cfg,
      env,
      accountId,
      field: "password",
    })) ?? resolved.password;
  if (!password) {
    throw new Error(
      "Matrix password is required when no access token is configured (matrix.password)",
    );
  }

  // Login with password using the same hardened request path as other Matrix HTTP calls.
  const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixAuthClientDeps();
  ensureMatrixSdkLoggingConfigured();
  const loginClient = new MatrixClient(homeserver, "", {
    ssrfPolicy: resolved.ssrfPolicy,
    dispatcherPolicy: resolved.dispatcherPolicy,
  });
  const login = (await retryMatrixAuthRequest("matrix auth login", async () => {
    return (await loginClient.doRequest("POST", "/_matrix/client/v3/login", undefined, {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: resolved.userId },
      password,
      device_id: resolved.deviceId,
      initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway",
    })) as {
      access_token?: string;
      user_id?: string;
      device_id?: string;
    };
  })) as {
    access_token?: string;
    user_id?: string;
    device_id?: string;
  };

  const loginAccessToken = login.access_token?.trim();
  if (!loginAccessToken) {
    throw new Error("Matrix login did not return an access token");
  }

  const auth: MatrixAuth = {
    accountId,
    homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken: loginAccessToken,
    password,
    deviceId: login.device_id ?? resolved.deviceId,
    deviceName: resolved.deviceName,
    initialSyncLimit: resolved.initialSyncLimit,
    encryption: resolved.encryption,
    ...buildMatrixNetworkFields({
      allowPrivateNetwork: resolved.allowPrivateNetwork,
      dispatcherPolicy: resolved.dispatcherPolicy,
    }),
  };

  const { saveMatrixCredentials } = await loadCredentialsWriter();
  await saveMatrixCredentials(
    {
      homeserver: auth.homeserver,
      userId: auth.userId,
      accessToken: auth.accessToken,
      deviceId: auth.deviceId,
    },
    env,
    accountId,
  );

  return auth;
}

export async function backfillMatrixAuthDeviceIdAfterStartup(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  const knownDeviceId = params.auth.deviceId?.trim();
  if (knownDeviceId) {
    return knownDeviceId;
  }
  if (isAbortSignalTriggered(params.abortSignal)) {
    return undefined;
  }

  const whoami = await fetchMatrixWhoamiIdentity({
    homeserver: params.auth.homeserver,
    accessToken: params.auth.accessToken,
    userId: params.auth.userId,
    ssrfPolicy: params.auth.ssrfPolicy,
    dispatcherPolicy: params.auth.dispatcherPolicy,
  });
  const deviceId = whoami.device_id?.trim();
  if (!deviceId) {
    return undefined;
  }
  if (isAbortSignalTriggered(params.abortSignal)) {
    return undefined;
  }

  const env = params.env ?? process.env;
  const { loadMatrixCredentials } = await loadMatrixCredentialsReadDeps();
  if (
    !credentialsMatchBackfillAuthLineage({
      stored: loadMatrixCredentials(env, params.auth.accountId),
      auth: params.auth,
    })
  ) {
    return undefined;
  }

  const repairedStorageMeta = repairCurrentTokenStorageMetaDeviceId({
    homeserver: params.auth.homeserver,
    userId: params.auth.userId,
    accessToken: params.auth.accessToken,
    accountId: params.auth.accountId,
    deviceId,
    env: params.env,
  });
  if (!repairedStorageMeta) {
    throw new Error("Matrix deviceId backfill failed to repair current-token storage metadata");
  }
  if (isAbortSignalTriggered(params.abortSignal)) {
    return undefined;
  }

  const credentialsWriter = await import("../credentials-write.runtime.js");
  const saved = await credentialsWriter.saveBackfilledMatrixDeviceId(
    {
      homeserver: params.auth.homeserver,
      userId: params.auth.userId,
      accessToken: params.auth.accessToken,
      deviceId,
    },
    env,
    params.auth.accountId,
  );
  return saved === "saved" ? deviceId : undefined;
}

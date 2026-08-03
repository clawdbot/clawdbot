// Matrix helper module supports config behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  coerceSecretRef,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import {
  requiresExplicitMatrixDefaultAccount,
  resolveMatrixDefaultOrOnlyAccountId,
} from "../../account-selection.js";
import {
  resolveMatrixAccountStringValues,
  type MatrixResolvedStringField,
} from "../../auth-precedence.js";
import { getMatrixScopedEnvVarNames } from "../../env-vars.js";
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
  isPrivateNetworkOptInEnabled,
  normalizeAccountId,
  normalizeOptionalAccountId,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "./config-runtime-api.js";
import { resolveGlobalMatrixEnvConfig, resolveScopedMatrixEnvConfig } from "./env-auth.js";
import { repairCurrentTokenStorageMetaDeviceId } from "./storage.js";
import type { MatrixAuth, MatrixResolvedConfig } from "./types.js";
import { resolveValidatedMatrixHomeserverUrl } from "./url-validation.js";

const loadMatrixAuthClientDeps = createLazyRuntimeModule(() =>
  Promise.all([import("../sdk.js"), import("./logging.js")]).then(([sdkModule, loggingModule]) => ({
    MatrixClient: sdkModule.MatrixClient,
    ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured,
  })),
);
const MATRIX_AUTH_REQUEST_RETRY_RE =
  /\b(fetch failed|econnreset|econnrefused|enotfound|etimedout|ehostunreach|enetunreach|eai_again|und_err_|socket hang up|network|headers timeout|body timeout|connect timeout)\b/i;

const loadMatrixCredentialsReadDeps = createLazyRuntimeModule(
  () => import("../credentials-read.js"),
);

const loadMatrixCredentialsWriteRuntime = createLazyRuntimeModule(
  () => import("../credentials-write.runtime.js"),
);

const loadMatrixSecretInputDeps = createLazyRuntimeModule(
  () => import("./config-secret-input.runtime.js"),
);

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

async function retryMatrixAuthRequest<T>(
  label: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await retryAsync(run, {
    attempts: 3,
    minDelayMs: 250,
    maxDelayMs: 1_500,
    jitter: 0.1,
    label,
    shouldRetry: (err) => shouldRetryMatrixAuthRequest(err),
    sleep: (ms) => sleepWithAbort(ms, signal),
  });
}

type MatrixWhoamiIdentity = { user_id?: string; device_id?: string };
type MatrixLoginResponse = { access_token?: string; user_id?: string; device_id?: string };

async function fetchMatrixWhoamiIdentity(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  ssrfPolicy?: MatrixResolvedConfig["ssrfPolicy"];
  dispatcherPolicy?: PinnedDispatcherPolicy;
  signal?: AbortSignal;
}): Promise<MatrixWhoamiIdentity> {
  const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixAuthClientDeps();
  ensureMatrixSdkLoggingConfigured();
  const tempClient = new MatrixClient(params.homeserver, params.accessToken, {
    userId: params.userId,
    ssrfPolicy: params.ssrfPolicy,
    dispatcherPolicy: params.dispatcherPolicy,
  });
  return await retryMatrixAuthRequest(
    "matrix auth whoami",
    async () =>
      (await tempClient.doRequest(
        "GET",
        "/_matrix/client/v3/account/whoami",
      )) as MatrixWhoamiIdentity,
    params.signal,
  );
}

const MATRIX_CONFIG_STRING_FIELDS = [
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceId",
  "deviceName",
] as const satisfies readonly MatrixResolvedStringField[];
type MatrixConfigStringField = (typeof MATRIX_CONFIG_STRING_FIELDS)[number];
const MATRIX_AUTH_SECRET_FIELDS = ["accessToken", "password"] as const;
type MatrixAuthSecretField = (typeof MATRIX_AUTH_SECRET_FIELDS)[number];
type MatrixConfiguredAuthInput = { value: unknown; path: string };
type MatrixAuthInputs = Readonly<Partial<Record<MatrixAuthSecretField, MatrixConfiguredAuthInput>>>;

function readMatrixEnvSecretRef(params: {
  ref: NonNullable<ReturnType<typeof coerceSecretRef>>;
  cfg: Pick<CoreConfig, "secrets">;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  const provider = params.cfg.secrets?.providers?.[params.ref.provider];
  if (provider) {
    if (provider.source !== "env") {
      throw new Error(
        `Secret provider "${params.ref.provider}" has source "${provider.source}" but ref requests "env".`,
      );
    }
    if (provider.allowlist && !provider.allowlist.includes(params.ref.id)) {
      throw new Error(
        `Environment variable "${params.ref.id}" is not allowlisted in secrets.providers.${params.ref.provider}.allowlist.`,
      );
    }
  } else if (params.ref.provider !== (params.cfg.secrets?.defaults?.env?.trim() || "default")) {
    throw new Error(
      `Secret provider "${params.ref.provider}" is not configured (ref: env:${params.ref.provider}:${params.ref.id}).`,
    );
  }
  return params.env[params.ref.id]?.trim() || undefined;
}

function readMatrixConfigString(params: {
  value: unknown;
  path: string;
  cfg: Pick<CoreConfig, "secrets">;
  env: NodeJS.ProcessEnv;
  allowEnvSecretRef?: boolean;
  suppressSecretRef?: boolean;
}): string {
  const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
  if (params.suppressSecretRef && ref) {
    return "";
  }
  const value = params.allowEnvSecretRef
    ? ref?.source === "env"
      ? (readMatrixEnvSecretRef({ ref, cfg: params.cfg, env: params.env }) ?? params.value)
      : ref
        ? ""
        : params.value
    : params.value;
  return (
    normalizeResolvedSecretInputString({
      value,
      path: params.path,
      defaults: params.cfg.secrets?.defaults,
    }) ?? ""
  );
}

function resolveMatrixBaseConfigFieldPath(field: MatrixConfigStringField): string {
  return `channels.matrix.${field}`;
}

function hasConfiguredMatrixSecret(value: unknown, cfg: Pick<CoreConfig, "secrets">): boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    Boolean(coerceSecretRef(value, cfg.secrets?.defaults))
  );
}

async function resolveConfiguredMatrixAuthSecretInput(params: {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  configured?: MatrixConfiguredAuthInput;
}): Promise<string | undefined> {
  const configured = params.configured;
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

function clampMatrixInitialSyncLimit(value: unknown): number | undefined {
  return resolveOptionalIntegerOption(value, { min: 0 });
}

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

function buildResolvedMatrixAuth(
  resolved: MatrixResolvedConfig,
  auth: Pick<
    MatrixAuth,
    "accountId" | "homeserver" | "userId" | "accessToken" | "password" | "deviceId"
  >,
): MatrixAuth {
  return {
    ...auth,
    deviceName: resolved.deviceName,
    initialSyncLimit: resolved.initialSyncLimit,
    encryption: resolved.encryption,
    ...buildMatrixNetworkFields({
      allowPrivateNetwork: resolved.allowPrivateNetwork,
      dispatcherPolicy: resolved.dispatcherPolicy,
    }),
  };
}

export {
  hasReadyMatrixEnvAuth,
  resolveMatrixEnvAuthReadiness,
  resolveScopedMatrixEnvConfig,
} from "./env-auth.js";
export {
  resolveValidatedMatrixHomeserverUrl,
  validateMatrixHomeserverUrl,
} from "./url-validation.js";

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

function readMatrixConfigStrings(params: {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  values: Partial<Record<MatrixConfigStringField, unknown>>;
  path: (field: MatrixConfigStringField) => string;
  suppressPasswordSecretRef: boolean;
}): Record<MatrixConfigStringField, string> {
  return Object.fromEntries(
    MATRIX_CONFIG_STRING_FIELDS.map((field) => [
      field,
      readMatrixConfigString({
        value: params.values[field],
        path: params.path(field),
        cfg: params.cfg,
        env: params.env,
        allowEnvSecretRef: MATRIX_AUTH_SECRET_FIELDS.includes(field as MatrixAuthSecretField),
        suppressSecretRef: field === "password" && params.suppressPasswordSecretRef,
      }),
    ]),
  ) as Record<MatrixConfigStringField, string>;
}

function resolveMatrixAccountConfigSnapshot(
  cfg: CoreConfig,
  accountId: string,
  env: NodeJS.ProcessEnv,
) {
  const normalizedAccountId = normalizeAccountId(accountId);
  const matrix = resolveMatrixBaseConfig(cfg);
  const account = findMatrixAccountConfig(cfg, normalizedAccountId) ?? {};
  const scopedKeys = getMatrixScopedEnvVarNames(normalizedAccountId);
  const scopedEnv = resolveScopedMatrixEnvConfig(normalizedAccountId, env);
  const globalEnv = resolveGlobalMatrixEnvConfig(env);
  const authCandidates = (field: MatrixAuthSecretField): MatrixConfiguredAuthInput[] => [
    { value: account[field], path: resolveMatrixConfigFieldPath(cfg, accountId, field) },
    { value: scopedEnv[field], path: scopedKeys[field] },
    ...(normalizedAccountId === DEFAULT_ACCOUNT_ID
      ? [
          { value: matrix[field], path: resolveMatrixBaseConfigFieldPath(field) },
          {
            value: globalEnv[field],
            path: field === "accessToken" ? "MATRIX_ACCESS_TOKEN" : "MATRIX_PASSWORD",
          },
        ]
      : []),
  ];
  const accessTokenCandidates = authCandidates("accessToken");
  const passwordCandidates = authCandidates("password");
  const suppressPasswordSecretRef = accessTokenCandidates.some((source) =>
    hasConfiguredMatrixSecret(source.value, cfg),
  );
  const resolvedStrings = resolveMatrixAccountStringValues({
    accountId: normalizedAccountId,
    account: readMatrixConfigStrings({
      cfg,
      env,
      values: account,
      path: (field) => resolveMatrixConfigFieldPath(cfg, normalizedAccountId, field),
      suppressPasswordSecretRef,
    }),
    scopedEnv,
    channel: readMatrixConfigStrings({
      cfg,
      env,
      values: matrix,
      path: resolveMatrixBaseConfigFieldPath,
      suppressPasswordSecretRef,
    }),
    globalEnv,
  });
  const accountInitialSyncLimit = clampMatrixInitialSyncLimit(account.initialSyncLimit);
  const allowPrivateNetwork =
    isPrivateNetworkOptInEnabled(account) || isPrivateNetworkOptInEnabled(matrix)
      ? true
      : undefined;
  return {
    resolved: {
      homeserver: resolvedStrings.homeserver,
      userId: resolvedStrings.userId,
      accessToken: resolvedStrings.accessToken || undefined,
      password: resolvedStrings.password || undefined,
      deviceId: resolvedStrings.deviceId || undefined,
      deviceName: resolvedStrings.deviceName || undefined,
      initialSyncLimit:
        accountInitialSyncLimit ?? clampMatrixInitialSyncLimit(matrix.initialSyncLimit),
      encryption:
        typeof account.encryption === "boolean" ? account.encryption : (matrix.encryption ?? false),
      ...buildMatrixNetworkFields({
        allowPrivateNetwork,
        proxy: account.proxy ?? matrix.proxy,
      }),
    },
    authInputs: {
      accessToken: accessTokenCandidates.find((source) => source.value !== undefined),
      password: passwordCandidates.find((source) => source.value !== undefined),
    } satisfies MatrixAuthInputs,
  };
}

export function resolveMatrixConfigForAccount(
  cfg: CoreConfig,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): MatrixResolvedConfig {
  return resolveMatrixAccountConfigSnapshot(cfg, accountId, env).resolved;
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

type MatrixAuthContext = {
  cfg: CoreConfig;
  env: NodeJS.ProcessEnv;
  accountId: string;
  resolved: MatrixResolvedConfig;
};

function resolveMatrixAuthState(params: {
  cfg: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): { context: MatrixAuthContext; authInputs: MatrixAuthInputs } {
  const cfg = requireRuntimeConfig(params.cfg, "Matrix auth context") as CoreConfig;
  const env = params?.env ?? process.env;
  const requestedAccountId = params?.accountId?.trim();
  const explicitAccountId = normalizeOptionalAccountId(params?.accountId);
  if (requestedAccountId && !explicitAccountId) {
    throw new Error(`Matrix account id "${requestedAccountId}" is invalid.`);
  }
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
  const matrix = resolveMatrixBaseConfig(cfg);
  const account = findMatrixAccountConfig(cfg, effectiveAccountId);
  if (matrix.enabled === false || account?.enabled === false) {
    throw new Error(`Matrix account "${effectiveAccountId}" is disabled.`);
  }
  const snapshot = resolveMatrixAccountConfigSnapshot(cfg, effectiveAccountId, env);
  return {
    context: {
      cfg,
      env,
      accountId: effectiveAccountId,
      resolved: snapshot.resolved,
    },
    authInputs: snapshot.authInputs,
  };
}

export function resolveMatrixAuthContext(params: {
  cfg: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): MatrixAuthContext {
  return resolveMatrixAuthState(params).context;
}

export async function resolveMatrixAuth(params?: {
  cfg?: CoreConfig;
  env?: NodeJS.ProcessEnv;
  accountId?: string | null;
}): Promise<MatrixAuth> {
  if (!params?.cfg) {
    throw new Error(
      "Matrix auth requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const { context, authInputs } = resolveMatrixAuthState({
    cfg: params.cfg,
    env: params.env,
    accountId: params.accountId,
  });
  const { cfg, env, accountId, resolved } = context;
  const accessToken =
    (await resolveConfiguredMatrixAuthSecretInput({
      cfg,
      env,
      configured: authInputs.accessToken,
    })) ?? resolved.accessToken;
  const tokenAuthPassword = resolved.password;
  const homeserver = await resolveValidatedMatrixHomeserverUrl(resolved.homeserver, {
    dangerouslyAllowPrivateNetwork: resolved.allowPrivateNetwork,
  });
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
      const { saveMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
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
      const { touchMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
      await touchMatrixCredentials(env, accountId);
    }
    return buildResolvedMatrixAuth(resolved, {
      accountId,
      homeserver,
      userId,
      accessToken,
      password: tokenAuthPassword,
      deviceId: knownDeviceId,
    });
  }

  if (cachedCredentials) {
    const { touchMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
    await touchMatrixCredentials(env, accountId);
    return buildResolvedMatrixAuth(resolved, {
      accountId,
      homeserver: cachedCredentials.homeserver,
      userId: cachedCredentials.userId,
      accessToken: cachedCredentials.accessToken,
      password: tokenAuthPassword,
      deviceId: cachedCredentials.deviceId || resolved.deviceId,
    });
  }

  if (!resolved.userId) {
    throw new Error("Matrix userId is required when no access token is configured (matrix.userId)");
  }

  const password =
    (await resolveConfiguredMatrixAuthSecretInput({
      cfg,
      env,
      configured: authInputs.password,
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
  const login = await retryMatrixAuthRequest(
    "matrix auth login",
    async () =>
      (await loginClient.doRequest("POST", "/_matrix/client/v3/login", undefined, {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: resolved.userId },
        password,
        device_id: resolved.deviceId,
        initial_device_display_name: resolved.deviceName ?? "OpenClaw Gateway",
      })) as MatrixLoginResponse,
  );

  const loginAccessToken = login.access_token?.trim();
  if (!loginAccessToken) {
    throw new Error("Matrix login did not return an access token");
  }

  const auth = buildResolvedMatrixAuth(resolved, {
    accountId,
    homeserver,
    userId: login.user_id ?? resolved.userId,
    accessToken: loginAccessToken,
    password,
    deviceId: login.device_id ?? resolved.deviceId,
  });

  const { saveMatrixCredentials } = await loadMatrixCredentialsWriteRuntime();
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

  let whoami: Awaited<ReturnType<typeof fetchMatrixWhoamiIdentity>>;
  try {
    whoami = await fetchMatrixWhoamiIdentity({
      homeserver: params.auth.homeserver,
      accessToken: params.auth.accessToken,
      userId: params.auth.userId,
      ssrfPolicy: params.auth.ssrfPolicy,
      dispatcherPolicy: params.auth.dispatcherPolicy,
      signal: params.abortSignal,
    });
  } catch (err) {
    // An abort during whoami retry backoff rejects the backoff sleep; normalize
    // it to "no deviceId" like the post-whoami aborted checks below.
    if (isAbortSignalTriggered(params.abortSignal)) {
      return undefined;
    }
    throw err;
  }
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

  const credentialsWriter = await loadMatrixCredentialsWriteRuntime();
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

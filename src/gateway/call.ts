// Gateway RPC call helper.
// Builds a GatewayClient, resolves auth/scopes, and performs one request.
import { randomUUID } from "node:crypto";
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/version.js";
import { readGatewayDispatchConfig } from "../config/gateway-dispatch-config.js";
import {
  resolveConfigPath as resolveConfigPathFromPaths,
  resolveGatewayPort as resolveGatewayPortFromPaths,
  resolveStateDir as resolveStateDirFromPaths,
} from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { VERSION } from "../version.js";
import { resolveGatewayAuth } from "./auth-resolve.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import {
  GatewayClient,
  isGatewayConnectAssemblyError,
  type GatewayClientCloseInfo,
  type GatewayClientOptions,
  type GatewayClientRequestOptions,
} from "./client.js";
import {
  buildGatewayConnectionDetailsWithResolvers,
  type GatewayConnectionDetails,
} from "./connection-details.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import {
  trimToUndefined,
  type ExplicitGatewayAuth,
  type GatewayCredentialMode,
  type GatewayCredentialPrecedence,
  type GatewayRemoteCredentialFallback,
  type GatewayRemoteCredentialPrecedence,
} from "./credentials.js";
import { canSkipGatewayConfigLoad } from "./explicit-connection-policy.js";
import { resolvePreauthHandshakeTimeoutMs } from "./handshake-timeouts.js";
import {
  CLI_DEFAULT_OPERATOR_SCOPES,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "./method-scopes.js";
export type { GatewayConnectionDetails };

export type GatewayRequestFunction = <T = Record<string, unknown>>(
  method: string,
  params?: unknown,
  opts?: GatewayClientRequestOptions,
) => Promise<T>;

type CallGatewayBaseOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: OpenClawConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onAccepted?: GatewayClientRequestOptions["onAccepted"];
  onSignalAbort?: (request: GatewayRequestFunction) => Promise<void> | void;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  approvalRuntimeToken?: string;
  agentRuntimeIdentityToken?: string;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: OperatorScope[];
  requireLocalBackendSharedAuth?: boolean;
  deviceIdentity?: DeviceIdentity | null;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  requiredMethods?: string[];
  /**
   * Overrides the config path shown in connection error details.
   * Does not affect config loading; callers still control auth via opts.token/password/env/config.
   */
  configPath?: string;
  /**
   * Explicit local gateway port for command-line overrides such as `gateway health --port`.
   * Bypasses OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_PORT for this call only.
   */
  localPortOverride?: number;
  /** Keep a caller-supplied config target authoritative over OPENCLAW_GATEWAY_URL. */
  ignoreEnvUrlOverride?: boolean;
};

export type CallGatewayCliOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};

export type CallGatewayOptions = CallGatewayBaseOptions & {
  scopes?: OperatorScope[];
};

export type GatewayTransportErrorKind = "closed" | "timeout";

export class GatewayTransportError extends Error {
  readonly kind: GatewayTransportErrorKind;
  readonly connectionDetails: GatewayConnectionDetails;
  readonly code?: number;
  readonly reason?: string;
  readonly timeoutMs?: number;

  constructor(params: {
    kind: GatewayTransportErrorKind;
    message: string;
    connectionDetails: GatewayConnectionDetails;
    code?: number;
    reason?: string;
    timeoutMs?: number;
  }) {
    super(params.message);
    this.name = "GatewayTransportError";
    this.kind = params.kind;
    this.connectionDetails = params.connectionDetails;
    if (params.code !== undefined) {
      this.code = params.code;
    }
    if (params.reason !== undefined) {
      this.reason = params.reason;
    }
    if (params.timeoutMs !== undefined) {
      this.timeoutMs = params.timeoutMs;
    }
  }
}

export class GatewayCredentialsRequiredError extends Error {
  readonly method: string;
  readonly configPath: string;

  constructor(params: { method: string; configPath: string }) {
    super(
      [
        `gateway ${params.method} requires credentials before opening a websocket`,
        "Fix: configure gateway.auth token/password, pair this device, or pass --token/--password.",
        `Config: ${params.configPath}`,
      ].join("\n"),
    );
    this.name = "GatewayCredentialsRequiredError";
    this.method = params.method;
    this.configPath = params.configPath;
  }
}

export class GatewayExplicitAuthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayExplicitAuthRequiredError";
  }
}

export class GatewayStoredDeviceAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayStoredDeviceAuthUnavailableError";
  }
}

export class GatewayLocalBackendSharedAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayLocalBackendSharedAuthUnavailableError";
  }
}

export type GatewayTransportErrorJson = {
  ok: false;
  error: {
    type: "gateway_transport_error";
    kind: GatewayTransportErrorKind;
    message: string;
    code?: number;
    reason?: string;
    timeoutMs?: number;
  };
  gateway: {
    url: string;
    urlSource: string;
    bindDetail?: string;
    remoteFallbackNote?: string;
  };
};

export type GatewayClientRequestErrorJson = {
  ok: false;
  error: {
    type: "gateway_request_error";
    code: string;
    message: string;
    details?: unknown;
    retryable: boolean;
    retryAfterMs?: number;
  };
};

export type GatewayProbeConnectionDetails = GatewayConnectionDetails & {
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
};

function firstGatewayErrorLine(message: string): string {
  return message.split("\n", 1)[0]?.trim() || message;
}

export function formatGatewayTransportErrorJson(value: unknown): GatewayTransportErrorJson | null {
  if (!isGatewayTransportError(value)) {
    return null;
  }
  return {
    ok: false,
    error: {
      type: "gateway_transport_error",
      kind: value.kind,
      message: firstGatewayErrorLine(value.message),
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.reason !== undefined ? { reason: value.reason } : {}),
      ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
    },
    gateway: {
      url: redactSensitiveUrlLikeString(value.connectionDetails.url),
      urlSource: value.connectionDetails.urlSource,
      ...(value.connectionDetails.bindDetail
        ? { bindDetail: value.connectionDetails.bindDetail }
        : {}),
      ...(value.connectionDetails.remoteFallbackNote
        ? { remoteFallbackNote: value.connectionDetails.remoteFallbackNote }
        : {}),
    },
  };
}

export function formatGatewayClientRequestErrorJson(
  value: unknown,
): GatewayClientRequestErrorJson | null {
  if (!(value instanceof Error) || value.name !== "GatewayClientRequestError") {
    return null;
  }
  const requestError = value as Error & {
    gatewayCode?: unknown;
    details?: unknown;
    retryable?: unknown;
    retryAfterMs?: unknown;
  };
  if (
    typeof requestError.gatewayCode !== "string" ||
    requestError.gatewayCode.length === 0 ||
    requestError.message.length === 0 ||
    typeof requestError.retryable !== "boolean" ||
    (requestError.retryAfterMs !== undefined &&
      (typeof requestError.retryAfterMs !== "number" ||
        !Number.isInteger(requestError.retryAfterMs) ||
        requestError.retryAfterMs < 0))
  ) {
    return null;
  }
  return {
    ok: false,
    error: {
      type: "gateway_request_error",
      code: requestError.gatewayCode,
      message: requestError.message,
      ...(requestError.details !== undefined ? { details: requestError.details } : {}),
      retryable: requestError.retryable,
      ...(requestError.retryAfterMs !== undefined
        ? { retryAfterMs: requestError.retryAfterMs }
        : {}),
    },
  };
}

export function isGatewayTransportError(value: unknown): value is GatewayTransportError {
  if (value instanceof GatewayTransportError) {
    return true;
  }
  if (!(value instanceof Error) || value.name !== "GatewayTransportError") {
    return false;
  }
  const candidate = value as Partial<GatewayTransportError>;
  return (
    (candidate.kind === "closed" || candidate.kind === "timeout") &&
    typeof candidate.connectionDetails === "object" &&
    candidate.connectionDetails !== null
  );
}

export function isGatewayCredentialsRequiredError(
  value: unknown,
): value is GatewayCredentialsRequiredError {
  if (value instanceof GatewayCredentialsRequiredError) {
    return true;
  }
  if (!(value instanceof Error) || value.name !== "GatewayCredentialsRequiredError") {
    return false;
  }
  const candidate = value as Partial<GatewayCredentialsRequiredError>;
  return typeof candidate.method === "string" && typeof candidate.configPath === "string";
}

export function isGatewayExplicitAuthRequiredError(
  value: unknown,
): value is GatewayExplicitAuthRequiredError {
  return value instanceof Error && value.name === "GatewayExplicitAuthRequiredError";
}

const defaultCreateGatewayClient = (opts: GatewayClientOptions) => new GatewayClient(opts);
type GatewayRuntimeConfigLoader = () => OpenClawConfig | Promise<OpenClawConfig>;
const defaultGetRuntimeConfig = async (): Promise<OpenClawConfig> =>
  (await import("../config/io.js")).getRuntimeConfig();
const defaultGatewayCallDeps: {
  createGatewayClient: typeof defaultCreateGatewayClient;
  getRuntimeConfig: GatewayRuntimeConfigLoader;
  loadOrCreateDeviceIdentity: typeof loadOrCreateDeviceIdentity;
  resolveGatewayPort: typeof resolveGatewayPortFromPaths;
  resolveConfigPath: typeof resolveConfigPathFromPaths;
  resolveStateDir: typeof resolveStateDirFromPaths;
  loadGatewayTlsRuntime: typeof loadGatewayTlsRuntime;
  loadDeviceAuthToken: typeof loadDeviceAuthToken;
} = {
  createGatewayClient: defaultCreateGatewayClient,
  getRuntimeConfig: defaultGetRuntimeConfig,
  loadOrCreateDeviceIdentity,
  resolveGatewayPort: resolveGatewayPortFromPaths,
  resolveConfigPath: resolveConfigPathFromPaths,
  resolveStateDir: resolveStateDirFromPaths,
  loadGatewayTlsRuntime,
  loadDeviceAuthToken,
};
const gatewayCallDeps = {
  ...defaultGatewayCallDeps,
};

async function stopGatewayClient(client: GatewayClient): Promise<void> {
  try {
    await client.stopAndWait({ timeoutMs: 1_000 });
  } catch {
    client.stop();
  }
}

function resolveGatewayClientDisplayName(opts: CallGatewayBaseOptions): string | undefined {
  if (opts.clientDisplayName) {
    return opts.clientDisplayName;
  }
  const clientName = opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  const mode = opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
  if (mode !== GATEWAY_CLIENT_MODES.BACKEND && clientName !== GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT) {
    return undefined;
  }
  const method = opts.method.trim();
  return method ? `gateway:${method}` : "gateway:request";
}

async function loadGatewayConfig(): Promise<OpenClawConfig> {
  const loadConfigFn =
    typeof gatewayCallDeps.getRuntimeConfig === "function"
      ? gatewayCallDeps.getRuntimeConfig
      : typeof defaultGatewayCallDeps.getRuntimeConfig === "function"
        ? defaultGatewayCallDeps.getRuntimeConfig
        : defaultGetRuntimeConfig;
  return await loadConfigFn();
}

function loadGatewayConfigForConnectionDetails(): OpenClawConfig {
  if (
    gatewayCallDeps.getRuntimeConfig !== defaultGetRuntimeConfig &&
    typeof gatewayCallDeps.getRuntimeConfig === "function"
  ) {
    const config = gatewayCallDeps.getRuntimeConfig();
    if (config && typeof (config as Promise<OpenClawConfig>).then === "function") {
      throw new Error("async gateway config loader is not supported for connection details");
    }
    return config as OpenClawConfig;
  }
  return readGatewayDispatchConfig();
}

function resolveGatewayStateDir(env: NodeJS.ProcessEnv): string {
  const resolveStateDirFn =
    typeof gatewayCallDeps.resolveStateDir === "function"
      ? gatewayCallDeps.resolveStateDir
      : resolveStateDirFromPaths;
  return resolveStateDirFn(env);
}

function resolveGatewayConfigPath(env: NodeJS.ProcessEnv): string {
  const resolveConfigPathFn =
    typeof gatewayCallDeps.resolveConfigPath === "function"
      ? gatewayCallDeps.resolveConfigPath
      : resolveConfigPathFromPaths;
  return resolveConfigPathFn(env, resolveGatewayStateDir(env));
}

function resolveGatewayPortValue(config?: OpenClawConfig, env?: NodeJS.ProcessEnv): number {
  const resolveGatewayPortFn =
    typeof gatewayCallDeps.resolveGatewayPort === "function"
      ? gatewayCallDeps.resolveGatewayPort
      : resolveGatewayPortFromPaths;
  return resolveGatewayPortFn(config, env);
}

export function buildGatewayConnectionDetails(
  options: {
    config?: OpenClawConfig;
    url?: string;
    configPath?: string;
    urlSource?: "cli" | "env";
    ignoreEnvUrlOverride?: boolean;
    localPortOverride?: number;
  } = {},
): GatewayConnectionDetails {
  return buildGatewayConnectionDetailsWithResolvers(options, {
    getRuntimeConfig: () => loadGatewayConfigForConnectionDetails(),
    resolveConfigPath: (env) => resolveGatewayConfigPath(env),
    resolveGatewayPort: (config, env) => resolveGatewayPortValue(config, env),
  });
}

export const testing = {
  setDepsForTests(deps: Partial<typeof defaultGatewayCallDeps> | undefined): void {
    gatewayCallDeps.createGatewayClient =
      deps?.createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
    gatewayCallDeps.getRuntimeConfig =
      deps?.getRuntimeConfig ?? defaultGatewayCallDeps.getRuntimeConfig;
    gatewayCallDeps.loadOrCreateDeviceIdentity =
      deps?.loadOrCreateDeviceIdentity ?? defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
    gatewayCallDeps.resolveGatewayPort =
      deps?.resolveGatewayPort ?? defaultGatewayCallDeps.resolveGatewayPort;
    gatewayCallDeps.resolveConfigPath =
      deps?.resolveConfigPath ?? defaultGatewayCallDeps.resolveConfigPath;
    gatewayCallDeps.resolveStateDir =
      deps?.resolveStateDir ?? defaultGatewayCallDeps.resolveStateDir;
    gatewayCallDeps.loadGatewayTlsRuntime =
      deps?.loadGatewayTlsRuntime ?? defaultGatewayCallDeps.loadGatewayTlsRuntime;
    gatewayCallDeps.loadDeviceAuthToken =
      deps?.loadDeviceAuthToken ?? defaultGatewayCallDeps.loadDeviceAuthToken;
  },
  resetDepsForTests(): void {
    gatewayCallDeps.createGatewayClient = defaultGatewayCallDeps.createGatewayClient;
    gatewayCallDeps.getRuntimeConfig = defaultGatewayCallDeps.getRuntimeConfig;
    gatewayCallDeps.loadOrCreateDeviceIdentity = defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
    gatewayCallDeps.resolveGatewayPort = defaultGatewayCallDeps.resolveGatewayPort;
    gatewayCallDeps.resolveConfigPath = defaultGatewayCallDeps.resolveConfigPath;
    gatewayCallDeps.resolveStateDir = defaultGatewayCallDeps.resolveStateDir;
    gatewayCallDeps.loadGatewayTlsRuntime = defaultGatewayCallDeps.loadGatewayTlsRuntime;
    gatewayCallDeps.loadDeviceAuthToken = defaultGatewayCallDeps.loadDeviceAuthToken;
  },
};

function isLoopbackGatewayUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const unbracketed =
      hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
  } catch {
    return false;
  }
}

function shouldOmitDeviceIdentityForGatewayCall(params: {
  opts: CallGatewayBaseOptions;
  url: string;
  authMode: ReturnType<typeof resolveGatewayAuth>["mode"];
  token?: string;
  password?: string;
  allowAuthNone?: boolean;
}): boolean {
  const mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
  const clientName = params.opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  // Inactive ambient credentials must not turn an auth-none CLI call device-less.
  // Omit identity only when the Gateway will actually authenticate the supplied secret.
  const hasSharedSecretAuth =
    (params.authMode === "token" && Boolean(params.token)) ||
    (params.authMode === "password" && Boolean(params.password));
  const isLoopback = isLoopbackGatewayUrl(params.url);
  const isLocalBackendSharedAuth =
    mode === GATEWAY_CLIENT_MODES.BACKEND &&
    clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT &&
    (hasSharedSecretAuth || params.allowAuthNone === true) &&
    isLoopback;
  const isLocalCliSharedAuth =
    mode === GATEWAY_CLIENT_MODES.CLI &&
    clientName === GATEWAY_CLIENT_NAMES.CLI &&
    hasSharedSecretAuth &&
    isLoopback;
  return isLocalBackendSharedAuth || isLocalCliSharedAuth;
}

function resolveDeviceIdentityForGatewayCall(): DeviceIdentity | null {
  try {
    return gatewayCallDeps.loadOrCreateDeviceIdentity();
  } catch {
    // Read-only or restricted environments should still be able to call the
    // gateway with token/password auth without crashing before the RPC.
    return null;
  }
}

function loadStoredOperatorDeviceAuthToken(
  deviceIdentity: DeviceIdentity | null,
): DeviceAuthEntry | null {
  if (!deviceIdentity) {
    return null;
  }
  try {
    return gatewayCallDeps.loadDeviceAuthToken({
      deviceId: deviceIdentity.deviceId,
      role: "operator",
      env: process.env,
    });
  } catch {
    return null;
  }
}

function hasStoredOperatorDeviceAuthToken(deviceIdentity: DeviceIdentity | null): boolean {
  return Boolean(loadStoredOperatorDeviceAuthToken(deviceIdentity)?.token);
}

function resolveGatewayCallAuth(config: OpenClawConfig) {
  return resolveGatewayAuth({
    authConfig: config.gateway?.auth,
    env: process.env,
    tailscaleMode: config.gateway?.tailscale?.mode,
  });
}

function ensureGatewayCallCanAuthenticate(params: {
  opts: CallGatewayBaseOptions;
  context: ResolvedGatewayCallContext;
  token?: string;
  password?: string;
  deviceIdentity: DeviceIdentity | null;
}): void {
  const resolvedAuth = resolveGatewayCallAuth(params.context.config);
  const authMode = resolvedAuth.mode;
  if (authMode !== "token" && authMode !== "password") {
    return;
  }
  if (params.token || params.password || params.opts.approvalRuntimeToken) {
    return;
  }
  if (resolvedAuth.allowTailscale) {
    return;
  }
  if (hasStoredOperatorDeviceAuthToken(params.deviceIdentity)) {
    return;
  }
  throw new GatewayCredentialsRequiredError({
    method: params.opts.method,
    configPath: params.context.configPath,
  });
}

export type { ExplicitGatewayAuth } from "./credentials.js";

export function resolveExplicitGatewayAuth(opts?: ExplicitGatewayAuth): ExplicitGatewayAuth {
  const token =
    typeof opts?.token === "string" && opts.token.trim().length > 0 ? opts.token.trim() : undefined;
  const password =
    typeof opts?.password === "string" && opts.password.trim().length > 0
      ? opts.password.trim()
      : undefined;
  return { token, password };
}

export function ensureExplicitGatewayAuth(params: {
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  explicitAuth?: ExplicitGatewayAuth;
  resolvedAuth?: ExplicitGatewayAuth;
  errorHint: string;
  configPath?: string;
}): void {
  if (!params.urlOverride) {
    return;
  }
  // URL overrides are untrusted redirects and can move WebSocket traffic off the intended host.
  // Never allow an override to silently reuse implicit credentials or device token fallback.
  const explicitToken = params.explicitAuth?.token;
  const explicitPassword = params.explicitAuth?.password;
  if (params.urlOverrideSource === "cli" && (explicitToken || explicitPassword)) {
    return;
  }
  const hasResolvedAuth =
    params.resolvedAuth?.token ||
    params.resolvedAuth?.password ||
    explicitToken ||
    explicitPassword;
  // Env overrides are supported for deployment ergonomics, but only when explicit auth is available.
  // This avoids implicit device-token fallback against attacker-controlled WSS endpoints.
  if (params.urlOverrideSource === "env" && hasResolvedAuth) {
    return;
  }
  const sourceHint =
    params.urlOverrideSource === "env"
      ? "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD alongside OPENCLAW_GATEWAY_URL; config credentials are intentionally not reused."
      : params.urlOverrideSource === "cli"
        ? "For the default local or SSH-tunneled Gateway, remove --url to use the configured target."
        : undefined;
  const message = [
    "gateway url override requires explicit credentials",
    params.errorHint,
    sourceHint,
    params.configPath ? `Config: ${params.configPath}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  throw new GatewayExplicitAuthRequiredError(message);
}

type GatewayRemoteSettings = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

type ResolvedGatewayCallContext = {
  config: OpenClawConfig;
  configPath: string;
  isRemoteMode: boolean;
  remote?: GatewayRemoteSettings;
  urlOverride?: string;
  urlOverrideSource?: "cli" | "env";
  remoteUrl?: string;
  explicitAuth: ExplicitGatewayAuth;
  modeOverride?: GatewayCredentialMode;
  localTokenPrecedence?: GatewayCredentialPrecedence;
  localPasswordPrecedence?: GatewayCredentialPrecedence;
  remoteTokenPrecedence?: GatewayRemoteCredentialPrecedence;
  remotePasswordPrecedence?: GatewayRemoteCredentialPrecedence;
  remoteTokenFallback?: GatewayRemoteCredentialFallback;
  remotePasswordFallback?: GatewayRemoteCredentialFallback;
};

function resolveGatewayCallTimeout(
  timeoutValue: unknown,
  configuredHandshakeTimeoutMs?: number | null,
): {
  timeoutMs: number | null;
  startupTimeoutMs: number;
  safeTimerTimeoutMs: number;
} {
  const hasConfiguredHandshakeTimeout =
    typeof configuredHandshakeTimeoutMs === "number" &&
    Number.isFinite(configuredHandshakeTimeoutMs) &&
    configuredHandshakeTimeoutMs > 0;
  const hasEnvHandshakeTimeout =
    Boolean(process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS) ||
    Boolean(process.env.VITEST && process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
  const resolvedHandshakeTimeoutMs =
    hasConfiguredHandshakeTimeout || hasEnvHandshakeTimeout
      ? resolvePreauthHandshakeTimeoutMs({ configuredTimeoutMs: configuredHandshakeTimeoutMs })
      : undefined;
  const defaultTimeoutMs =
    typeof resolvedHandshakeTimeoutMs === "number" && resolvedHandshakeTimeoutMs > 10_000
      ? resolvedHandshakeTimeoutMs
      : 10_000;
  const explicitTimeoutMs =
    typeof timeoutValue === "number" && Number.isFinite(timeoutValue) ? timeoutValue : undefined;
  const startupTimeoutMs = explicitTimeoutMs ?? defaultTimeoutMs;
  const timeoutMs = timeoutValue === null ? null : (explicitTimeoutMs ?? defaultTimeoutMs);
  const safeTimerTimeoutMs = resolveSafeTimeoutDelayMs(timeoutMs ?? startupTimeoutMs);
  return { timeoutMs, startupTimeoutMs, safeTimerTimeoutMs };
}

async function resolveGatewayCallContext(
  opts: CallGatewayBaseOptions,
): Promise<ResolvedGatewayCallContext> {
  const cliUrlOverride = trimToUndefined(opts.url);
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const envUrlOverride =
    cliUrlOverride || opts.localPortOverride !== undefined || opts.ignoreEnvUrlOverride === true
      ? undefined
      : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined;
  const canSkipConfigLoad = canSkipGatewayConfigLoad({
    config: opts.config,
    urlOverride,
    explicitAuth,
  });
  const config =
    opts.config ?? (canSkipConfigLoad ? ({} as OpenClawConfig) : await loadGatewayConfig());
  const configPath = opts.configPath ?? resolveGatewayConfigPath(process.env);
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = isRemoteMode
    ? (config.gateway?.remote as GatewayRemoteSettings | undefined)
    : undefined;
  const remoteUrl = trimToUndefined(remote?.url);
  return {
    config,
    configPath,
    isRemoteMode,
    remote,
    urlOverride,
    urlOverrideSource,
    remoteUrl,
    explicitAuth,
  };
}

function ensureRemoteModeUrlConfigured(context: ResolvedGatewayCallContext): void {
  if (!context.isRemoteMode || context.urlOverride || context.remoteUrl) {
    return;
  }
  throw new Error(
    [
      "gateway remote mode misconfigured: gateway.remote.url missing",
      `Config: ${context.configPath}`,
      "Fix: set gateway.remote.url, or set gateway.mode=local.",
    ].join("\n"),
  );
}

async function resolveGatewayCredentials(context: ResolvedGatewayCallContext): Promise<{
  token?: string;
  password?: string;
}> {
  return resolveGatewayCredentialsWithEnv(context, process.env);
}

async function resolveGatewayCredentialsWithEnv(
  context: ResolvedGatewayCallContext,
  env: NodeJS.ProcessEnv,
): Promise<{
  token?: string;
  password?: string;
}> {
  if (context.explicitAuth.token || context.explicitAuth.password) {
    return {
      token: context.explicitAuth.token,
      password: context.explicitAuth.password,
    };
  }
  return resolveGatewayCredentialsWithSecretInputs({
    config: context.config,
    explicitAuth: context.explicitAuth,
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    env,
    modeOverride: context.modeOverride,
    localTokenPrecedence: context.localTokenPrecedence,
    localPasswordPrecedence: context.localPasswordPrecedence,
    remoteTokenPrecedence: context.remoteTokenPrecedence,
    remotePasswordPrecedence: context.remotePasswordPrecedence,
    remoteTokenFallback: context.remoteTokenFallback,
    remotePasswordFallback: context.remotePasswordFallback,
  });
}

export { resolveGatewayCredentialsWithSecretInputs };

async function resolveGatewayTlsFingerprint(params: {
  opts: CallGatewayBaseOptions;
  context: ResolvedGatewayCallContext;
  url: string;
}): Promise<string | undefined> {
  const { opts, context, url } = params;
  const useLocalTls =
    context.config.gateway?.tls?.enabled === true &&
    !context.urlOverrideSource &&
    !context.remoteUrl &&
    url.startsWith("wss://");
  const tlsRuntime = useLocalTls
    ? await gatewayCallDeps.loadGatewayTlsRuntime(context.config.gateway?.tls)
    : undefined;
  const overrideTlsFingerprint = trimToUndefined(opts.tlsFingerprint);
  const remoteTlsFingerprint =
    // Env overrides may still inherit configured remote TLS pinning for private cert deployments.
    // CLI overrides remain explicit-only and intentionally skip config remote TLS to avoid
    // accidentally pinning against caller-supplied target URLs.
    context.isRemoteMode && context.urlOverrideSource !== "cli"
      ? trimToUndefined(context.remote?.tlsFingerprint)
      : undefined;
  return (
    overrideTlsFingerprint ||
    remoteTlsFingerprint ||
    (tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined)
  );
}

function formatGatewayCloseError(
  code: number,
  reason: string,
  connectionDetails: GatewayConnectionDetails,
): string {
  const reasonText = normalizeOptionalString(reason) || "no close reason";
  const hint =
    code === 1006 ? "abnormal closure (no close frame)" : code === 1000 ? "normal closure" : "";
  const suffix = hint ? ` ${hint}` : "";
  let message = `gateway closed (${code}${suffix}): ${reasonText}\n${connectionDetails.message}`;
  // Add troubleshooting hints for common issues
  if (code === 1006) {
    message +=
      "\n\nPossible causes:" +
      "\n- Connection dropped without a close frame (retry; check network and gateway load)" +
      "\n- Gateway not yet ready to accept connections (retry after a moment)" +
      "\n- TLS mismatch (connecting with ws:// to a wss:// gateway, or vice versa)" +
      "\n- Gateway process stopped or became unreachable (confirm it is still running)" +
      "\nRun `openclaw doctor` for diagnostics.";
  }
  return message;
}

function formatGatewayTimeoutError(
  timeoutMs: number,
  connectionDetails: GatewayConnectionDetails,
): string {
  return `gateway timeout after ${timeoutMs}ms\n${connectionDetails.message}`;
}

function createGatewayCloseTransportError(params: {
  code: number;
  reason: string;
  connectionDetails: GatewayConnectionDetails;
}): GatewayTransportError {
  const reasonText = normalizeOptionalString(params.reason) || "no close reason";
  return new GatewayTransportError({
    kind: "closed",
    code: params.code,
    reason: reasonText,
    connectionDetails: params.connectionDetails,
    message: formatGatewayCloseError(params.code, params.reason, params.connectionDetails),
  });
}

function createGatewayTimeoutTransportError(params: {
  timeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
}): GatewayTransportError {
  return new GatewayTransportError({
    kind: "timeout",
    timeoutMs: params.timeoutMs,
    connectionDetails: params.connectionDetails,
    message: formatGatewayTimeoutError(params.timeoutMs, params.connectionDetails),
  });
}

function createGatewayRequestAbortError(method: string): Error {
  return createAbortError(`gateway request aborted for ${method}`);
}

function ensureGatewaySupportsRequiredMethods(params: {
  requiredMethods: string[] | undefined;
  methods: string[] | undefined;
  attemptedMethod: string;
}): void {
  const requiredMethods = Array.isArray(params.requiredMethods)
    ? params.requiredMethods.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
  if (requiredMethods.length === 0) {
    return;
  }
  const supportedMethods = new Set(
    (Array.isArray(params.methods) ? params.methods : [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  for (const method of requiredMethods) {
    if (supportedMethods.has(method)) {
      continue;
    }
    throw new Error(
      [
        `active gateway does not support required method "${method}" for "${params.attemptedMethod}".`,
        "Update the gateway or run without SecretRefs.",
      ].join(" "),
    );
  }
}

function isRequiredAgentRuntimeIdentityConnectError(err: Error): boolean {
  return err.message.includes(
    "gateway rejected required agent runtime identity auth field; refusing to retry without it",
  );
}

async function executeGatewayRequestWithScopes<T>(params: {
  opts: CallGatewayBaseOptions;
  scopes: OperatorScope[] | undefined;
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
  timeoutMs: number | null;
  startupTimeoutMs: number;
  safeTimerTimeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
  deviceIdentity: DeviceIdentity | null;
  surfaceGatewayClientRequestErrors: boolean;
}): Promise<T> {
  const {
    opts,
    scopes,
    url,
    token,
    password,
    tlsFingerprint,
    preauthHandshakeTimeoutMs,
    timeoutMs,
    startupTimeoutMs,
    safeTimerTimeoutMs,
    deviceIdentity,
    surfaceGatewayClientRequestErrors,
  } = params;
  return await new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(createGatewayRequestAbortError(opts.method));
      return;
    }
    let settled = false;
    let ignoreClose = false;
    let timer: NodeJS.Timeout | undefined;
    const startAbort = new AbortController();
    let primaryRequestStarted = false;
    let suppressedPreHelloCleanCloses = 0;
    const cleanup = () => {
      startAbort.abort();
      if (abortHandler) {
        opts.signal?.removeEventListener("abort", abortHandler);
      }
      if (timer) {
        clearTimeout(timer);
      }
    };
    const stopClientThenSettle = (
      activeClient: GatewayClient | undefined,
      err?: Error,
      value?: T,
    ) => {
      const complete = () => {
        if (err) {
          reject(err);
        } else {
          resolve(value as T);
        }
      };
      if (!activeClient) {
        complete();
        return;
      }
      void stopGatewayClient(activeClient).finally(complete);
    };
    const stop = (err?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      stopClientThenSettle(client, err, value);
    };
    const abortHandler: (() => void) | undefined = () => {
      if (settled) {
        return;
      }
      ignoreClose = true;
      settled = true;
      cleanup();
      const err = createGatewayRequestAbortError(opts.method);
      const activeClient = client;
      const stopAfterAbortHook = () => stopClientThenSettle(activeClient, err);
      if (!activeClient || !opts.onSignalAbort || !primaryRequestStarted) {
        stopAfterAbortHook();
        return;
      }
      const request: GatewayRequestFunction = activeClient.request.bind(activeClient);
      void Promise.resolve()
        .then(() => opts.onSignalAbort?.(request))
        .catch(() => {})
        .finally(stopAfterAbortHook);
    };
    opts.signal?.addEventListener("abort", abortHandler, { once: true });

    const client: GatewayClient | undefined = gatewayCallDeps.createGatewayClient({
      url,
      token,
      password,
      tlsFingerprint,
      preauthHandshakeTimeoutMs,
      instanceId: opts.instanceId ?? randomUUID(),
      clientName: opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: resolveGatewayClientDisplayName(opts),
      clientVersion: opts.clientVersion ?? VERSION,
      platform: opts.platform,
      mode: opts.mode ?? GATEWAY_CLIENT_MODES.CLI,
      ...(opts.approvalRuntimeToken ? { approvalRuntimeToken: opts.approvalRuntimeToken } : {}),
      ...(opts.agentRuntimeIdentityToken
        ? { agentRuntimeIdentityToken: opts.agentRuntimeIdentityToken }
        : {}),
      role: "operator",
      ...(Array.isArray(scopes) ? { scopes } : {}),
      deviceIdentity,
      minProtocol: opts.minProtocol ?? MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      onHelloOk: (hello) => {
        if (timeoutMs === null && timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        void (async () => {
          try {
            ensureGatewaySupportsRequiredMethods({
              requiredMethods: opts.requiredMethods,
              methods: hello.features?.methods,
              attemptedMethod: opts.method,
            });
            const activeClient = client;
            if (!activeClient) {
              throw new Error("gateway client not initialized");
            }
            primaryRequestStarted = true;
            const result = await activeClient.request<T>(opts.method, opts.params, {
              expectFinal: opts.expectFinal,
              timeoutMs: opts.timeoutMs,
              signal: opts.signal,
              onAccepted: opts.onAccepted,
            });
            ignoreClose = true;
            stop(undefined, result);
          } catch (err) {
            ignoreClose = true;
            stop(err as Error);
          }
        })();
      },
      onClose: (code, reason, info?: GatewayClientCloseInfo) => {
        if (settled || ignoreClose) {
          return;
        }
        if (
          !primaryRequestStarted &&
          info?.transientPreHelloCleanClose === true &&
          suppressedPreHelloCleanCloses < 1
        ) {
          suppressedPreHelloCleanCloses += 1;
          return;
        }
        ignoreClose = true;
        stop(
          createGatewayCloseTransportError({
            code,
            reason,
            connectionDetails: params.connectionDetails,
          }),
        );
      },
      onConnectError: (err) => {
        const isGatewayClientRequestError = err.name === "GatewayClientRequestError";
        const isAgentRuntimeIdentityConnectError =
          Boolean(opts.agentRuntimeIdentityToken) &&
          isRequiredAgentRuntimeIdentityConnectError(err);
        const shouldSurface =
          isGatewayConnectAssemblyError(err) ||
          isAgentRuntimeIdentityConnectError ||
          (surfaceGatewayClientRequestErrors && isGatewayClientRequestError);
        if (settled || !shouldSurface) {
          return;
        }
        ignoreClose = true;
        stop(err);
      },
    });

    const wrapperTimeoutMs = timeoutMs ?? startupTimeoutMs;
    timer = setTimeout(() => {
      ignoreClose = true;
      stop(
        createGatewayTimeoutTransportError({
          timeoutMs: wrapperTimeoutMs,
          connectionDetails: params.connectionDetails,
        }),
      );
    }, safeTimerTimeoutMs);

    void startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: safeTimerTimeoutMs,
      signal: startAbort.signal,
    })
      .then((readiness) => {
        if (settled || readiness.ready || readiness.aborted) {
          return;
        }
        ignoreClose = true;
        stop(
          createGatewayTimeoutTransportError({
            timeoutMs: startupTimeoutMs,
            connectionDetails: params.connectionDetails,
          }),
        );
      })
      .catch((err: unknown) => {
        if (settled) {
          return;
        }
        ignoreClose = true;
        stop(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

async function callGatewayWithScopes<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[] | undefined,
): Promise<T> {
  const context = await resolveGatewayCallContext(opts);
  const { timeoutMs, startupTimeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(
    opts.timeoutMs,
    context.config.gateway?.handshakeTimeoutMs,
  );
  if (opts.requireLocalBackendSharedAuth && (context.urlOverride || context.isRemoteMode)) {
    throw new GatewayLocalBackendSharedAuthUnavailableError(
      "local backend shared auth is limited to the configured local gateway",
    );
  }
  const useStoredDeviceAuth = opts.useStoredDeviceAuth === true;
  if (
    useStoredDeviceAuth &&
    (context.urlOverride ||
      context.explicitAuth.token ||
      context.explicitAuth.password ||
      context.isRemoteMode)
  ) {
    throw new GatewayStoredDeviceAuthUnavailableError(
      "stored device auth is limited to the configured local gateway",
    );
  }
  const resolvedCredentials = useStoredDeviceAuth ? {} : await resolveGatewayCredentials(context);
  ensureExplicitGatewayAuth({
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    explicitAuth: context.explicitAuth,
    resolvedAuth: resolvedCredentials,
    errorHint: "Fix: pass --token or --password with --url (or gatewayToken in tools).",
    configPath: context.configPath,
  });
  ensureRemoteModeUrlConfigured(context);
  const connectionDetails = buildGatewayConnectionDetails({
    config: context.config,
    url: context.urlOverride,
    urlSource: context.urlOverrideSource,
    ignoreEnvUrlOverride:
      opts.localPortOverride !== undefined || opts.ignoreEnvUrlOverride === true,
    localPortOverride: opts.localPortOverride,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const url = connectionDetails.url;
  const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
  const token = useStoredDeviceAuth ? undefined : resolvedCredentials.token;
  const password = useStoredDeviceAuth ? undefined : resolvedCredentials.password;
  const authMode = resolveGatewayCallAuth(context.config).mode;
  const allowAuthNone = opts.requireLocalBackendSharedAuth === true && authMode === "none";
  const omitDeviceIdentity = shouldOmitDeviceIdentityForGatewayCall({
    opts,
    url,
    authMode,
    token,
    password,
    allowAuthNone,
  });
  if (opts.requireLocalBackendSharedAuth && !omitDeviceIdentity) {
    throw new GatewayLocalBackendSharedAuthUnavailableError(
      "local backend shared auth requires a loopback gateway with token/password credentials or auth mode none",
    );
  }
  const deviceIdentity =
    opts.deviceIdentity === undefined
      ? omitDeviceIdentity
        ? null
        : resolveDeviceIdentityForGatewayCall()
      : opts.deviceIdentity;
  if (useStoredDeviceAuth) {
    const storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity);
    if (!storedAuth?.token) {
      throw new GatewayCredentialsRequiredError({
        method: opts.method,
        configPath: context.configPath,
      });
    }
    if (
      Array.isArray(opts.requiredStoredDeviceAuthScopes) &&
      !roleScopesAllow({
        role: "operator",
        requestedScopes: opts.requiredStoredDeviceAuthScopes,
        allowedScopes: storedAuth.scopes,
      })
    ) {
      throw new GatewayStoredDeviceAuthUnavailableError(
        "stored device auth does not grant the required operator scopes",
      );
    }
  }
  ensureGatewayCallCanAuthenticate({
    opts,
    context,
    token,
    password,
    deviceIdentity,
  });
  return await executeGatewayRequestWithScopes<T>({
    opts,
    scopes: useStoredDeviceAuth ? undefined : scopes,
    url,
    token,
    password,
    tlsFingerprint,
    preauthHandshakeTimeoutMs: context.config.gateway?.handshakeTimeoutMs,
    timeoutMs,
    startupTimeoutMs,
    safeTimerTimeoutMs,
    connectionDetails,
    deviceIdentity,
    surfaceGatewayClientRequestErrors:
      useStoredDeviceAuth ||
      opts.requireLocalBackendSharedAuth === true ||
      Boolean(opts.agentRuntimeIdentityToken),
  });
}

export async function buildGatewayProbeConnectionDetails(
  opts: Pick<
    CallGatewayBaseOptions,
    | "config"
    | "configPath"
    | "ignoreEnvUrlOverride"
    | "localPortOverride"
    | "password"
    | "tlsFingerprint"
    | "token"
    | "url"
  > = {},
): Promise<GatewayProbeConnectionDetails> {
  const callOpts = {
    ...opts,
    method: "status",
  } satisfies CallGatewayBaseOptions;
  const context = await resolveGatewayCallContext(callOpts);
  ensureRemoteModeUrlConfigured(context);
  const connectionDetails = buildGatewayConnectionDetails({
    config: context.config,
    url: context.urlOverride,
    urlSource: context.urlOverrideSource,
    ignoreEnvUrlOverride:
      opts.localPortOverride !== undefined || opts.ignoreEnvUrlOverride === true,
    localPortOverride: opts.localPortOverride,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const tlsFingerprint = await resolveGatewayTlsFingerprint({
    opts: callOpts,
    context,
    url: connectionDetails.url,
  });
  return {
    ...connectionDetails,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    ...(context.config.gateway?.handshakeTimeoutMs
      ? { preauthHandshakeTimeoutMs: context.config.gateway.handshakeTimeoutMs }
      : {}),
  };
}

export async function callGatewayCli<T = Record<string, unknown>>(
  opts: CallGatewayCliOptions,
): Promise<T> {
  const scopes = Array.isArray(opts.scopes)
    ? opts.scopes
    : isGatewayMethodClassified(opts.method)
      ? resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params)
      : CLI_DEFAULT_OPERATOR_SCOPES;
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params);
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGateway<T = Record<string, unknown>>(
  opts: CallGatewayOptions,
): Promise<T> {
  const callerMode = opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
  const callerName = opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
  if (callerMode === GATEWAY_CLIENT_MODES.CLI || callerName === GATEWAY_CLIENT_NAMES.CLI) {
    return await callGatewayCli(opts);
  }
  if (Array.isArray(opts.scopes)) {
    return await callGatewayWithScopes(
      {
        ...opts,
        mode: callerMode,
        clientName: callerName,
      },
      opts.scopes,
    );
  }
  return await callGatewayLeastPrivilege({
    ...opts,
    mode: callerMode,
    clientName: callerName,
  });
}

export function randomIdempotencyKey() {
  return randomUUID();
}
export { testing as __testing };

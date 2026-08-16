// Gateway RPC call helper.
// Builds a GatewayClient, resolves auth/scopes, and performs one request.
import { randomUUID } from "node:crypto";
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { readMissingScopeErrorDetails } from "../../packages/gateway-protocol/src/gateway-error-details.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../packages/gateway-protocol/src/version.js";
import {
  readGatewayDispatchConfig,
  readGatewayDispatchConfigWithShellEnvFallback,
} from "../config/gateway-dispatch-config.js";
import {
  resolveConfigPath as resolveConfigPathFromPaths,
  resolveGatewayPort as resolveGatewayPortFromPaths,
  resolveStateDir as resolveStateDirFromPaths,
} from "../config/paths.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import { loadDeviceAuthToken, loadOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { VERSION } from "../version.js";
import { resolveGatewayAuth } from "./auth-resolve.js";
import {
  ensureExplicitGatewayAuth,
  GatewayExplicitAuthRequiredError,
  resolveGatewayClientBootstrap,
  resolveGatewayUrlOverride,
} from "./client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import {
  GatewayClient,
  isGatewayConnectAssemblyError,
  type GatewayClientCloseInfo,
  type GatewayClientRequestOptions,
} from "./client.js";
import {
  buildGatewayConnectionDetailsWithResolvers,
  projectGatewayConnectionDetailsForDiagnostics,
  type GatewayConnectionDetails,
} from "./connection-details.js";
import {
  isGatewaySecretRefUnavailableError,
  resolveExplicitGatewayAuth,
  trimToUndefined,
  type ExplicitGatewayAuth,
} from "./credentials.js";
import { canSkipGatewayConfigLoad } from "./explicit-connection-policy.js";
import { resolvePreauthHandshakeTimeoutMs } from "./handshake-timeouts.js";
import {
  CLI_DEFAULT_OPERATOR_SCOPES,
  ADMIN_SCOPE,
  WRITE_SCOPE,
  isGatewayMethodClassified,
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "./method-scopes.js";
import { resolveGatewayConnectionTlsFingerprint } from "./tls-fingerprint.js";
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
  requiredCapabilities?: string[];
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

export { GatewayExplicitAuthRequiredError } from "./client-bootstrap.js";

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

export type GatewayAuthErrorJson = {
  ok: false;
  error: {
    type: "gateway_credentials_required";
    message: string;
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
  const connectionDetails = projectGatewayConnectionDetailsForDiagnostics(value.connectionDetails);
  return {
    ok: false,
    error: {
      type: "gateway_transport_error",
      kind: value.kind,
      // The message embeds the remote-controlled close reason, which can echo a
      // credential-bearing URL; redact both before they reach CLI JSON output.
      message: redactSensitiveUrlLikeString(firstGatewayErrorLine(value.message)),
      ...(value.code !== undefined ? { code: value.code } : {}),
      ...(value.reason !== undefined ? { reason: redactSensitiveUrlLikeString(value.reason) } : {}),
      ...(value.timeoutMs !== undefined ? { timeoutMs: value.timeoutMs } : {}),
    },
    gateway: {
      url: connectionDetails.url,
      urlSource: connectionDetails.urlSource,
      ...(connectionDetails.bindDetail ? { bindDetail: connectionDetails.bindDetail } : {}),
      ...(connectionDetails.remoteFallbackNote
        ? { remoteFallbackNote: connectionDetails.remoteFallbackNote }
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

/** Preserve machine-readable output for auth failures raised before transport startup. */
export function formatGatewayAuthErrorJson(value: unknown): GatewayAuthErrorJson | null {
  if (
    !isGatewayCredentialsRequiredError(value) &&
    !isGatewayExplicitAuthRequiredError(value) &&
    !isGatewaySecretRefUnavailableError(value)
  ) {
    return null;
  }
  return {
    ok: false,
    error: {
      type: "gateway_credentials_required",
      message: value.message,
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

// Gateway dispatch owns only connection, auth, TLS, and shell-env resolution.
// Loading the full runtime config here makes every RPC pay unrelated plugin/state startup costs.
const defaultGetRuntimeConfig = async (): Promise<OpenClawConfig> =>
  getRuntimeConfigSnapshot() ?? (await readGatewayDispatchConfigWithShellEnvFallback());

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
  return await defaultGetRuntimeConfig();
}

function loadGatewayConfigForConnectionDetails(): OpenClawConfig {
  return readGatewayDispatchConfig();
}

function resolveGatewayStateDir(env: NodeJS.ProcessEnv): string {
  return resolveStateDirFromPaths(env);
}

function resolveGatewayConfigPath(env: NodeJS.ProcessEnv): string {
  return resolveConfigPathFromPaths(env, resolveGatewayStateDir(env));
}

function resolveGatewayPortValue(config?: OpenClawConfig, env?: NodeJS.ProcessEnv): number {
  return resolveGatewayPortFromPaths(config, env);
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
    return loadOrCreateDeviceIdentity();
  } catch {
    // Read-only or restricted environments should still be able to call the
    // gateway with token/password auth without crashing before the RPC.
    return null;
  }
}

function loadStoredOperatorDeviceAuthToken(
  deviceIdentity: DeviceIdentity | null,
  deviceAuthScope?: string,
): DeviceAuthEntry | null {
  if (!deviceIdentity) {
    return null;
  }
  try {
    if (deviceAuthScope) {
      return loadOriginDeviceToken({
        gatewayScope: deviceAuthScope,
        deviceId: deviceIdentity.deviceId,
        role: "operator",
        env: process.env,
      });
    }
    return loadDeviceAuthToken({
      deviceId: deviceIdentity.deviceId,
      role: "operator",
      env: process.env,
    });
  } catch {
    return null;
  }
}

function hasStoredOperatorDeviceAuthToken(
  deviceIdentity: DeviceIdentity | null,
  deviceAuthScope?: string,
): boolean {
  return Boolean(loadStoredOperatorDeviceAuthToken(deviceIdentity, deviceAuthScope)?.token);
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
  deviceAuthScope?: string;
  storedAuth?: DeviceAuthEntry | null;
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
  const hasStoredAuth =
    params.storedAuth !== undefined
      ? Boolean(params.storedAuth?.token)
      : hasStoredOperatorDeviceAuthToken(params.deviceIdentity, params.deviceAuthScope);
  if (hasStoredAuth) {
    return;
  }
  throw new GatewayCredentialsRequiredError({
    method: params.opts.method,
    configPath: params.context.configPath,
  });
}

export type { ExplicitGatewayAuth } from "./credentials.js";

export { ensureExplicitGatewayAuth, resolveExplicitGatewayAuth };

type ResolvedGatewayCallContext = {
  config: OpenClawConfig;
  configPath: string;
  isRemoteMode: boolean;
  explicitAuth: ExplicitGatewayAuth;
};

export type GatewayTargetClassificationOptions = Pick<
  CallGatewayBaseOptions,
  "config" | "url" | "localPortOverride" | "ignoreEnvUrlOverride"
>;

function resolveGatewayCallTimeout(timeoutValue: unknown): {
  timeoutMs: number | null;
  startupTimeoutMs: number;
  safeTimerTimeoutMs: number;
} {
  const hasEnvHandshakeTimeout =
    Boolean(process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS) ||
    Boolean(isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS);
  const resolvedHandshakeTimeoutMs = hasEnvHandshakeTimeout
    ? resolvePreauthHandshakeTimeoutMs()
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
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const urlOverride = resolveGatewayUrlOverride({
    gatewayUrl: opts.url,
    env: process.env,
    ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
    localPortOverride: opts.localPortOverride,
  }).url;
  const canSkipConfigLoad = canSkipGatewayConfigLoad({
    config: opts.config,
    urlOverride,
    explicitAuth,
  });
  const config =
    opts.config ?? (canSkipConfigLoad ? ({} as OpenClawConfig) : await loadGatewayConfig());
  const configPath = opts.configPath ?? resolveGatewayConfigPath(process.env);
  const isRemoteMode = config.gateway?.mode === "remote";
  return {
    config,
    configPath,
    isRemoteMode,
    explicitAuth,
  };
}

/** Whether the caller selected the configured local Gateway without a URL override. */
export async function isImplicitLocalGatewayTarget(
  opts: GatewayTargetClassificationOptions,
): Promise<boolean> {
  const urlOverride = resolveGatewayUrlOverride({
    gatewayUrl: opts.url,
    env: process.env,
    ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
    localPortOverride: opts.localPortOverride,
  });
  if (urlOverride.url) {
    return false;
  }
  const config = opts.config ?? (await loadGatewayConfig());
  return config.gateway?.mode !== "remote";
}

function ensureRemoteModeUrlConfigured(params: {
  context: ResolvedGatewayCallContext;
  urlOverrideSource?: "cli" | "env";
}): void {
  if (
    !params.context.isRemoteMode ||
    params.urlOverrideSource ||
    trimToUndefined(params.context.config.gateway?.remote?.url)
  ) {
    return;
  }
  throw new Error(
    [
      "gateway remote mode misconfigured: gateway.remote.url missing",
      `Config: ${params.context.configPath}`,
      "Fix: set gateway.remote.url, or set gateway.mode=local.",
    ].join("\n"),
  );
}

export { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

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
        "Update or restart the active gateway and try again.",
      ].join(" "),
    );
  }
}

function ensureGatewaySupportsRequiredCapabilities(params: {
  requiredCapabilities: string[] | undefined;
  capabilities: string[] | undefined;
  attemptedMethod: string;
}): void {
  const required = (params.requiredCapabilities ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (required.length === 0) {
    return;
  }
  const supported = new Set(
    (params.capabilities ?? []).map((entry) => entry.trim()).filter(Boolean),
  );
  for (const capability of required) {
    if (!supported.has(capability)) {
      throw new Error(
        `active gateway does not support required capability "${capability}" for "${params.attemptedMethod}". Update or restart the active gateway and try again.`,
      );
    }
  }
}

function isRequiredAgentRuntimeIdentityConnectError(err: Error): boolean {
  return err.message.includes(
    "gateway rejected required agent runtime identity auth field; refusing to retry without it",
  );
}

function isAllowlistedGatewayConnectRequestError(err: Error): boolean {
  if (err.name !== "GatewayClientRequestError") {
    return false;
  }
  return (
    readConnectErrorDetailCode((err as Error & { details?: unknown }).details) ===
    ConnectErrorDetailCodes.AUTH_RATE_LIMITED
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
  deviceAuthScope?: string;
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
    deviceAuthScope,
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

    const client: GatewayClient | undefined = new GatewayClient({
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
      ...(deviceAuthScope ? { deviceAuthScope } : {}),
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
            ensureGatewaySupportsRequiredCapabilities({
              requiredCapabilities: opts.requiredCapabilities,
              capabilities: hello.features?.capabilities,
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
        if (info?.connectError) {
          ignoreClose = true;
          stop(info.connectError);
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
          isAllowlistedGatewayConnectRequestError(err) ||
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
  );
  const urlOverrideSource = resolveGatewayUrlOverride({
    gatewayUrl: opts.url,
    env: process.env,
    ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
    localPortOverride: opts.localPortOverride,
  }).source;
  if (opts.requireLocalBackendSharedAuth && (urlOverrideSource || context.isRemoteMode)) {
    throw new GatewayLocalBackendSharedAuthUnavailableError(
      "local backend shared auth is limited to the configured local gateway",
    );
  }
  const requestedStoredDeviceAuth = opts.useStoredDeviceAuth === true;
  const hasExplicitAuth = Boolean(context.explicitAuth.token || context.explicitAuth.password);
  const useStoredDeviceAuth = requestedStoredDeviceAuth && !hasExplicitAuth;
  const bootstrap = await resolveGatewayClientBootstrap({
    config: context.config,
    gatewayUrl: opts.url,
    explicitAuth: context.explicitAuth,
    env: process.env,
    configPath: context.configPath,
    ignoreEnvUrlOverride:
      opts.localPortOverride !== undefined || opts.ignoreEnvUrlOverride === true,
    localPortOverride: opts.localPortOverride,
    explicitTlsFingerprint: opts.tlsFingerprint,
    skipImplicitAuth: useStoredDeviceAuth,
    ...(useStoredDeviceAuth
      ? {}
      : {
          overrideAuthErrorHint:
            "Fix: pass --token or --password with --url (or gatewayToken in tools).",
        }),
    buildConnectionDetails: buildGatewayConnectionDetails,
    resolveTlsFingerprint: async (params) =>
      await resolveGatewayConnectionTlsFingerprint({
        ...params,
        loadGatewayTlsRuntime,
      }),
  });
  ensureRemoteModeUrlConfigured({
    context,
    urlOverrideSource: bootstrap.urlOverrideSource,
  });
  const connectionDetails = bootstrap.connectionDetails;
  const url = bootstrap.url;
  const deviceAuthScope = bootstrap.deviceAuthScope;
  const token = useStoredDeviceAuth ? undefined : bootstrap.auth.token;
  const password = useStoredDeviceAuth ? undefined : bootstrap.auth.password;
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
  let storedAuth: DeviceAuthEntry | null | undefined;
  if (useStoredDeviceAuth) {
    storedAuth = loadStoredOperatorDeviceAuthToken(deviceIdentity, deviceAuthScope);
    if (!storedAuth?.token && deviceAuthScope) {
      throw new GatewayStoredDeviceAuthUnavailableError(
        [
          "No stored device auth for this gateway origin.",
          `Run \`openclaw tui --url ${deviceAuthScope}\` to send a pairing request, approve it in that gateway's Control UI (Settings -> Devices) or run \`openclaw devices approve --latest\` on the gateway host, then retry.`,
        ].join("\n"),
      );
    }
  }
  const tlsFingerprint = bootstrap.tlsFingerprint;
  if (useStoredDeviceAuth) {
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
    deviceAuthScope,
    storedAuth,
  });
  const effectiveScopes =
    requestedStoredDeviceAuth && hasExplicitAuth && opts.requiredStoredDeviceAuthScopes
      ? opts.requiredStoredDeviceAuthScopes
      : useStoredDeviceAuth
        ? undefined
        : scopes;
  return await executeGatewayRequestWithScopes<T>({
    opts,
    scopes: effectiveScopes,
    url,
    token,
    password,
    tlsFingerprint,
    timeoutMs,
    startupTimeoutMs,
    safeTimerTimeoutMs,
    connectionDetails,
    deviceIdentity,
    deviceAuthScope,
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
  const bootstrap = await resolveGatewayClientBootstrap({
    config: context.config,
    gatewayUrl: opts.url,
    explicitAuth: context.explicitAuth,
    env: process.env,
    configPath: context.configPath,
    ignoreEnvUrlOverride:
      opts.localPortOverride !== undefined || opts.ignoreEnvUrlOverride === true,
    localPortOverride: opts.localPortOverride,
    explicitTlsFingerprint: opts.tlsFingerprint,
    skipImplicitAuth: true,
    buildConnectionDetails: buildGatewayConnectionDetails,
    resolveTlsFingerprint: async (params) =>
      await resolveGatewayConnectionTlsFingerprint({
        ...params,
        loadGatewayTlsRuntime,
      }),
  });
  ensureRemoteModeUrlConfigured({
    context,
    urlOverrideSource: bootstrap.urlOverrideSource,
  });
  return {
    ...bootstrap.connectionDetails,
    ...(bootstrap.tlsFingerprint ? { tlsFingerprint: bootstrap.tlsFingerprint } : {}),
  };
}

function shouldEscalateSessionCreateCwdScope(params: {
  opts: CallGatewayBaseOptions;
  scopes: readonly OperatorScope[];
  error: unknown;
}): boolean {
  if (
    params.opts.method !== "sessions.create" ||
    !isRecord(params.opts.params) ||
    !normalizeOptionalString(params.opts.params.cwd) ||
    params.scopes.length !== 1 ||
    params.scopes[0] !== WRITE_SCOPE
  ) {
    return false;
  }
  const errorRecord = isRecord(params.error) ? params.error : undefined;
  const missingScope = readMissingScopeErrorDetails(errorRecord?.details);
  return (
    missingScope?.missingScope === ADMIN_SCOPE && missingScope.requiredScopes.includes(ADMIN_SCOPE)
  );
}

async function callGatewayWithScopeEscalation<T>(
  opts: CallGatewayBaseOptions,
  scopes: OperatorScope[],
): Promise<T> {
  try {
    return await callGatewayWithScopes<T>(opts, scopes);
  } catch (error) {
    // sessions.create checks filesystem-backed cwd containment before mutation.
    // Retry only that structured, pre-mutation escalation on an admin connection.
    if (!shouldEscalateSessionCreateCwdScope({ opts, scopes, error })) {
      throw error;
    }
    return await callGatewayWithScopes<T>(opts, [ADMIN_SCOPE]);
  }
}

export async function callGatewayCli<T = Record<string, unknown>>(
  opts: CallGatewayCliOptions,
): Promise<T> {
  if (Array.isArray(opts.scopes)) {
    return await callGatewayWithScopes(opts, opts.scopes);
  }
  const scopes = isGatewayMethodClassified(opts.method)
    ? resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params)
    : CLI_DEFAULT_OPERATOR_SCOPES;
  return await callGatewayWithScopeEscalation(opts, scopes);
}

export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method, opts.params);
  return await callGatewayWithScopeEscalation(opts, scopes);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

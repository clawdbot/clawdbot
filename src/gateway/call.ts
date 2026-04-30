import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../config/io.js";
import {
  resolveConfigPath as resolveConfigPathFromPaths,
  resolveGatewayPort as resolveGatewayPortFromPaths,
  resolveStateDir as resolveStateDirFromPaths,
} from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import { isLoopbackIpAddress } from "../shared/net/ip.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { VERSION } from "../version.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
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
import { PROTOCOL_VERSION } from "./protocol/index.js";
export type { GatewayConnectionDetails };

type CallGatewayBaseOptions = {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  config?: OpenClawConfig;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
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
};

export type CallGatewayScopedOptions = CallGatewayBaseOptions & {
  scopes: OperatorScope[];
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

const defaultCreateGatewayClient = (opts: GatewayClientOptions) => new GatewayClient(opts);
const defaultGatewayCallDeps = {
  createGatewayClient: defaultCreateGatewayClient,
  getRuntimeConfig,
  loadOrCreateDeviceIdentity,
  resolveGatewayPort: resolveGatewayPortFromPaths,
  resolveConfigPath: resolveConfigPathFromPaths,
  resolveStateDir: resolveStateDirFromPaths,
  loadGatewayTlsRuntime,
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

function loadGatewayConfig(): OpenClawConfig {
  const loadConfigFn =
    typeof gatewayCallDeps.getRuntimeConfig === "function"
      ? gatewayCallDeps.getRuntimeConfig
      : typeof defaultGatewayCallDeps.getRuntimeConfig === "function"
        ? defaultGatewayCallDeps.getRuntimeConfig
        : getRuntimeConfig;
  return loadConfigFn();
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
  } = {},
): GatewayConnectionDetails {
  return buildGatewayConnectionDetailsWithResolvers(options, {
    getRuntimeConfig: () => loadGatewayConfig(),
    resolveConfigPath: (env) => resolveGatewayConfigPath(env),
    resolveGatewayPort: (config, env) => resolveGatewayPortValue(config, env),
  });
}

export const __testing = {
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
  },
  setCreateGatewayClientForTests(createGatewayClient?: typeof defaultCreateGatewayClient): void {
    gatewayCallDeps.createGatewayClient =
      createGatewayClient ?? defaultGatewayCallDeps.createGatewayClient;
  },
  resetDepsForTests(): void {
    gatewayCallDeps.createGatewayClient = defaultGatewayCallDeps.createGatewayClient;
    gatewayCallDeps.getRuntimeConfig = defaultGatewayCallDeps.getRuntimeConfig;
    gatewayCallDeps.loadOrCreateDeviceIdentity = defaultGatewayCallDeps.loadOrCreateDeviceIdentity;
    gatewayCallDeps.resolveGatewayPort = defaultGatewayCallDeps.resolveGatewayPort;
    gatewayCallDeps.resolveConfigPath = defaultGatewayCallDeps.resolveConfigPath;
    gatewayCallDeps.resolveStateDir = defaultGatewayCallDeps.resolveStateDir;
    gatewayCallDeps.loadGatewayTlsRuntime = defaultGatewayCallDeps.loadGatewayTlsRuntime;
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
  token?: string;
  password?: string;
}): boolean {
  const mode = params.opts.mode ?? GATEWAY_CLIENT_MODES.CLI;
  const clientName = params.opts.clientName ?? GATEWAY_CLIENT_NAMES.CLI;
  const hasSharedAuth = Boolean(params.token || params.password);
  return (
    mode === GATEWAY_CLIENT_MODES.BACKEND &&
    clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT &&
    hasSharedAuth &&
    isLoopbackGatewayUrl(params.url)
  );
}

function resolveDeviceIdentityForGatewayCall(params: {
  opts: CallGatewayBaseOptions;
  url: string;
  token?: string;
  password?: string;
}): ReturnType<typeof loadOrCreateDeviceIdentity> | null {
  if (shouldOmitDeviceIdentityForGatewayCall(params)) {
    return null;
  }
  try {
    return gatewayCallDeps.loadOrCreateDeviceIdentity();
  } catch {
    // Read-only or restricted environments should still be able to call the
    // gateway with token/password auth without crashing before the RPC.
    return null;
  }
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
  const message = [
    "gateway url override requires explicit credentials",
    params.errorHint,
    params.configPath ? `Config: ${params.configPath}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(message);
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
  timeoutMs: number;
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
  const timeoutMs =
    typeof timeoutValue === "number" && Number.isFinite(timeoutValue)
      ? timeoutValue
      : typeof resolvedHandshakeTimeoutMs === "number" && resolvedHandshakeTimeoutMs > 10_000
        ? resolvedHandshakeTimeoutMs
        : 10_000;
  const safeTimerTimeoutMs = resolveSafeTimeoutDelayMs(timeoutMs);
  return { timeoutMs, safeTimerTimeoutMs };
}

function resolveGatewayCallContext(opts: CallGatewayBaseOptions): ResolvedGatewayCallContext {
  const cliUrlOverride = trimToUndefined(opts.url);
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  const envUrlOverride = cliUrlOverride
    ? undefined
    : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL);
  const urlOverride = cliUrlOverride ?? envUrlOverride;
  const urlOverrideSource = cliUrlOverride ? "cli" : envUrlOverride ? "env" : undefined;
  const canSkipConfigLoad = canSkipGatewayConfigLoad({
    config: opts.config,
    urlOverride,
    explicitAuth,
  });
  const config = opts.config ?? (canSkipConfigLoad ? ({} as OpenClawConfig) : loadGatewayConfig());
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
      "\n- Gateway not yet ready to accept connections (retry after a moment)" +
      "\n- TLS mismatch (connecting with ws:// to a wss:// gateway, or vice versa)" +
      "\n- Gateway crashed or was terminated unexpectedly" +
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

async function executeGatewayRequestWithScopes<T>(params: {
  opts: CallGatewayBaseOptions;
  scopes: OperatorScope[];
  url: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  preauthHandshakeTimeoutMs?: number;
  timeoutMs: number;
  safeTimerTimeoutMs: number;
  connectionDetails: GatewayConnectionDetails;
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
    safeTimerTimeoutMs,
  } = params;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let ignoreClose = false;
    const startAbort = new AbortController();
    const stop = (err?: Error, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      startAbort.abort();
      clearTimeout(timer);
      void stopGatewayClient(client).finally(() => {
        if (err) {
          reject(err);
        } else {
          resolve(value as T);
        }
      });
    };

    const client = gatewayCallDeps.createGatewayClient({
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
      role: "operator",
      scopes,
      deviceIdentity:
        opts.deviceIdentity === undefined
          ? resolveDeviceIdentityForGatewayCall({ opts, url, token, password })
          : opts.deviceIdentity,
      minProtocol: opts.minProtocol ?? PROTOCOL_VERSION,
      maxProtocol: opts.maxProtocol ?? PROTOCOL_VERSION,
      onHelloOk: async (hello) => {
        try {
          ensureGatewaySupportsRequiredMethods({
            requiredMethods: opts.requiredMethods,
            methods: hello.features?.methods,
            attemptedMethod: opts.method,
          });
          const result = await client.request<T>(opts.method, opts.params, {
            expectFinal: opts.expectFinal,
            timeoutMs: opts.timeoutMs,
          });
          ignoreClose = true;
          stop(undefined, result);
        } catch (err) {
          ignoreClose = true;
          stop(err as Error);
        }
      },
      onClose: (code, reason) => {
        if (settled || ignoreClose) {
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
    });

    const timer = setTimeout(() => {
      ignoreClose = true;
      stop(
        createGatewayTimeoutTransportError({
          timeoutMs,
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
            timeoutMs,
            connectionDetails: params.connectionDetails,
          }),
        );
      })
      .catch((err) => {
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
  scopes: OperatorScope[],
): Promise<T> {
  const context = resolveGatewayCallContext(opts);
  const { timeoutMs, safeTimerTimeoutMs } = resolveGatewayCallTimeout(
    opts.timeoutMs,
    context.config.gateway?.handshakeTimeoutMs,
  );
  const resolvedCredentials = await resolveGatewayCredentials(context);
  ensureExplicitGatewayAuth({
    urlOverride: context.urlOverride,
    urlOverrideSource: context.urlOverrideSource,
    explicitAuth: context.explicitAuth,
    resolvedAuth: resolvedCredentials,
    errorHint: "Fix: pass --token or --password (or gatewayToken in tools).",
    configPath: context.configPath,
  });
  ensureRemoteModeUrlConfigured(context);
  const connectionDetails = buildGatewayConnectionDetails({
    config: context.config,
    url: context.urlOverride,
    urlSource: context.urlOverrideSource,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
  });
  const url = connectionDetails.url;
  const tlsFingerprint = await resolveGatewayTlsFingerprint({ opts, context, url });
  const { token, password } = resolvedCredentials;
  return await executeGatewayRequestWithScopes<T>({
    opts,
    scopes,
    url,
    token,
    password,
    tlsFingerprint,
    preauthHandshakeTimeoutMs: context.config.gateway?.handshakeTimeoutMs,
    timeoutMs,
    safeTimerTimeoutMs,
    connectionDetails,
  });
}

export async function callGatewayScoped<T = Record<string, unknown>>(
  opts: CallGatewayScopedOptions,
): Promise<T> {
  return await callGatewayWithScopes(opts, opts.scopes);
}

export async function callGatewayCli<T = Record<string, unknown>>(
  opts: CallGatewayCliOptions,
): Promise<T> {
  const scopes = Array.isArray(opts.scopes)
    ? opts.scopes
    : isGatewayMethodClassified(opts.method)
      ? resolveLeastPrivilegeOperatorScopesForMethod(opts.method)
      : CLI_DEFAULT_OPERATOR_SCOPES;
  return await callGatewayWithScopes(opts, scopes);
}

export async function callGatewayLeastPrivilege<T = Record<string, unknown>>(
  opts: CallGatewayBaseOptions,
): Promise<T> {
  const scopes = resolveLeastPrivilegeOperatorScopesForMethod(opts.method);
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

import { randomUUID } from "node:crypto";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "@openclaw/gateway-protocol/client-info";
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorDetailCode,
} from "@openclaw/gateway-protocol/connect-error-details";
import type {
  ConnectParams,
  ErrorShape,
  EventFrame,
  HelloOk,
} from "@openclaw/gateway-protocol/frame-guards";
import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-protocol/startup-unavailable";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { isLoopbackIpAddress, type ParsedIpAddress } from "@openclaw/net-policy/ip";
import { WebSocket, type ClientOptions, type CertMeta } from "ws";
import {
  isSensitiveUrlQueryParamName,
  normalizeFingerprint,
  normalizeLowercaseStringOrEmpty,
  parseGatewayIpAddress,
  parseHostForAddressChecks,
} from "./client-address-utils.js";
import {
  buildGatewayConnectAuth,
  type GatewayConnectAuthSelection,
  resolveGatewayConnectScopes,
  selectGatewayConnectAuth,
  shouldRetryGatewayWithDeviceToken,
} from "./connect-auth.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import {
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  type GatewayProtocolCloseContext,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";
import { shouldPauseGatewayReconnect } from "./reconnect-policy.js";
import { resolveConnectChallengeTimeoutMs, resolveSafeTimeoutDelayMs } from "./timeouts.js";
import { rawDataToString } from "./websocket-data.js";

export type DeviceIdentity = {
  deviceId: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

export type DeviceAuthTokenRecord = {
  token?: string;
  scopes?: string[];
};

// The package stays reusable by depending on host callbacks for OpenClaw-owned
// state: device keys, token storage, proxy routing, logging, and TLS formatting.
export type GatewayClientHostDeps = {
  loadOrCreateDeviceIdentity?: () => DeviceIdentity | undefined;
  signDevicePayload?: (privateKeyPem: string, payload: string) => string;
  publicKeyRawBase64UrlFromPem?: (publicKeyPem: string) => string;
  loadDeviceAuthToken?: (params: {
    deviceId: string;
    role: string;
    env?: NodeJS.ProcessEnv;
  }) => DeviceAuthTokenRecord | null;
  storeDeviceAuthToken?: (params: {
    deviceId: string;
    role: string;
    token: string;
    scopes: string[];
    env?: NodeJS.ProcessEnv;
  }) => void;
  clearDeviceAuthToken?: (params: {
    deviceId: string;
    role: string;
    env?: NodeJS.ProcessEnv;
  }) => void;
  beforeConnect?: () => void;
  registerGatewayLoopbackBypass?: (url: string) => (() => void) | undefined;
  logDebug?: (message: string) => void;
  logError?: (message: string) => void;
  redactForLog?: (message: string) => string;
  normalizeTlsFingerprint?: (fingerprint: string | undefined) => string;
};

const DEFAULT_HOST_DEPS: Required<GatewayClientHostDeps> = {
  loadOrCreateDeviceIdentity: () => undefined,
  signDevicePayload: () => {
    throw new Error("GatewayClient device signature dependency is not configured");
  },
  publicKeyRawBase64UrlFromPem: () => {
    throw new Error("GatewayClient public key dependency is not configured");
  },
  loadDeviceAuthToken: () => null,
  storeDeviceAuthToken: () => {},
  clearDeviceAuthToken: () => {},
  beforeConnect: () => {},
  registerGatewayLoopbackBypass: () => undefined,
  logDebug: () => {},
  logError: () => {},
  redactForLog: (message) => message,
  normalizeTlsFingerprint: normalizeFingerprint,
};

function resolveHostDeps(overrides?: GatewayClientHostDeps): Required<GatewayClientHostDeps> {
  return Object.fromEntries(
    Object.entries(DEFAULT_HOST_DEPS).map(([key, fallback]) => [
      key,
      overrides?.[key as keyof GatewayClientHostDeps] ?? fallback,
    ]),
  ) as Required<GatewayClientHostDeps>;
}

const PRIVATE_OR_LOOPBACK_IPV4_RANGES = new Set<string>([
  "loopback",
  "private",
  "linkLocal",
  "carrierGradeNat",
]);

const PRIVATE_OR_LOOPBACK_IPV6_RANGES = new Set<string>([
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "deprecatedSiteLocal",
]);

function isPrivateOrLoopbackIpAddress(address: ParsedIpAddress): boolean {
  const ranges =
    address.kind() === "ipv4" ? PRIVATE_OR_LOOPBACK_IPV4_RANGES : PRIVATE_OR_LOOPBACK_IPV6_RANGES;
  return ranges.has(address.range());
}

function isLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  return isLoopbackIpAddress(parsed.unbracketedHost);
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  const address = parseGatewayIpAddress(parsed.unbracketedHost);
  if (!address) {
    return false;
  }
  return isPrivateOrLoopbackIpAddress(address);
}

function isTrustedPlaintextWebSocketHost(hostname: string): boolean {
  if (isPrivateOrLoopbackHost(hostname)) {
    return true;
  }
  const normalized = hostname.toLowerCase().trim().replace(/\.+$/, "");
  // Plain ws:// is still useful for local discovery and Tailnet names. Public
  // hostnames must use wss:// unless the caller opts into the private break-glass.
  return normalized.endsWith(".local") || normalized.endsWith(".ts.net");
}

function isSecureWebSocketUrl(rawUrl: string, options?: { allowPrivateWs?: boolean }): boolean {
  try {
    const url = new URL(rawUrl);
    const protocol =
      url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
    if (protocol === "wss:") {
      return true;
    }
    if (protocol !== "ws:") {
      return false;
    }
    if (isLoopbackHost(url.hostname) || isTrustedPlaintextWebSocketHost(url.hostname)) {
      return true;
    }
    if (options?.allowPrivateWs === true) {
      const hostForIpCheck =
        url.hostname.startsWith("[") && url.hostname.endsWith("]")
          ? url.hostname.slice(1, -1)
          : url.hostname;
      return (
        isPrivateOrLoopbackHost(url.hostname) || parseGatewayIpAddress(hostForIpCheck) === undefined
      );
    }
    return false;
  } catch {
    return false;
  }
}

export type GatewayClientRequestOptions = GatewayProtocolRequestOptions;

type AssembledConnect = {
  params: ConnectParams;
  authApprovalRuntimeToken: string | undefined;
  authAgentRuntimeIdentityToken: string | undefined;
  resolvedDeviceToken: string | undefined;
  storedToken: string | undefined;
  usingStoredDeviceToken: boolean | undefined;
};

type FingerprintCheckingClientOptions = Omit<ClientOptions, "checkServerIdentity"> & {
  checkServerIdentity?: (servername: string, cert: CertMeta) => Error | undefined;
};

const DEFAULT_GATEWAY_CLIENT_URL = "ws://127.0.0.1:18789";
const DEFAULT_CLIENT_VERSION = "0.0.0";

export type GatewayReconnectPausedInfo = {
  code: number;
  reason: string;
  detailCode: string | null;
};

export type GatewayClientCloseInfo = {
  phase: "pre-hello" | "post-hello";
  socketOpened: boolean;
  transportValidated: boolean;
  transientPreHelloCleanClose: boolean;
};

export class GatewayClientRequestError extends GatewayProtocolRequestError {
  constructor(error: Partial<ErrorShape>) {
    super({
      ...error,
      message: formatConnectErrorMessage({ message: error.message, details: error.details }),
    });
    this.name = "GatewayClientRequestError";
  }
}

class GatewayClientTransientPreHelloCloseError extends Error {
  constructor() {
    super("gateway transient pre-hello clean close");
    this.name = "GatewayClientTransientPreHelloCloseError";
  }
}

class GatewayClientTransportPolicyError extends Error {}

const GATEWAY_CONNECT_ASSEMBLY_ERROR = Symbol("gateway.connectAssemblyError");

type GatewayConnectAssemblyError = Error & {
  [GATEWAY_CONNECT_ASSEMBLY_ERROR]?: true;
};

function markGatewayConnectAssemblyError(error: Error): Error {
  Object.defineProperty(error, GATEWAY_CONNECT_ASSEMBLY_ERROR, {
    configurable: true,
    value: true,
  });
  return error;
}

export function isGatewayConnectAssemblyError(value: unknown): value is Error {
  return (
    value instanceof Error &&
    (value as GatewayConnectAssemblyError)[GATEWAY_CONNECT_ASSEMBLY_ERROR] === true
  );
}

export type GatewayClientOptions = {
  url?: string; // ws://127.0.0.1:18789
  origin?: string;
  connectChallengeTimeoutMs?: number;
  /**
   * Server-side pre-auth handshake budget. Config-derived local clients use
   * this to keep the connect-challenge watchdog aligned with the gateway.
   */
  preauthHandshakeTimeoutMs?: number;
  tickWatchMinIntervalMs?: number;
  tickWatchTimeoutMs?: number;
  requestTimeoutMs?: number;
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
  approvalRuntimeToken?: string;
  agentRuntimeIdentityToken?: string;
  instanceId?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  deviceFamily?: string;
  mode?: GatewayClientMode;
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  pathEnv?: string;
  env?: NodeJS.ProcessEnv;
  deviceIdentity?: DeviceIdentity | null;
  hostDeps?: GatewayClientHostDeps;
  minProtocol?: number;
  maxProtocol?: number;
  tlsFingerprint?: string;
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: (hello: HelloOk) => void;
  onConnectError?: (err: Error) => void;
  onReconnectPaused?: (info: GatewayReconnectPausedInfo) => void;
  onClose?: (code: number, reason: string, info?: GatewayClientCloseInfo) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export type GatewayClientConnectionMetadata = {
  clientName?: GatewayClientName;
  hasDeviceIdentity: boolean;
  mode?: GatewayClientMode;
  preauthHandshakeTimeoutMs?: number;
};

function readConnectChallengeTimeoutOverride(
  opts: Pick<GatewayClientOptions, "connectChallengeTimeoutMs">,
): number | undefined {
  if (
    typeof opts.connectChallengeTimeoutMs === "number" &&
    Number.isFinite(opts.connectChallengeTimeoutMs)
  ) {
    return opts.connectChallengeTimeoutMs;
  }
  return undefined;
}

function isGatewayClientStoppedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message === "gateway client stopped" || message === "Error: gateway client stopped";
}

function formatGatewayClientErrorForLog(err: unknown): string {
  const redactedUrlLikeString = String(err)
    .replace(/\/\/([^@/?#\s]+)@/g, "//***:***@")
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/giu, "$1***")
    .replace(/([?&])([^=&\s]+)=([^&#\s"'<>)]*)/g, (match, prefix: string, key: string) =>
      isSensitiveUrlQueryParamName(key) ? `${prefix}${key}=***` : match,
    );
  return redactedUrlLikeString;
}

function resolveGatewayClientConnectChallengeTimeoutMs(
  opts: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "env" | "preauthHandshakeTimeoutMs"
  >,
): number {
  return resolveConnectChallengeTimeoutMs(readConnectChallengeTimeoutOverride(opts), {
    env: opts.env,
    configuredTimeoutMs: opts.preauthHandshakeTimeoutMs,
  });
}

const FORCE_STOP_TERMINATE_GRACE_MS = 250;
const STOP_AND_WAIT_TIMEOUT_MS = 1_000;
const MAX_SUPPRESSED_TRANSIENT_PRE_HELLO_CLEAN_CLOSES = 1;

type PendingStop = {
  ws: WebSocket;
  promise: Promise<void>;
  resolve: () => void;
  terminateTimer?: NodeJS.Timeout;
};

export class GatewayClient {
  private readonly protocol: GatewayProtocolClient<AssembledConnect>;
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private deps: Required<GatewayClientHostDeps>;
  private stopped = false;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private approvalRuntimeTokenCompatibilityDisabled = false;
  private approvalRuntimeTokenRetryBudgetUsed = false;
  // Track last tick to detect silent stalls.
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly requestTimeoutMs: number;
  private pendingStop: PendingStop | null = null;
  private transportValidated = false;
  private suppressedTransientPreHelloCleanCloses = 0;

  constructor(opts: GatewayClientOptions) {
    // Defaults keep the package inert until device identity support is used.
    this.deps = resolveHostDeps(opts.hostDeps);
    this.opts = {
      ...opts,
      deviceIdentity:
        opts.deviceIdentity === null
          ? undefined
          : (opts.deviceIdentity ?? this.deps.loadOrCreateDeviceIdentity()),
    };
    this.requestTimeoutMs =
      typeof opts.requestTimeoutMs === "number" && Number.isFinite(opts.requestTimeoutMs)
        ? resolveSafeTimeoutDelayMs(opts.requestTimeoutMs, { minMs: 0 })
        : 30_000;
    this.protocol = new GatewayProtocolClient<AssembledConnect>({
      createSocket: (handlers) => this.createSocket(handlers),
      createRequestId: randomUUID,
      createRequestError: (error) => new GatewayClientRequestError(error),
      createRequestTimeoutError: (method) => new Error(`gateway request timeout for ${method}`),
      createRequestAbortError: createGatewayRequestAbortError,
      buildConnectPlan: ({ nonce }) => {
        if (!nonce) {
          throw new Error("gateway connect challenge missing nonce");
        }
        return this.assembleConnectParams({ role: this.opts.role ?? "operator", nonce });
      },
      buildConnectParams: (assembled) => assembled.params,
      onConnectPlanError: (error) => {
        this.stopped = true;
        const marked = markGatewayConnectAssemblyError(error);
        const msg = `gateway connect failed: ${formatGatewayClientErrorForLog(error)}`;
        if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(error)) {
          this.logDebug(msg);
        } else {
          this.logError(msg);
        }
        return { closeCode: 1008, closeReason: "connect failed", stop: true, error: marked };
      },
      onConnectHello: (hello, context) => this.handleConnectHello(hello, context.plan),
      onHello: (hello) => this.opts.onHelloOk?.(hello),
      onConnectFailure: (error, context) => this.handleConnectRequestFailure(error, context.plan),
      resolveClose: (context) => this.resolveClose(context),
      onClose: (context, decision) => {
        if (this.tickTimer) {
          clearInterval(this.tickTimer);
          this.tickTimer = null;
        }
        if (decision.notify) {
          this.opts.onClose?.(context.code, context.reason, this.closeInfo(context));
        }
      },
      notifyStoppedClose: true,
      onConnectError: (error) => this.notifyConnectError(error),
      onParseError: (error) =>
        this.logDebug(`gateway client parse error: ${formatGatewayClientErrorForLog(error)}`),
      onEvent: (event) => this.opts.onEvent?.(event),
      onGap: (info) => this.opts.onGap?.(info),
      onActivity: () => {
        this.lastTick = Date.now();
      },
      onCallbackError: (label, error) =>
        this.logDebug(
          `gateway client ${label === "hello" ? "hello-ok" : label === "gap" ? "event" : label} handler error: ${formatGatewayClientErrorForLog(error)}`,
        ),
      handshake: {
        mode: "require-challenge",
        timeoutMs: resolveGatewayClientConnectChallengeTimeoutMs(this.opts),
        timeoutMessage: (elapsedMs) =>
          `gateway connect challenge timeout (waited ${elapsedMs}ms, limit ${resolveGatewayClientConnectChallengeTimeoutMs(this.opts)}ms)`,
      },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
      requestTimeoutMs: this.requestTimeoutMs,
      rethrowSocketFactoryError: (error) => error instanceof GatewayClientTransportPolicyError,
    });
  }

  getConnectionMetadata(): GatewayClientConnectionMetadata {
    return {
      clientName: this.opts.clientName,
      hasDeviceIdentity: Boolean(this.opts.deviceIdentity),
      mode: this.opts.mode,
      preauthHandshakeTimeoutMs: this.opts.preauthHandshakeTimeoutMs,
    };
  }

  updateNodeManifest(manifest: { caps: string[]; commands: string[] }): void {
    this.opts = {
      ...this.opts,
      caps: [...manifest.caps],
      commands: [...manifest.commands],
    };
    // Node command declarations are connect metadata. Reconnect so the Gateway
    // can reconcile approval before dispatching a newly available command.
    if (!this.stopped) {
      this.protocol.closeSocket(1012, "node manifest changed");
    }
  }

  start() {
    if (this.stopped) {
      return;
    }
    this.protocol.start();
  }

  private createSocket(handlers: GatewayProtocolSocketHandlers): GatewayProtocolSocket {
    const url = this.opts.url ?? DEFAULT_GATEWAY_CLIENT_URL;
    if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
      throw new Error("gateway tls fingerprint requires wss:// gateway url");
    }

    const allowPrivateWs =
      (this.opts.env ?? process.env).OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
    // Block plaintext before device-token lookup. Credentials may be loaded from
    // host storage later in sendConnect(), and chat payloads are sensitive too.
    if (!isSecureWebSocketUrl(url, { allowPrivateWs })) {
      // Safe hostname extraction - avoid throwing on malformed URLs in error path
      let displayHost = url;
      try {
        displayHost = new URL(url).hostname || url;
      } catch {
        // Use raw URL if parsing fails
      }
      throw new Error(
        `SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. ` +
          "Both credentials and chat data would be exposed to network interception. " +
          "Use wss:// for remote URLs. Safe defaults: keep gateway.bind=loopback and connect via SSH tunnel " +
          "(ssh -N -L 18789:127.0.0.1:18789 user@gateway-host), or use Tailscale Serve/Funnel. " +
          (allowPrivateWs
            ? ""
            : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1. ") +
          "Run `openclaw doctor --fix` for guidance.",
      );
    }
    // Allow node screen snapshots and other large responses.
    this.deps.beforeConnect();
    const wsOptions: FingerprintCheckingClientOptions = {
      maxPayload: 25 * 1024 * 1024,
      ...(this.opts.origin ? { origin: this.opts.origin } : {}),
    };
    if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
      wsOptions.rejectUnauthorized = false;
      wsOptions.checkServerIdentity = (_hostValue: string, cert: CertMeta) => {
        const fingerprintValue =
          typeof cert === "object" && cert && "fingerprint256" in cert
            ? ((cert as { fingerprint256?: string }).fingerprint256 ?? "")
            : "";
        const fingerprint = this.deps.normalizeTlsFingerprint(
          typeof fingerprintValue === "string" ? fingerprintValue : "",
        );
        const expected = this.deps.normalizeTlsFingerprint(this.opts.tlsFingerprint ?? "");
        if (!expected) {
          return undefined;
        }
        if (!fingerprint) {
          return new Error("Missing server TLS fingerprint");
        }
        if (fingerprint !== expected) {
          return new Error("Server TLS fingerprint mismatch");
        }
        return undefined;
      };
    }
    let ws: WebSocket;
    // Managed proxies can intercept local traffic; the host owns the bypass
    // lifecycle and must remove it immediately after the socket is created.
    let unregisterGatewayLoopbackBypass: (() => void) | undefined;
    try {
      unregisterGatewayLoopbackBypass = this.deps.registerGatewayLoopbackBypass(url);
    } catch (error) {
      throw new GatewayClientTransportPolicyError(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      ws = new WebSocket(url, wsOptions as ClientOptions);
      ws.binaryType = "nodebuffer";
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      unregisterGatewayLoopbackBypass?.();
    }
    this.ws = ws;
    this.transportValidated = false;
    ws.on("open", () => {
      handlers.open();
      if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
        const tlsError = this.validateTlsFingerprint();
        if (tlsError) {
          handlers.error(tlsError);
          ws.close(1008, tlsError.message);
          return;
        }
      }
      this.transportValidated = true;
    });
    ws.on("message", (data) => handlers.message(rawDataToString(data)));
    ws.on("close", (code, reason) => {
      const reasonText = reason.toString();
      if (this.ws === ws) {
        this.ws = null;
      }
      this.resolvePendingStop(ws);
      handlers.close(code, reasonText);
    });
    ws.on("error", (err) => {
      this.logDebug(`gateway client error: ${formatGatewayClientErrorForLog(err)}`);
      handlers.error(err instanceof Error ? err : new Error(String(err)));
    });
    return {
      isOpen: () => ws.readyState === WebSocket.OPEN,
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
  }

  stop() {
    void this.beginStop();
  }

  async stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    // Some callers need teardown ordering, not just "close requested". Wait for
    // the socket to close or the terminate fallback to fire.
    const stopPromise = this.beginStop();
    if (!stopPromise) {
      return;
    }
    const timeoutMs =
      opts?.timeoutMs === undefined
        ? STOP_AND_WAIT_TIMEOUT_MS
        : resolveSafeTimeoutDelayMs(opts.timeoutMs);
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        stopPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`gateway client stop timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private beginStop(): Promise<void> | null {
    this.stopped = true;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.pendingStop) {
      return this.pendingStop.promise;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      const pendingStop = this.createPendingStop(ws);
      const forceTerminateTimer = setTimeout(() => {
        try {
          ws.terminate();
        } finally {
          this.resolvePendingStop(ws);
        }
      }, FORCE_STOP_TERMINATE_GRACE_MS);
      forceTerminateTimer.unref?.();
      pendingStop.terminateTimer = forceTerminateTimer;
      if (this.protocol.connecting) {
        const error = new Error("gateway client stopped");
        this.notifyConnectError(error);
        this.logDebug(`gateway connect failed: ${formatGatewayClientErrorForLog(error)}`);
      }
      this.protocol.stop();
      return pendingStop.promise;
    }
    this.protocol.stop();
    return null;
  }

  private createPendingStop(ws: WebSocket): PendingStop {
    if (this.pendingStop?.ws === ws) {
      return this.pendingStop;
    }
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.pendingStop = { ws, promise, resolve };
    return this.pendingStop;
  }

  private resolvePendingStop(ws: WebSocket): void {
    if (this.pendingStop?.ws !== ws) {
      return;
    }
    const { resolve, terminateTimer } = this.pendingStop;
    if (terminateTimer) {
      clearTimeout(terminateTimer);
    }
    this.pendingStop = null;
    resolve();
  }

  private logDebug(message: string): void {
    this.deps.logDebug(this.deps.redactForLog(message));
  }

  private logError(message: string): void {
    this.deps.logError(this.deps.redactForLog(message));
  }

  private assembleConnectParams(params: { role: string; nonce: string }): AssembledConnect {
    const { role, nonce } = params;
    // Auth selection is intentionally centralized: retry decisions depend on
    // whether a token was explicit, cached, or compatibility-derived.
    const selectedAuth = this.selectConnectAuth(role);
    const {
      authDeviceToken,
      authApprovalRuntimeToken,
      authAgentRuntimeIdentityToken,
      signatureToken,
      resolvedDeviceToken,
      storedToken,
      storedScopes,
      usingStoredDeviceToken,
    } = selectedAuth;

    if (this.pendingDeviceTokenRetry && authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }

    const auth = buildGatewayConnectAuth(selectedAuth);
    const signedAtMs = Date.now();
    const scopes = resolveGatewayConnectScopes({
      requestedScopes: this.opts.scopes,
      usingStoredDeviceToken,
      storedScopes,
      defaultScopes: ["operator.admin"],
    });
    const platform = this.opts.platform ?? process.platform;

    return {
      params: {
        minProtocol: this.opts.minProtocol ?? MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: this.opts.maxProtocol ?? PROTOCOL_VERSION,
        client: {
          id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          displayName: this.opts.clientDisplayName,
          version: this.opts.clientVersion ?? DEFAULT_CLIENT_VERSION,
          platform,
          deviceFamily: this.opts.deviceFamily,
          mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
          instanceId: this.opts.instanceId,
        },
        caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
        commands: Array.isArray(this.opts.commands) ? this.opts.commands : undefined,
        permissions:
          this.opts.permissions && typeof this.opts.permissions === "object"
            ? this.opts.permissions
            : undefined,
        pathEnv: this.opts.pathEnv,
        auth,
        role,
        scopes,
        device: this.buildDeviceConnectParams({
          nonce,
          role,
          scopes,
          signatureToken,
          signedAtMs,
          platform,
        }),
      },
      authApprovalRuntimeToken,
      authAgentRuntimeIdentityToken,
      resolvedDeviceToken,
      storedToken,
      usingStoredDeviceToken,
    };
  }

  private buildDeviceConnectParams(params: {
    nonce: string;
    role: string;
    scopes: string[];
    signatureToken: string | undefined;
    signedAtMs: number;
    platform: string;
  }): ConnectParams["device"] {
    if (!this.opts.deviceIdentity) {
      return undefined;
    }
    const { nonce, role, scopes, signatureToken, signedAtMs, platform } = params;
    // The signed payload mirrors server verification exactly; keep metadata
    // normalized here so different hosts sign the same logical device facts.
    const payload = buildDeviceAuthPayloadV3({
      deviceId: this.opts.deviceIdentity.deviceId,
      clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode: this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND,
      role,
      scopes,
      signedAtMs,
      token: signatureToken ?? null,
      nonce,
      platform,
      deviceFamily: this.opts.deviceFamily,
    });
    const signature = this.deps.signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
    return {
      id: this.opts.deviceIdentity.deviceId,
      publicKey: this.deps.publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
      signature,
      signedAt: signedAtMs,
      nonce,
    };
  }

  private handleConnectHello(helloOk: HelloOk, assembled: AssembledConnect): void {
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.suppressedTransientPreHelloCleanCloses = 0;
    const role = this.opts.role ?? "operator";
    const authInfo = helloOk.auth;
    if (authInfo?.deviceToken && this.opts.deviceIdentity) {
      this.deps.storeDeviceAuthToken({
        deviceId: this.opts.deviceIdentity.deviceId,
        role: authInfo.role ?? role,
        token: authInfo.deviceToken,
        scopes: authInfo.scopes ?? [],
        env: this.opts.env,
      });
    }
    this.tickIntervalMs =
      typeof helloOk.policy?.tickIntervalMs === "number" ? helloOk.policy.tickIntervalMs : 30_000;
    this.lastTick = Date.now();
    this.startTickWatch();
    void assembled;
  }

  private handleConnectRequestFailure(
    error: GatewayProtocolRequestError,
    assembled: AssembledConnect,
  ) {
    const role = this.opts.role ?? "operator";
    const shouldRetryWithDeviceToken = shouldRetryGatewayWithDeviceToken({
      retryBudgetUsed: this.deviceTokenRetryBudgetUsed,
      currentDeviceToken: assembled.resolvedDeviceToken,
      explicitToken: this.opts.token?.trim() || undefined,
      storedToken: assembled.storedToken,
      trustedEndpoint: this.isTrustedDeviceRetryEndpoint(),
      errorDetails: error instanceof GatewayClientRequestError ? error.details : undefined,
    });
    if (
      this.opts.deviceIdentity &&
      assembled.usingStoredDeviceToken &&
      error instanceof GatewayClientRequestError &&
      readConnectErrorDetailCode(error.details) ===
        ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
    ) {
      const deviceId = this.opts.deviceIdentity.deviceId;
      try {
        this.deps.clearDeviceAuthToken({ deviceId, role, env: this.opts.env });
        this.logDebug(`cleared stale device-auth token for device ${deviceId}`);
      } catch (clearError) {
        this.logDebug(
          `failed clearing stale device-auth token for device ${deviceId}: ${String(clearError)}`,
        );
      }
    }
    if (shouldRetryWithDeviceToken) {
      this.pendingDeviceTokenRetry = true;
      this.deviceTokenRetryBudgetUsed = true;
      this.protocol.resetReconnectBackoff(250);
    }
    const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(error);
    if (startupRetryAfterMs !== null) {
      this.logDebug(`gateway connect failed: ${formatGatewayClientErrorForLog(error)}`);
      return {
        closeCode: 1013,
        closeReason: "gateway starting",
        reconnectDelayMs: startupRetryAfterMs,
      };
    }
    if (
      this.shouldFailClosedForUnsupportedAgentRuntimeIdentity({
        error,
        authAgentRuntimeIdentityToken: assembled.authAgentRuntimeIdentityToken,
      })
    ) {
      const unsupportedIdentityError = new Error(
        "gateway rejected required agent runtime identity auth field; refusing to retry without it",
      );
      this.stopped = true;
      this.notifyConnectError(unsupportedIdentityError);
      this.logError(`gateway connect failed: ${unsupportedIdentityError.message}`);
      return { closeCode: 1008, closeReason: "connect failed", stop: true };
    }
    if (
      this.shouldRetryWithoutApprovalRuntimeToken({
        error,
        authApprovalRuntimeToken: assembled.authApprovalRuntimeToken,
      })
    ) {
      this.approvalRuntimeTokenCompatibilityDisabled = true;
      this.approvalRuntimeTokenRetryBudgetUsed = true;
      this.protocol.resetReconnectBackoff(250);
      this.logDebug("gateway rejected approval runtime auth field; retrying without it");
      return { closeCode: 1008, closeReason: "connect retry" };
    }
    this.notifyConnectError(error);
    const message = `gateway connect failed: ${formatGatewayClientErrorForLog(error)}`;
    if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(error)) {
      this.logDebug(message);
    } else {
      this.logError(message);
    }
    return {
      closeCode: 1008,
      closeReason: "connect failed",
    };
  }

  private resolveClose(context: GatewayProtocolCloseContext) {
    const info = this.closeInfo(context);
    const detailCode =
      context.connectFailure?.error instanceof GatewayClientRequestError
        ? readConnectErrorDetailCode(context.connectFailure.error.details)
        : null;
    const details =
      context.connectFailure?.error instanceof GatewayClientRequestError
        ? context.connectFailure.error.details
        : undefined;
    if (context.code === 1013 && context.connectFailure?.reconnectDelayMs !== undefined) {
      return {
        retry: true,
        notify: false,
        reconnectDelayMs: context.connectFailure.reconnectDelayMs,
      };
    }
    if (
      info.transientPreHelloCleanClose &&
      this.suppressedTransientPreHelloCleanCloses < MAX_SUPPRESSED_TRANSIENT_PRE_HELLO_CLEAN_CLOSES
    ) {
      this.suppressedTransientPreHelloCleanCloses += 1;
      return {
        retry: true,
        notify: true,
        pendingError: new GatewayClientTransientPreHelloCloseError(),
      };
    }
    if (
      info.transientPreHelloCleanClose ||
      (context.connectRequestSent && !context.helloReceived && !context.connectFailure)
    ) {
      const error = new Error(`gateway closed (${context.code}): ${context.reason}`);
      this.notifyConnectError(error);
      this.logError(`gateway connect failed: ${formatGatewayClientErrorForLog(error)}`);
    }
    this.clearStaleDeviceTokenForClose(context.code, context.reason);
    if (
      shouldPauseGatewayReconnect({
        details,
        deviceTokenRetryPending: this.pendingDeviceTokenRetry,
        tokenMismatchIsTerminal: true,
        clientVersionMismatchIsTerminal: true,
      })
    ) {
      this.notifyReconnectPaused({ code: context.code, reason: context.reason, detailCode });
      return { retry: false, notify: true };
    }
    return {
      retry: true,
      notify: true,
      reconnectDelayMs: context.connectFailure?.reconnectDelayMs,
    };
  }

  private closeInfo(context: GatewayProtocolCloseContext): GatewayClientCloseInfo {
    return {
      phase: context.helloReceived ? "post-hello" : "pre-hello",
      socketOpened: context.socketOpened,
      transportValidated: this.transportValidated,
      transientPreHelloCleanClose:
        !context.helloReceived && context.code === 1000 && context.reason === "",
    };
  }

  private clearStaleDeviceTokenForClose(code: number, reason: string): void {
    if (
      code !== 1008 ||
      !normalizeLowercaseStringOrEmpty(reason).includes("device token mismatch") ||
      this.opts.token ||
      this.opts.password ||
      !this.opts.deviceIdentity
    ) {
      return;
    }
    const deviceId = this.opts.deviceIdentity.deviceId;
    const role = this.opts.role ?? "operator";
    try {
      this.deps.clearDeviceAuthToken({ deviceId, role, env: this.opts.env });
      this.logDebug(`cleared stale device-auth token for device ${deviceId}`);
    } catch (error) {
      this.logDebug(
        `failed clearing stale device-auth token for device ${deviceId}: ${String(error)}`,
      );
    }
  }

  private notifyConnectError(error: Error) {
    try {
      this.opts.onConnectError?.(error);
    } catch (err) {
      this.logDebug(
        `gateway client connect error handler error: ${formatGatewayClientErrorForLog(err)}`,
      );
    }
  }

  private notifyReconnectPaused(info: GatewayReconnectPausedInfo): void {
    try {
      this.opts.onReconnectPaused?.(info);
    } catch (err) {
      this.logDebug(
        `gateway client reconnect paused handler error: ${formatGatewayClientErrorForLog(err)}`,
      );
    }
  }

  private shouldRetryWithoutApprovalRuntimeToken(params: {
    error: unknown;
    authApprovalRuntimeToken?: string;
  }): boolean {
    if (this.approvalRuntimeTokenRetryBudgetUsed) {
      return false;
    }
    if (!params.authApprovalRuntimeToken) {
      return false;
    }
    if (!(params.error instanceof GatewayClientRequestError)) {
      return false;
    }
    if (params.error.gatewayCode !== "INVALID_REQUEST") {
      return false;
    }
    const message = normalizeLowercaseStringOrEmpty(params.error.message);
    return message.includes("invalid connect params") && message.includes("approvalruntimetoken");
  }

  private shouldFailClosedForUnsupportedAgentRuntimeIdentity(params: {
    error: unknown;
    authAgentRuntimeIdentityToken?: string;
  }): boolean {
    if (!params.authAgentRuntimeIdentityToken) {
      return false;
    }
    if (!(params.error instanceof GatewayClientRequestError)) {
      return false;
    }
    if (params.error.gatewayCode !== "INVALID_REQUEST") {
      return false;
    }
    const message = normalizeLowercaseStringOrEmpty(params.error.message);
    return (
      message.includes("invalid connect params") && message.includes("agentruntimeidentitytoken")
    );
  }

  private isTrustedDeviceRetryEndpoint(): boolean {
    const rawUrl = this.opts.url ?? "ws://127.0.0.1:18789";
    try {
      const parsed = new URL(rawUrl);
      const protocol =
        parsed.protocol === "https:"
          ? "wss:"
          : parsed.protocol === "http:"
            ? "ws:"
            : parsed.protocol;
      if (isLoopbackHost(parsed.hostname)) {
        return true;
      }
      return protocol === "wss:" && Boolean(this.opts.tlsFingerprint?.trim());
    } catch {
      return false;
    }
  }

  private selectConnectAuth(role: string): GatewayConnectAuthSelection {
    const storedAuth = this.opts.deviceIdentity
      ? this.deps.loadDeviceAuthToken({
          deviceId: this.opts.deviceIdentity.deviceId,
          role,
          env: this.opts.env,
        })
      : null;
    return selectGatewayConnectAuth({
      token: this.opts.token,
      bootstrapToken: this.opts.bootstrapToken,
      deviceToken: this.opts.deviceToken,
      password: this.opts.password,
      approvalRuntimeToken: this.approvalRuntimeTokenCompatibilityDisabled
        ? undefined
        : this.opts.approvalRuntimeToken,
      agentRuntimeIdentityToken: this.opts.agentRuntimeIdentityToken,
      storedToken: storedAuth?.token,
      storedScopes: storedAuth?.scopes,
      pendingDeviceTokenRetry: this.pendingDeviceTokenRetry,
      trustedDeviceTokenRetry: this.isTrustedDeviceRetryEndpoint(),
    });
  }

  private startTickWatch() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
    }
    const rawMinInterval = this.opts.tickWatchMinIntervalMs;
    const minInterval =
      typeof rawMinInterval === "number" && Number.isFinite(rawMinInterval)
        ? Math.max(1, Math.min(30_000, rawMinInterval))
        : 1000;
    const interval = resolveSafeTimeoutDelayMs(Math.max(this.tickIntervalMs, minInterval));
    this.tickTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      if (!this.lastTick) {
        return;
      }
      const allPendingRequestsHaveTimeouts =
        this.protocol.hasPendingRequests && !this.protocol.hasUnboundedPendingRequests;
      // Finite requests own their deadline. One unbounded request keeps the
      // transport watchdog active so a dead socket cannot strand it forever.
      if (allPendingRequestsHaveTimeouts) {
        return;
      }
      const gap = Date.now() - this.lastTick;
      const rawTimeoutMs = this.opts.tickWatchTimeoutMs;
      // Normal gateways use the server-advertised tick interval. Long-running
      // harness clients can widen the threshold without mutating internals.
      const timeoutMs =
        typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs)
          ? Math.max(1, rawTimeoutMs)
          : this.tickIntervalMs * 2;
      if (gap > timeoutMs) {
        this.protocol.closeSocket(4000, "tick timeout");
      }
    }, interval);
  }

  private validateTlsFingerprint(): Error | null {
    if (!this.opts.tlsFingerprint || !this.ws) {
      return null;
    }
    const expected = this.deps.normalizeTlsFingerprint(this.opts.tlsFingerprint);
    if (!expected) {
      return new Error("gateway tls fingerprint missing");
    }
    const socket = (
      this.ws as WebSocket & {
        _socket?: { getPeerCertificate?: () => { fingerprint256?: string } };
      }
    )["_socket"];
    if (!socket || typeof socket.getPeerCertificate !== "function") {
      return new Error("gateway tls fingerprint unavailable");
    }
    const cert = socket.getPeerCertificate();
    const fingerprint = this.deps.normalizeTlsFingerprint(cert?.fingerprint256 ?? "");
    if (!fingerprint) {
      return new Error("gateway tls fingerprint unavailable");
    }
    if (fingerprint !== expected) {
      return new Error("gateway tls fingerprint mismatch");
    }
    return null;
  }

  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    const expectFinal = opts?.expectFinal === true;
    const timeoutMs =
      opts?.timeoutMs === null
        ? null
        : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
          ? resolveSafeTimeoutDelayMs(opts.timeoutMs, { minMs: 0 })
          : expectFinal
            ? null
            : this.requestTimeoutMs;
    return this.protocol.request<T>(method, params, {
      expectFinal,
      timeoutMs,
      signal: opts?.signal,
      onAccepted: opts?.onAccepted,
    });
  }
}

function createGatewayRequestAbortError(method: string): Error {
  const err = new Error(`gateway request aborted for ${method}`);
  err.name = "AbortError";
  return err;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

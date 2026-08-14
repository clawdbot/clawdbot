import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage } from "node:http";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "@openclaw/gateway-protocol/client-info";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
} from "@openclaw/gateway-protocol/connect-error-details";
import type { ConnectParams, EventFrame, HelloOk } from "@openclaw/gateway-protocol/frame-guards";
import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-protocol/startup-unavailable";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@openclaw/gateway-protocol/version";
import { WebSocket } from "ws";
import {
  isSensitiveUrlQueryParamName,
  normalizeTlsFingerprint,
  normalizeGatewayErrorText,
} from "./client-address-utils.js";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "./cloudflare-access.js";
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
  type GatewayProtocolCloseContext,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "./protocol-client.js";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "./protocol-request.js";
import { shouldPauseGatewayReconnect } from "./reconnect-policy.js";
import { GatewayClientRequestError } from "./request-error.js";
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveConnectChallengeTimeoutMs,
  resolvePreauthHandshakeTimeoutMs,
  resolveSafeTimeoutDelayMs,
} from "./timeouts.js";
import { rawDataToString } from "./websocket-data.js";
import {
  GatewayWebSocketTransportConfigurationError,
  isGatewayLoopbackHost,
  resolveGatewayWebSocketTransport,
} from "./websocket-transport.js";

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
  normalizeTlsFingerprint,
};

function resolveHostDeps(overrides?: GatewayClientHostDeps): Required<GatewayClientHostDeps> {
  return Object.fromEntries(
    Object.entries(DEFAULT_HOST_DEPS).map(([key, fallback]) => [
      key,
      overrides?.[key as keyof GatewayClientHostDeps] ?? fallback,
    ]),
  ) as Required<GatewayClientHostDeps>;
}

export type GatewayClientRequestOptions = GatewayProtocolRequestOptions;

type AssembledConnect = {
  params: ConnectParams;
  authApprovalRuntimeToken: string | undefined;
  authAgentRuntimeIdentityToken: string | undefined;
  resolvedDeviceToken: string | undefined;
  storedScopes: string[] | undefined;
  storedToken: string | undefined;
  usingStoredDeviceToken: boolean | undefined;
};

const DEFAULT_GATEWAY_CLIENT_URL = "ws://127.0.0.1:18789";
const DEFAULT_CLIENT_VERSION = "0.0.0";
const MAX_UPGRADE_ERROR_BODY_BYTES = 2 * 1024;
const UPGRADE_ERROR_BODY_TIMEOUT_MS = 1_000;

async function readUpgradeErrorBody(response: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      response.off("data", onData);
      response.off("end", finish);
      response.off("error", finish);
      response.off("aborted", finish);
      resolve(Buffer.concat(chunks, totalBytes).toString("utf8").replace(/\s+/gu, " ").trim());
    };
    const stop = () => {
      finish();
      response.destroy();
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_UPGRADE_ERROR_BODY_BYTES - totalBytes;
      if (remaining > 0) {
        const prefix = buffer.subarray(0, remaining);
        chunks.push(prefix);
        totalBytes += prefix.byteLength;
      }
      if (buffer.byteLength >= remaining) {
        stop();
      }
    };
    const timer = setTimeout(stop, UPGRADE_ERROR_BODY_TIMEOUT_MS);
    timer.unref?.();
    response.on("data", onData);
    response.once("end", finish);
    response.once("error", finish);
    response.once("aborted", finish);
  });
}

export type GatewayReconnectPausedInfo = {
  code: number;
  reason: string;
  detailCode: string | null;
};

export type GatewayClientCloseInfo = {
  phase: "pre-hello" | "post-hello";
  socketOpened: boolean;
  transportValidated: boolean;
  connectRequestSent?: boolean;
  transientPreHelloCleanClose: boolean;
  connectError?: Error;
};

export { GatewayClientRequestError } from "./request-error.js";

export class GatewayClientRequestTimeoutError extends GatewayProtocolRequestTimeoutError {
  constructor(params: { method: string; timeoutMs: number; requestSent: boolean }) {
    super(params, `gateway request timeout for ${params.method}`);
    this.name = "GatewayClientRequestTimeoutError";
  }
}

class GatewayClientTransportPolicyError extends GatewayWebSocketTransportConfigurationError {}

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
  /** Closed Cloudflare Access service-token pair for this configured Gateway origin. */
  cloudflareAccess?: CloudflareAccessCredentials;
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
  /** Prefer one setup credential for the first successful device-auth exchange. */
  preferBootstrapToken?: boolean;
  deviceToken?: string;
  password?: string;
  approvalRuntimeToken?: string;
  agentRuntimeIdentityToken?: string;
  instanceId?: string;
  clientName?: GatewayClientName;
  clientDisplayName?: string;
  clientVersion?: string;
  clientBuildId?: string;
  platform?: string;
  deviceFamily?: string;
  mode?: GatewayClientMode;
  role?: string;
  scopes?: string[];
  caps?: string[];
  commands?: string[];
  computerUse?: ConnectParams["computerUse"];
  /** @deprecated Compatibility for the shipped v1 node-host connect envelope. */
  workerRuns?: ConnectParams["workerRuns"];
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
  /** Report retryable startup closes for clients that present connection progress. */
  notifyOnStartupRetry?: boolean;
  onClose?: (code: number, reason: string, info?: GatewayClientCloseInfo) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export type GatewayClientConnectionMetadata = {
  clientName?: GatewayClientName;
  hasDeviceIdentity: boolean;
  mode?: GatewayClientMode;
  preauthHandshakeTimeoutMs?: number;
};

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

const FORCE_STOP_TERMINATE_GRACE_MS = 250;
const STOP_AND_WAIT_TIMEOUT_MS = 1_000;
const MAX_SUPPRESSED_TRANSIENT_PRE_HELLO_CLEAN_CLOSES = 1;

function resolveLegacyNodePlatform(platform: string): string | undefined {
  switch (platform) {
    case "macos":
      return "darwin";
    case "windows":
      return "win32";
    default:
      return undefined;
  }
}

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
  private useLegacyNodeProtocolEnvelope = false;
  private nodeProtocolTransitionPending = false;
  private suppressNextHelloCallback = false;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private approvalRuntimeTokenCompatibilityDisabled = false;
  private approvalRuntimeTokenRetryBudgetUsed = false;
  // Track last tick to detect silent stalls.
  private lastTick: number | null = null;
  // Server capabilities from the current connection's hello; a reconnect may land on a
  // different build, so this is replaced on every hello rather than accumulated.
  private serverCapabilities: ReadonlySet<string> = new Set<string>();
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
        ? opts.requestTimeoutMs
        : DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
    const connectChallengeTimeoutMs = resolveConnectChallengeTimeoutMs(
      this.opts.connectChallengeTimeoutMs,
      {
        env: this.opts.env,
        configuredTimeoutMs: this.opts.preauthHandshakeTimeoutMs,
      },
    );
    this.protocol = new GatewayProtocolClient<AssembledConnect>({
      createSocket: (handlers) => this.createSocket(handlers),
      createRequestId: randomUUID,
      createRequestError: (error) => new GatewayClientRequestError(error),
      createRequestTimeoutError: (method, timeoutMs, requestSent) =>
        new GatewayClientRequestTimeoutError({ method, timeoutMs, requestSent }),
      createRequestAbortError: createGatewayRequestAbortError,
      buildConnectPlan: ({ nonce, challengeTs }) => {
        if (!nonce) {
          throw new Error("gateway connect challenge missing nonce");
        }
        if (this.opts.deviceIdentity && challengeTs == null) {
          throw new Error("gateway connect challenge timestamp invalid");
        }
        return this.assembleConnectParams({
          role: this.opts.role ?? "operator",
          nonce,
          signedAtMs: challengeTs ?? Date.now(),
        });
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
      onHello: (hello) => {
        if (this.suppressNextHelloCallback) {
          this.suppressNextHelloCallback = false;
          return;
        }
        this.opts.onHelloOk?.(hello);
      },
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
        timeoutMs: connectChallengeTimeoutMs,
        timeoutMessage: (elapsedMs) =>
          `gateway connect challenge timeout (waited ${elapsedMs}ms, limit ${connectChallengeTimeoutMs}ms)`,
      },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
      requestTimeoutMs: this.requestTimeoutMs,
      shouldRetrySocketFactoryError: (error) =>
        !(error instanceof GatewayWebSocketTransportConfigurationError) &&
        !(error instanceof SyntaxError) &&
        !(error instanceof TypeError) &&
        !(error instanceof RangeError),
      rethrowSocketFactoryError: (error) => error instanceof GatewayClientTransportPolicyError,
    });
  }

  /**
   * Whether the connected Gateway advertised this capability on hello. Older Gateways omit
   * newer entries, so callers must treat `false` as "not supported" and degrade rather than
   * send a request field a closed schema would reject.
   */
  hasServerCapability(capability: string): boolean {
    return this.serverCapabilities.has(capability);
  }

  getConnectionMetadata(): GatewayClientConnectionMetadata {
    return {
      clientName: this.opts.clientName,
      hasDeviceIdentity: Boolean(this.opts.deviceIdentity),
      mode: this.opts.mode,
      preauthHandshakeTimeoutMs: this.opts.preauthHandshakeTimeoutMs,
    };
  }

  updateNodeManifest(manifest: {
    caps: string[];
    commands: string[];
    computerUse?: ConnectParams["computerUse"];
    /** @deprecated Compatibility for the shipped v1 node-host connect envelope. */
    workerRuns?: ConnectParams["workerRuns"];
  }): void {
    this.opts = {
      ...this.opts,
      caps: [...manifest.caps],
      commands: [...manifest.commands],
      computerUse:
        manifest.computerUse === undefined ? undefined : structuredClone(manifest.computerUse),
      workerRuns: manifest.workerRuns ? structuredClone(manifest.workerRuns) : undefined,
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
    if (this.opts.cloudflareAccess && new URL(url).protocol !== "wss:") {
      throw new GatewayWebSocketTransportConfigurationError(
        "Cloudflare Access credentials require a wss:// Gateway URL",
      );
    }
    // Block plaintext before device-token lookup. Credentials may be loaded from
    // host storage later in sendConnect(), and chat payloads are sensitive too.
    const handshakeTimeoutMs = resolvePreauthHandshakeTimeoutMs({
      env: this.opts.env,
      configuredTimeoutMs: this.opts.preauthHandshakeTimeoutMs,
    });
    const transport = resolveGatewayWebSocketTransport({
      url,
      tlsFingerprint: this.opts.tlsFingerprint,
      env: this.opts.env,
      normalizeTlsFingerprint: this.deps.normalizeTlsFingerprint,
      options: {
        // Allow node screen snapshots and other large responses. The challenge
        // timer starts after open, so separately bound the HTTP upgrade here.
        maxPayload: 25 * 1024 * 1024,
        handshakeTimeout: handshakeTimeoutMs,
        ...(this.opts.origin ? { origin: this.opts.origin } : {}),
        ...(this.opts.cloudflareAccess
          ? {
              followRedirects: false,
              headers: buildCloudflareAccessHeaders(this.opts.cloudflareAccess),
            }
          : {}),
      },
    });
    this.deps.beforeConnect();
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
      ws = new WebSocket(url, transport.options);
      ws.binaryType = "nodebuffer";
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      unregisterGatewayLoopbackBypass?.();
    }
    this.ws = ws;
    this.transportValidated = false;
    let upgradeError: GatewayClientRequestError | undefined;
    ws.on("open", () => {
      handlers.open();
      const tlsError = transport.validateSocket(ws);
      if (tlsError) {
        handlers.error(tlsError);
        ws.close(1008, tlsError.message);
        return;
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
    ws.on("unexpected-response", (request: ClientRequest, response: IncomingMessage) => {
      void readUpgradeErrorBody(response).then((body) => {
        const statusCode = response.statusCode;
        const message = `gateway rejected websocket upgrade (HTTP ${statusCode ?? "unknown"})${body ? `: ${body}` : ""}`;
        upgradeError = new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message,
          retryable: true,
          details: {
            reason: "websocket-upgrade-rejected",
            ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
          },
        });
        handlers.error(upgradeError);
        request.destroy();
        ws.close();
      });
    });
    ws.on("error", (err) => {
      if (upgradeError) {
        return;
      }
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

  private assembleConnectParams(params: {
    role: string;
    nonce: string;
    signedAtMs: number;
  }): AssembledConnect {
    const { role, nonce, signedAtMs } = params;
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
    const scopes = resolveGatewayConnectScopes({
      requestedScopes: this.opts.scopes,
      usingStoredDeviceToken,
      storedScopes,
      defaultScopes: ["operator.admin"],
    });
    const clientMode = this.opts.mode ?? GATEWAY_CLIENT_MODES.BACKEND;
    const clientId = this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT;
    const isBuiltInNodeHost =
      role === "node" &&
      clientMode === GATEWAY_CLIENT_MODES.NODE &&
      clientId === GATEWAY_CLIENT_NAMES.NODE_HOST;
    const negotiatesNodeProtocol = this.shouldNegotiateLegacyNodeProtocol();
    const useLegacyNodeProtocolEnvelope =
      isBuiltInNodeHost &&
      (this.useLegacyNodeProtocolEnvelope ||
        (this.opts.maxProtocol === MIN_NODE_PROTOCOL_VERSION &&
          (this.opts.minProtocol ?? MIN_NODE_PROTOCOL_VERSION) <= MIN_NODE_PROTOCOL_VERSION));
    // Match server admission: only probes and exact node role+mode identities
    // may advertise specialized floors; every other client stays current-only.
    const minProtocol = useLegacyNodeProtocolEnvelope
      ? MIN_NODE_PROTOCOL_VERSION
      : negotiatesNodeProtocol
        ? PROTOCOL_VERSION
        : (this.opts.minProtocol ??
          (clientMode === GATEWAY_CLIENT_MODES.PROBE
            ? MIN_PROBE_PROTOCOL_VERSION
            : role === "node" && clientMode === GATEWAY_CLIENT_MODES.NODE
              ? MIN_NODE_PROTOCOL_VERSION
              : MIN_CLIENT_PROTOCOL_VERSION));
    const maxProtocol = useLegacyNodeProtocolEnvelope
      ? MIN_NODE_PROTOCOL_VERSION
      : negotiatesNodeProtocol
        ? PROTOCOL_VERSION
        : (this.opts.maxProtocol ?? PROTOCOL_VERSION);
    const configuredPlatform = this.opts.platform ?? process.platform;
    // A released v3 Gateway rejects v4 before authentication, so the retry can
    // reproduce the shipped node-host envelope without mutating v4 pairings.
    const platform = useLegacyNodeProtocolEnvelope
      ? (resolveLegacyNodePlatform(configuredPlatform) ?? configuredPlatform)
      : configuredPlatform;
    const deviceFamily = useLegacyNodeProtocolEnvelope ? undefined : this.opts.deviceFamily;

    return {
      params: {
        minProtocol,
        maxProtocol,
        client: {
          id: clientId,
          displayName: this.opts.clientDisplayName,
          version: this.opts.clientVersion ?? DEFAULT_CLIENT_VERSION,
          buildId: this.opts.clientBuildId,
          platform,
          deviceFamily,
          mode: clientMode,
          instanceId: this.opts.instanceId,
        },
        caps: Array.isArray(this.opts.caps) ? this.opts.caps : [],
        commands: Array.isArray(this.opts.commands) ? this.opts.commands : undefined,
        computerUse: useLegacyNodeProtocolEnvelope ? undefined : this.opts.computerUse,
        workerRuns: useLegacyNodeProtocolEnvelope ? undefined : this.opts.workerRuns,
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
          deviceFamily,
          clientMode,
        }),
      },
      authApprovalRuntimeToken,
      authAgentRuntimeIdentityToken,
      resolvedDeviceToken,
      storedScopes,
      storedToken,
      usingStoredDeviceToken,
    };
  }

  private shouldNegotiateLegacyNodeProtocol(): boolean {
    if (
      this.opts.role !== "node" ||
      this.opts.mode !== GATEWAY_CLIENT_MODES.NODE ||
      this.opts.clientName !== GATEWAY_CLIENT_NAMES.NODE_HOST
    ) {
      return false;
    }
    return (
      (this.opts.minProtocol ?? MIN_NODE_PROTOCOL_VERSION) === MIN_NODE_PROTOCOL_VERSION &&
      (this.opts.maxProtocol ?? PROTOCOL_VERSION) === PROTOCOL_VERSION
    );
  }

  private shouldRetryWithLegacyNodeProtocol(error: GatewayProtocolRequestError): boolean {
    if (
      this.useLegacyNodeProtocolEnvelope ||
      !this.shouldNegotiateLegacyNodeProtocol() ||
      !(error instanceof GatewayClientRequestError)
    ) {
      return false;
    }
    const detailCode = readConnectErrorDetailCode(error.details);
    const expectedProtocol = (error.details as { expectedProtocol?: unknown } | null | undefined)
      ?.expectedProtocol;
    return (
      expectedProtocol === MIN_NODE_PROTOCOL_VERSION &&
      (detailCode === ConnectErrorDetailCodes.PROTOCOL_MISMATCH ||
        normalizeGatewayErrorText(error.message).includes("protocol mismatch"))
    );
  }

  private shouldRetryWithCurrentNodeProtocol(error: GatewayProtocolRequestError): boolean {
    if (
      !this.useLegacyNodeProtocolEnvelope ||
      !this.shouldNegotiateLegacyNodeProtocol() ||
      !(error instanceof GatewayClientRequestError)
    ) {
      return false;
    }
    const detailCode = readConnectErrorDetailCode(error.details);
    const expectedProtocol = (error.details as { expectedProtocol?: unknown } | null | undefined)
      ?.expectedProtocol;
    return (
      expectedProtocol === PROTOCOL_VERSION &&
      (detailCode === ConnectErrorDetailCodes.PROTOCOL_MISMATCH ||
        normalizeGatewayErrorText(error.message).includes("protocol mismatch"))
    );
  }

  private buildDeviceConnectParams(params: {
    nonce: string;
    role: string;
    scopes: string[];
    signatureToken: string | undefined;
    signedAtMs: number;
    platform: string;
    deviceFamily: string | undefined;
    clientMode: GatewayClientMode;
  }): ConnectParams["device"] {
    if (!this.opts.deviceIdentity) {
      return undefined;
    }
    const { nonce, role, scopes, signatureToken, signedAtMs, platform, deviceFamily, clientMode } =
      params;
    // The signed payload mirrors server verification exactly; keep metadata
    // normalized here so different hosts sign the same logical device facts.
    const payload = buildDeviceAuthPayloadV3({
      deviceId: this.opts.deviceIdentity.deviceId,
      clientId: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: signatureToken ?? null,
      nonce,
      platform,
      deviceFamily,
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
    const reconnectWithCurrentNodeProtocol =
      this.useLegacyNodeProtocolEnvelope &&
      this.shouldNegotiateLegacyNodeProtocol() &&
      helloOk.protocol > MIN_NODE_PROTOCOL_VERSION;
    if (reconnectWithCurrentNodeProtocol) {
      this.useLegacyNodeProtocolEnvelope = false;
    }
    this.nodeProtocolTransitionPending = false;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.suppressedTransientPreHelloCleanCloses = 0;
    const role = this.opts.role ?? "operator";
    const authInfo = helloOk.auth;
    if (authInfo?.deviceToken && this.opts.deviceIdentity) {
      const tokenRole = authInfo.role ?? role;
      const scopes =
        tokenRole === role && authInfo.deviceToken === assembled.storedToken
          ? (assembled.storedScopes ?? authInfo.scopes ?? [])
          : (authInfo.scopes ?? []);
      this.deps.storeDeviceAuthToken({
        deviceId: this.opts.deviceIdentity.deviceId,
        role: tokenRole,
        token: authInfo.deviceToken,
        scopes,
        env: this.opts.env,
      });
    }
    if (this.opts.preferBootstrapToken) {
      // The setup credential is single-use; reconnects must use the stored device token.
      this.opts.token = undefined;
      this.opts.bootstrapToken = undefined;
      this.opts.password = undefined;
      this.opts.preferBootstrapToken = false;
    }
    this.serverCapabilities = new Set(helloOk.features?.capabilities ?? []);
    this.tickIntervalMs =
      typeof helloOk.policy?.tickIntervalMs === "number" ? helloOk.policy.tickIntervalMs : 30_000;
    if (reconnectWithCurrentNodeProtocol) {
      // A v4 Gateway accepted the exact-v3 probe as a legacy session. Reconnect
      // before reporting readiness so node capabilities are not silently filtered.
      this.suppressNextHelloCallback = true;
      this.protocol.resetReconnectBackoff(250);
      this.protocol.closeSocket(1012, "gateway protocol upgraded");
      return;
    }
    this.lastTick = Date.now();
    this.startTickWatch();
    void assembled;
  }

  private handleConnectRequestFailure(
    error: GatewayProtocolRequestError,
    assembled: AssembledConnect,
  ) {
    if (this.shouldRetryWithCurrentNodeProtocol(error)) {
      const resetBackoff = !this.nodeProtocolTransitionPending;
      this.useLegacyNodeProtocolEnvelope = false;
      this.nodeProtocolTransitionPending = true;
      if (resetBackoff) {
        this.protocol.resetReconnectBackoff(250);
      }
      this.logDebug("gateway rejected protocol v3; retrying node host with protocol v4");
      return { closeCode: 1008, closeReason: "connect retry" };
    }
    if (this.shouldRetryWithLegacyNodeProtocol(error)) {
      const resetBackoff = !this.nodeProtocolTransitionPending;
      this.useLegacyNodeProtocolEnvelope = true;
      this.nodeProtocolTransitionPending = true;
      if (resetBackoff) {
        this.protocol.resetReconnectBackoff(250);
      }
      this.logDebug("gateway rejected protocol v4; retrying node host with protocol v3");
      return { closeCode: 1008, closeReason: "connect retry" };
    }
    const role = this.opts.role ?? "operator";
    const detailCode =
      error instanceof GatewayClientRequestError ? readConnectErrorDetailCode(error.details) : null;
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
      detailCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
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
    if (
      this.opts.mode === GATEWAY_CLIENT_MODES.PROBE ||
      isGatewayClientStoppedError(error) ||
      detailCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED
    ) {
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
        notify: this.opts.notifyOnStartupRetry === true,
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
        pendingError: new Error("gateway transient pre-hello clean close"),
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
      connectRequestSent: context.connectRequestSent,
      transientPreHelloCleanClose:
        !context.helloReceived && context.code === 1000 && context.reason === "",
      ...(context.connectFailure?.error ? { connectError: context.connectFailure.error } : {}),
    };
  }

  private clearStaleDeviceTokenForClose(code: number, reason: string): void {
    if (
      code !== 1008 ||
      !normalizeGatewayErrorText(reason).includes("device token mismatch") ||
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
    const message = normalizeGatewayErrorText(params.error.message);
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
    const message = normalizeGatewayErrorText(params.error.message);
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
      if (isGatewayLoopbackHost(parsed.hostname)) {
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
      preferBootstrapToken: this.opts.preferBootstrapToken,
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
          ? opts.timeoutMs
          : expectFinal
            ? null
            : this.requestTimeoutMs;
    return this.protocol.request<T>(method, params, {
      expectFinal,
      timeoutMs,
      signal: opts?.signal,
      onSent: opts?.onSent,
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

import { randomUUID } from "node:crypto";
import type {
  ConnectParams,
  EventFrame,
  HelloOk,
  RequestFrame,
  ResponseFrame,
} from "@openclaw/gateway-protocol";
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
  readConnectErrorRecoveryAdvice,
  readPairingConnectErrorDetails,
  type ConnectErrorRecoveryAdvice,
} from "@openclaw/gateway-protocol/connect-error-details";
import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-protocol/startup-unavailable";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import ipaddr from "ipaddr.js";
import { WebSocket, type ClientOptions, type CertMeta } from "ws";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { resolveConnectChallengeTimeoutMs, resolveSafeTimeoutDelayMs } from "./timeouts.js";

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

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGatewayClientErrorShape(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.code) || !isNonEmptyString(value.message)) {
    return false;
  }
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    return false;
  }
  if (value.retryAfterMs !== undefined && !isNonNegativeInteger(value.retryAfterMs)) {
    return false;
  }
  return true;
}

function isGatewayEventFrame(value: unknown): value is EventFrame {
  if (!isRecord(value) || value.type !== "event" || !isNonEmptyString(value.event)) {
    return false;
  }
  return value.seq === undefined || isNonNegativeInteger(value.seq);
}

function isGatewayResponseFrame(value: unknown): value is ResponseFrame {
  if (
    !isRecord(value) ||
    value.type !== "res" ||
    !isNonEmptyString(value.id) ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.error === undefined || isGatewayClientErrorShape(value.error);
}

function validateClientRequestFrame(frame: RequestFrame): string | null {
  if (!isNonEmptyString(frame.id)) {
    return "id must be a non-empty string";
  }
  if (!isNonEmptyString(frame.method)) {
    return "method must be a non-empty string";
  }
  return null;
}

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => Buffer.from(entry))).toString("utf8");
  }
  return String(data);
}

function isSensitiveUrlQueryParamName(key: string): boolean {
  return /(?:token|password|secret|key|auth|credential)/iu.test(key);
}

function normalizeFingerprint(fingerprint: string | undefined): string {
  return (fingerprint ?? "").replaceAll(":", "").trim().toLowerCase();
}

function parseHostForAddressChecks(
  host: string,
): { isLocalhost: boolean; unbracketedHost: string } | null {
  if (!host) {
    return null;
  }
  const normalizedHost = host.toLowerCase().trim();
  const canonicalHost = normalizedHost.replace(/\.+$/, "");
  if (canonicalHost === "localhost") {
    return { isLocalhost: true, unbracketedHost: canonicalHost };
  }
  return {
    isLocalhost: false,
    // URL.hostname canonicalizes IPv6 with brackets in some call sites. Strip
    // them before net.isIP so address checks do not fall back to hostname rules.
    unbracketedHost:
      normalizedHost.startsWith("[") && normalizedHost.endsWith("]")
        ? normalizedHost.slice(1, -1)
        : normalizedHost,
  };
}

type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;

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

function parseGatewayIpAddress(host: string): ParsedIpAddress | null {
  const normalized = host.toLowerCase();
  if (ipaddr.IPv4.isValid(normalized) && !ipaddr.IPv4.isValidFourPartDecimal(normalized)) {
    return null;
  }
  if (!ipaddr.isValid(normalized)) {
    return null;
  }
  const parsed = ipaddr.parse(normalized);
  // WHATWG URL canonicalization can turn ::ffff:127.0.0.1 into ::ffff:7f00:1.
  // Normalize mapped forms so IPv4 loopback/private policy stays identical.
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return ipv6.toIPv4Address();
    }
  }
  return parsed;
}

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
  const address = parseGatewayIpAddress(parsed.unbracketedHost);
  if (!address) {
    return false;
  }
  return address.range() === "loopback";
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
        isPrivateOrLoopbackHost(url.hostname) || parseGatewayIpAddress(hostForIpCheck) === null
      );
    }
    return false;
  } catch {
    return false;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  expectFinal: boolean;
  timeout: NodeJS.Timeout | null;
  cleanup?: () => void;
  onAccepted?: (payload: unknown) => void;
  acceptedNotified?: boolean;
};

export type GatewayClientRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** Called once for expectFinal requests after an accepted response, before the final result. */
  onAccepted?: (payload: unknown) => void;
};

type GatewayClientErrorShape = {
  code?: string;
  message?: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

type SelectedConnectAuth = {
  authToken?: string;
  authBootstrapToken?: string;
  authDeviceToken?: string;
  authPassword?: string;
  authApprovalRuntimeToken?: string;
  signatureToken?: string;
  resolvedDeviceToken?: string;
  storedToken?: string;
  storedScopes?: string[];
  usingStoredDeviceToken?: boolean;
};

type StoredDeviceAuth = {
  token?: string;
  scopes?: string[];
};

type AssembledConnect = {
  params: ConnectParams;
  authApprovalRuntimeToken: string | undefined;
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

export class GatewayClientRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error: GatewayClientErrorShape) {
    super(formatConnectErrorMessage({ message: error.message, details: error.details }));
    this.name = "GatewayClientRequestError";
    this.gatewayCode = error.code ?? "UNAVAILABLE";
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

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
  connectChallengeTimeoutMs?: number;
  /** @deprecated Use connectChallengeTimeoutMs. */
  connectDelayMs?: number;
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
  onClose?: (code: number, reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

export const GATEWAY_CLOSE_CODE_HINTS: Readonly<Record<number, string>> = {
  1000: "normal closure",
  1006: "abnormal closure (no close frame)",
  1008: "policy violation",
  1012: "service restart",
  1013: "try again later",
};

export function describeGatewayCloseCode(code: number): string | undefined {
  return GATEWAY_CLOSE_CODE_HINTS[code];
}

function readConnectChallengeTimeoutOverride(
  opts: Pick<GatewayClientOptions, "connectChallengeTimeoutMs" | "connectDelayMs">,
): number | undefined {
  if (
    typeof opts.connectChallengeTimeoutMs === "number" &&
    Number.isFinite(opts.connectChallengeTimeoutMs)
  ) {
    return opts.connectChallengeTimeoutMs;
  }
  if (typeof opts.connectDelayMs === "number" && Number.isFinite(opts.connectDelayMs)) {
    return opts.connectDelayMs;
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

export function resolveGatewayClientConnectChallengeTimeoutMs(
  opts: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs"
  >,
): number {
  return resolveConnectChallengeTimeoutMs(readConnectChallengeTimeoutOverride(opts), {
    configuredTimeoutMs: opts.preauthHandshakeTimeoutMs,
  });
}

const FORCE_STOP_TERMINATE_GRACE_MS = 250;
const STOP_AND_WAIT_TIMEOUT_MS = 1_000;

type PendingStop = {
  ws: WebSocket;
  promise: Promise<void>;
  resolve: () => void;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private opts: GatewayClientOptions;
  private deps: Required<GatewayClientHostDeps>;
  private pending = new Map<string, Pending>();
  private backoffMs = 1000;
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private approvalRuntimeTokenCompatibilityDisabled = false;
  private approvalRuntimeTokenRetryBudgetUsed = false;
  private pendingStartupReconnectDelayMs: number | null = null;
  private pendingConnectErrorDetailCode: string | null = null;
  private pendingConnectErrorDetails: unknown = null;
  // Track last tick to detect silent stalls.
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly requestTimeoutMs: number;
  private pendingStop: PendingStop | null = null;
  private socketOpened = false;

  constructor(opts: GatewayClientOptions) {
    this.deps = {
      // Defaults keep the package inert outside OpenClaw; device signing throws
      // only when a caller actually supplies a device identity without host deps.
      loadOrCreateDeviceIdentity: opts.hostDeps?.loadOrCreateDeviceIdentity ?? (() => undefined),
      signDevicePayload:
        opts.hostDeps?.signDevicePayload ??
        (() => {
          throw new Error("GatewayClient device signature dependency is not configured");
        }),
      publicKeyRawBase64UrlFromPem:
        opts.hostDeps?.publicKeyRawBase64UrlFromPem ??
        (() => {
          throw new Error("GatewayClient public key dependency is not configured");
        }),
      loadDeviceAuthToken: opts.hostDeps?.loadDeviceAuthToken ?? (() => null),
      storeDeviceAuthToken: opts.hostDeps?.storeDeviceAuthToken ?? (() => {}),
      clearDeviceAuthToken: opts.hostDeps?.clearDeviceAuthToken ?? (() => {}),
      beforeConnect: opts.hostDeps?.beforeConnect ?? (() => {}),
      registerGatewayLoopbackBypass:
        opts.hostDeps?.registerGatewayLoopbackBypass ?? (() => undefined),
      logDebug: opts.hostDeps?.logDebug ?? (() => {}),
      logError: opts.hostDeps?.logError ?? (() => {}),
      redactForLog: opts.hostDeps?.redactForLog ?? ((message) => message),
      normalizeTlsFingerprint: opts.hostDeps?.normalizeTlsFingerprint ?? normalizeFingerprint,
    };
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
  }

  start() {
    if (this.closed) {
      return;
    }
    this.clearReconnectTimer();
    this.clearConnectChallengeTimeout();
    this.connectNonce = null;
    this.connectSent = false;
    const url = this.opts.url ?? DEFAULT_GATEWAY_CLIENT_URL;
    if (this.opts.tlsFingerprint && !url.startsWith("wss://")) {
      this.notifyConnectError(new Error("gateway tls fingerprint requires wss:// gateway url"));
      return;
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
      const error = new Error(
        `SECURITY ERROR: Cannot connect to "${displayHost}" over plaintext ws://. ` +
          "Both credentials and chat data would be exposed to network interception. " +
          "Use wss:// for remote URLs. Safe defaults: keep gateway.bind=loopback and connect via SSH tunnel " +
          "(ssh -N -L 18789:127.0.0.1:18789 user@gateway-host), or use Tailscale Serve/Funnel. " +
          (allowPrivateWs
            ? ""
            : "Break-glass (trusted private networks only): set OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1. ") +
          "Run `openclaw doctor --fix` for guidance.",
      );
      this.notifyConnectError(error);
      return;
    }
    // Allow node screen snapshots and other large responses.
    this.deps.beforeConnect();
    const wsOptions: FingerprintCheckingClientOptions = {
      maxPayload: 25 * 1024 * 1024,
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
    const unregisterGatewayLoopbackBypass = this.deps.registerGatewayLoopbackBypass(url);
    try {
      ws = new WebSocket(url, wsOptions as ClientOptions);
    } catch (error) {
      this.notifyConnectError(error instanceof Error ? error : new Error(String(error)));
      return;
    } finally {
      unregisterGatewayLoopbackBypass?.();
    }
    this.ws = ws;
    this.socketOpened = false;
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectChallengeTimeout();

    ws.on("open", () => {
      this.socketOpened = true;
      if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
        const tlsError = this.validateTlsFingerprint();
        if (tlsError) {
          this.notifyConnectError(tlsError);
          this.ws?.close(1008, tlsError.message);
          return;
        }
      }
      this.beginPreauthHandshake();
    });
    ws.on("message", (data) => this.handleMessage(rawDataToString(data)));
    ws.on("close", (code, reason) => {
      const reasonText = rawDataToString(reason);
      const connectErrorDetailCode = this.pendingConnectErrorDetailCode;
      const connectErrorDetails = this.pendingConnectErrorDetails;
      this.pendingConnectErrorDetailCode = null;
      this.pendingConnectErrorDetails = null;
      if (this.ws === ws) {
        this.ws = null;
      }
      this.socketOpened = false;
      this.resolvePendingStop(ws);
      if (this.pendingStartupReconnectDelayMs !== null) {
        this.scheduleReconnect();
        return;
      }
      // Clear persisted device auth state only when device-token auth was active.
      // Shared token/password failures can return the same close reason but should
      // not erase a valid cached device token.
      if (
        code === 1008 &&
        normalizeLowercaseStringOrEmpty(reasonText).includes("device token mismatch") &&
        !this.opts.token &&
        !this.opts.password &&
        this.opts.deviceIdentity
      ) {
        const deviceId = this.opts.deviceIdentity.deviceId;
        const role = this.opts.role ?? "operator";
        try {
          this.deps.clearDeviceAuthToken({ deviceId, role, env: this.opts.env });
          this.logDebug(`cleared stale device-auth token for device ${deviceId}`);
        } catch (err) {
          this.logDebug(
            `failed clearing stale device-auth token for device ${deviceId}: ${String(err)}`,
          );
        }
      }
      this.flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));
      if (
        this.shouldPauseReconnectAfterAuthFailure({
          detailCode: connectErrorDetailCode,
          details: connectErrorDetails,
        })
      ) {
        this.opts.onReconnectPaused?.({
          code,
          reason: reasonText,
          detailCode: connectErrorDetailCode,
        });
        this.opts.onClose?.(code, reasonText);
        return;
      }
      this.scheduleReconnect();
      this.opts.onClose?.(code, reasonText);
    });
    ws.on("error", (err) => {
      this.logDebug(`gateway client error: ${formatGatewayClientErrorForLog(err)}`);
      if (!this.connectSent) {
        this.notifyConnectError(err instanceof Error ? err : new Error(String(err)));
      }
    });
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
    this.closed = true;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.pendingStartupReconnectDelayMs = null;
    this.pendingConnectErrorDetailCode = null;
    this.pendingConnectErrorDetails = null;
    this.clearReconnectTimer();
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.clearConnectChallengeTimeout();
    if (this.pendingStop) {
      this.flushPendingErrors(new Error("gateway client stopped"));
      return this.pendingStop.promise;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      const stopPromise = this.createPendingStop(ws);
      ws.close();
      const forceTerminateTimer = setTimeout(() => {
        try {
          ws.terminate();
        } catch {}
        this.resolvePendingStop(ws);
      }, FORCE_STOP_TERMINATE_GRACE_MS);
      forceTerminateTimer.unref?.();
      this.flushPendingErrors(new Error("gateway client stopped"));
      return stopPromise;
    }
    this.flushPendingErrors(new Error("gateway client stopped"));
    return null;
  }

  private createPendingStop(ws: WebSocket): Promise<void> {
    if (this.pendingStop?.ws === ws) {
      return this.pendingStop.promise;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.pendingStop = { ws, promise, resolve };
    return promise;
  }

  private resolvePendingStop(ws: WebSocket): void {
    if (this.pendingStop?.ws !== ws) {
      return;
    }
    const { resolve } = this.pendingStop;
    this.pendingStop = null;
    resolve();
  }

  private logDebug(message: string): void {
    this.deps.logDebug(this.deps.redactForLog(message));
  }

  private logError(message: string): void {
    this.deps.logError(this.deps.redactForLog(message));
  }

  private sendConnect() {
    if (this.connectSent) {
      return;
    }
    const nonce = normalizeOptionalString(this.connectNonce) ?? "";
    if (!nonce) {
      this.notifyConnectError(new Error("gateway connect challenge missing nonce"));
      this.ws?.close(1008, "connect challenge missing nonce");
      return;
    }
    const role = this.opts.role ?? "operator";
    let assembled: AssembledConnect;
    try {
      // Build the full connect frame before marking connectSent so synchronous
      // signing/storage failures surface as connect-assembly errors, not RPCs.
      assembled = this.assembleConnectParams({ role, nonce });
    } catch (err) {
      this.handleConnectFailure(err);
      return;
    }

    this.connectSent = true;
    this.clearConnectChallengeTimeout();

    void this.request<HelloOk>("connect", assembled.params)
      .then((helloOk) => {
        this.pendingDeviceTokenRetry = false;
        this.deviceTokenRetryBudgetUsed = false;
        this.pendingStartupReconnectDelayMs = null;
        this.pendingConnectErrorDetailCode = null;
        this.pendingConnectErrorDetails = null;
        const authInfo = helloOk?.auth;
        if (authInfo?.deviceToken && this.opts.deviceIdentity) {
          this.deps.storeDeviceAuthToken({
            deviceId: this.opts.deviceIdentity.deviceId,
            role: authInfo.role ?? role,
            token: authInfo.deviceToken,
            scopes: authInfo.scopes ?? [],
            env: this.opts.env,
          });
        }
        this.backoffMs = 1000;
        this.tickIntervalMs =
          typeof helloOk.policy?.tickIntervalMs === "number"
            ? helloOk.policy.tickIntervalMs
            : 30_000;
        this.lastTick = Date.now();
        this.startTickWatch();
        this.opts.onHelloOk?.(helloOk);
      })
      .catch((err: unknown) => {
        this.pendingConnectErrorDetailCode =
          err instanceof GatewayClientRequestError ? readConnectErrorDetailCode(err.details) : null;
        this.pendingConnectErrorDetails =
          err instanceof GatewayClientRequestError ? err.details : null;
        const shouldRetryWithDeviceToken = this.shouldRetryWithStoredDeviceToken({
          error: err,
          explicitGatewayToken: normalizeOptionalString(this.opts.token),
          resolvedDeviceToken: assembled.resolvedDeviceToken,
          storedToken: assembled.storedToken,
        });
        if (
          this.opts.deviceIdentity &&
          assembled.usingStoredDeviceToken &&
          err instanceof GatewayClientRequestError &&
          readConnectErrorDetailCode(err.details) ===
            ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
        ) {
          const deviceId = this.opts.deviceIdentity.deviceId;
          try {
            this.deps.clearDeviceAuthToken({ deviceId, role, env: this.opts.env });
            this.logDebug(`cleared stale device-auth token for device ${deviceId}`);
          } catch (clearErr) {
            this.logDebug(
              `failed clearing stale device-auth token for device ${deviceId}: ${String(clearErr)}`,
            );
          }
        }
        if (shouldRetryWithDeviceToken) {
          this.pendingDeviceTokenRetry = true;
          this.deviceTokenRetryBudgetUsed = true;
          this.backoffMs = Math.min(this.backoffMs, 250);
        }
        const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err);
        if (startupRetryAfterMs !== null) {
          this.pendingStartupReconnectDelayMs = startupRetryAfterMs;
          this.logDebug(`gateway connect failed: ${formatGatewayClientErrorForLog(err)}`);
          this.ws?.close(1013, "gateway starting");
          return;
        }
        if (
          this.shouldRetryWithoutApprovalRuntimeToken({
            error: err,
            authApprovalRuntimeToken: assembled.authApprovalRuntimeToken,
          })
        ) {
          this.approvalRuntimeTokenCompatibilityDisabled = true;
          this.approvalRuntimeTokenRetryBudgetUsed = true;
          this.backoffMs = Math.min(this.backoffMs, 250);
          this.logDebug("gateway rejected approval runtime auth field; retrying without it");
          this.ws?.close(1008, "connect retry");
          return;
        }
        this.notifyConnectError(err instanceof Error ? err : new Error(String(err)));
        const msg = `gateway connect failed: ${formatGatewayClientErrorForLog(err)}`;
        if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(err)) {
          this.logDebug(msg);
        } else {
          this.logError(msg);
        }
        this.ws?.close(1008, "connect failed");
      });
  }

  private assembleConnectParams(params: { role: string; nonce: string }): AssembledConnect {
    const { role, nonce } = params;
    // Auth selection is intentionally centralized: retry decisions depend on
    // whether a token was explicit, cached, or compatibility-derived.
    const selectedAuth = this.selectConnectAuth(role);
    const {
      authToken,
      authBootstrapToken,
      authDeviceToken,
      authPassword,
      authApprovalRuntimeToken,
      signatureToken,
      resolvedDeviceToken,
      storedToken,
      storedScopes,
      usingStoredDeviceToken,
    } = selectedAuth;

    if (this.pendingDeviceTokenRetry && authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }

    const auth =
      authToken ||
      authBootstrapToken ||
      authPassword ||
      resolvedDeviceToken ||
      authApprovalRuntimeToken
        ? {
            token: authToken,
            bootstrapToken: authBootstrapToken,
            deviceToken: authDeviceToken ?? resolvedDeviceToken,
            password: authPassword,
            approvalRuntimeToken: authApprovalRuntimeToken,
          }
        : undefined;
    const signedAtMs = Date.now();
    const scopes = this.resolveConnectScopes({
      usingStoredDeviceToken,
      storedScopes,
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

  private handleConnectFailure(err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    this.clearConnectChallengeTimeout();
    this.closed = true;
    this.notifyConnectError(markGatewayConnectAssemblyError(error));
    const msg = `gateway connect failed: ${formatGatewayClientErrorForLog(error)}`;
    if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(error)) {
      this.logDebug(msg);
    } else {
      this.logError(msg);
    }
    this.ws?.close(1008, "connect failed");
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

  private resolveConnectScopes(params: {
    usingStoredDeviceToken?: boolean;
    storedScopes?: string[];
  }): string[] {
    // Reuse cached scopes only when the client is reusing the cached device token.
    // Callers that ask for explicit scopes should keep that request so the
    // server can authorize it or drive the normal scope-upgrade flow.
    if (Array.isArray(this.opts.scopes)) {
      return this.opts.scopes;
    }
    if (
      params.usingStoredDeviceToken &&
      Array.isArray(params.storedScopes) &&
      params.storedScopes.length > 0
    ) {
      return params.storedScopes;
    }
    return this.opts.scopes ?? ["operator.admin"];
  }

  private loadStoredDeviceAuth(role: string): StoredDeviceAuth | null {
    if (!this.opts.deviceIdentity) {
      return null;
    }
    const storedAuth = this.deps.loadDeviceAuthToken({
      deviceId: this.opts.deviceIdentity.deviceId,
      role,
      env: this.opts.env,
    });
    if (!storedAuth) {
      return null;
    }
    return {
      token: storedAuth.token,
      scopes: storedAuth.scopes,
    };
  }

  private shouldPauseReconnectAfterAuthFailure(params: {
    detailCode: string | null;
    details?: unknown;
  }): boolean {
    const { detailCode, details } = params;
    if (!detailCode) {
      return false;
    }
    const pairingDetails = readPairingConnectErrorDetails(details);
    if (
      detailCode === ConnectErrorDetailCodes.PAIRING_REQUIRED &&
      (pairingDetails?.pauseReconnect === false ||
        pairingDetails?.recommendedNextStep === "wait_then_retry")
    ) {
      return false;
    }
    if (
      detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
      detailCode === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
      detailCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
      detailCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
      detailCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
      detailCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
      detailCode === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH ||
      detailCode === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
      detailCode === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
      detailCode === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED ||
      detailCode === ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH
    ) {
      return true;
    }
    if (detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) {
      return !this.pendingDeviceTokenRetry;
    }
    return false;
  }

  private shouldRetryWithStoredDeviceToken(params: {
    error: unknown;
    explicitGatewayToken?: string;
    storedToken?: string;
    resolvedDeviceToken?: string;
  }): boolean {
    if (this.deviceTokenRetryBudgetUsed) {
      return false;
    }
    if (params.resolvedDeviceToken) {
      return false;
    }
    if (!params.explicitGatewayToken || !params.storedToken) {
      return false;
    }
    if (!this.isTrustedDeviceRetryEndpoint()) {
      return false;
    }
    if (!(params.error instanceof GatewayClientRequestError)) {
      return false;
    }
    const detailCode = readConnectErrorDetailCode(params.error.details);
    const advice: ConnectErrorRecoveryAdvice = readConnectErrorRecoveryAdvice(params.error.details);
    const retryWithDeviceTokenRecommended =
      advice.recommendedNextStep === "retry_with_device_token";
    return (
      advice.canRetryWithDeviceToken === true ||
      retryWithDeviceTokenRecommended ||
      detailCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
    );
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

  private selectConnectAuth(role: string): SelectedConnectAuth {
    const explicitGatewayToken = normalizeOptionalString(this.opts.token);
    const explicitBootstrapToken = normalizeOptionalString(this.opts.bootstrapToken);
    const explicitDeviceToken = normalizeOptionalString(this.opts.deviceToken);
    const authPassword = normalizeOptionalString(this.opts.password);
    const authApprovalRuntimeToken = this.approvalRuntimeTokenCompatibilityDisabled
      ? undefined
      : normalizeOptionalString(this.opts.approvalRuntimeToken);
    const storedAuth = this.loadStoredDeviceAuth(role);
    const storedToken = storedAuth?.token ?? null;
    const storedScopes = storedAuth?.scopes;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      !explicitDeviceToken &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      this.isTrustedDeviceRetryEndpoint();
    const resolvedDeviceToken =
      explicitDeviceToken ??
      (shouldUseDeviceRetryToken ||
      (!(explicitGatewayToken || authPassword) && (!explicitBootstrapToken || Boolean(storedToken)))
        ? (storedToken ?? undefined)
        : undefined);
    const reusingStoredDeviceToken =
      Boolean(resolvedDeviceToken) &&
      !explicitDeviceToken &&
      Boolean(storedToken) &&
      resolvedDeviceToken === storedToken;
    // Legacy compatibility: keep `auth.token` populated for device-token auth when
    // no explicit shared token is present.
    const authToken = explicitGatewayToken ?? resolvedDeviceToken;
    const authBootstrapToken =
      !explicitGatewayToken && !resolvedDeviceToken && !authPassword
        ? explicitBootstrapToken
        : undefined;
    return {
      authToken,
      authBootstrapToken,
      authDeviceToken: shouldUseDeviceRetryToken ? (storedToken ?? undefined) : undefined,
      authPassword,
      authApprovalRuntimeToken,
      signatureToken: authToken ?? authBootstrapToken ?? undefined,
      resolvedDeviceToken,
      storedToken: storedToken ?? undefined,
      storedScopes,
      usingStoredDeviceToken: reusingStoredDeviceToken,
    };
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logDebug(`gateway client parse error: ${formatGatewayClientErrorForLog(err)}`);
      return;
    }
    if (isGatewayEventFrame(parsed)) {
      this.lastTick = Date.now();
      const evt = parsed;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (!nonce || nonce.trim().length === 0) {
          this.notifyConnectError(new Error("gateway connect challenge missing nonce"));
          this.ws?.close(1008, "connect challenge missing nonce");
          return;
        }
        this.connectNonce = nonce.trim();
        if (this.socketOpened) {
          this.sendConnect();
        }
        return;
      }
      try {
        const seq = typeof evt.seq === "number" ? evt.seq : null;
        if (seq !== null) {
          if (this.lastSeq !== null && seq > this.lastSeq + 1) {
            this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
          }
          this.lastSeq = seq;
        }
        if (evt.event === "tick") {
          this.lastTick = Date.now();
        }
        this.opts.onEvent?.(evt);
      } catch (err) {
        this.logDebug(`gateway client event handler error: ${formatGatewayClientErrorForLog(err)}`);
      }
      return;
    }
    if (isGatewayResponseFrame(parsed)) {
      this.lastTick = Date.now();
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      // If the payload is an ack with status accepted, keep waiting for final.
      const payload = parsed.payload as { status?: unknown } | undefined;
      const status = payload?.status;
      if (pending.expectFinal && status === "accepted") {
        if (!pending.acceptedNotified) {
          pending.acceptedNotified = true;
          try {
            pending.onAccepted?.(parsed.payload);
          } catch (err) {
            this.logDebug(
              `gateway client accepted callback error: ${formatGatewayClientErrorForLog(err)}`,
            );
          }
        }
        return;
      }
      this.pending.delete(parsed.id);
      pending.cleanup?.();
      if (parsed.ok) {
        pending.resolve(parsed.payload);
      } else {
        pending.reject(
          new GatewayClientRequestError({
            code: parsed.error?.code,
            message: parsed.error?.message ?? "unknown error",
            details: parsed.error?.details,
            retryable: parsed.error?.retryable,
            retryAfterMs: parsed.error?.retryAfterMs,
          }),
        );
      }
    }
  }

  private beginPreauthHandshake() {
    if (this.connectSent) {
      return;
    }
    if (this.connectNonce && !this.connectSent) {
      this.armConnectChallengeTimeout();
      this.sendConnect();
      return;
    }
    this.armConnectChallengeTimeout();
  }

  private clearConnectChallengeTimeout() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armConnectChallengeTimeout() {
    const connectChallengeTimeoutMs = resolveGatewayClientConnectChallengeTimeoutMs(this.opts);
    const armedAt = Date.now();
    this.clearConnectChallengeTimeout();
    this.connectTimer = setTimeout(() => {
      if (this.connectSent || this.ws?.readyState !== WebSocket.OPEN) {
        return;
      }
      const elapsedMs = Date.now() - armedAt;
      this.notifyConnectError(
        new Error(
          `gateway connect challenge timeout (waited ${elapsedMs}ms, limit ${connectChallengeTimeoutMs}ms)`,
        ),
      );
      this.ws?.close(1008, "connect challenge timeout");
    }, connectChallengeTimeoutMs);
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.clearReconnectTimer();
    const startupDelay = this.pendingStartupReconnectDelayMs;
    this.pendingStartupReconnectDelayMs = null;
    const delay = startupDelay ?? this.backoffMs;
    if (startupDelay === null) {
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delay);
  }

  private flushPendingErrors(err: Error) {
    for (const [, p] of this.pending) {
      p.cleanup?.();
      p.reject(err);
    }
    this.pending.clear();
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
      if (this.closed) {
        return;
      }
      if (!this.lastTick) {
        return;
      }
      if (this.pending.size > 0) {
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
        this.ws?.close(4000, "tick timeout");
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    if (opts?.signal?.aborted) {
      throw createGatewayRequestAbortError(method);
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    const requestFrameError = validateClientRequestFrame(frame);
    if (requestFrameError) {
      throw new Error(`invalid request frame: ${requestFrameError}`);
    }
    const expectFinal = opts?.expectFinal === true;
    const timeoutMs =
      opts?.timeoutMs === null
        ? null
        : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
          ? resolveSafeTimeoutDelayMs(opts.timeoutMs, { minMs: 0 })
          : expectFinal
            ? null
            : this.requestTimeoutMs;
    const signal = opts?.signal;
    const p = new Promise<T>((resolve, reject) => {
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              const pending = this.pending.get(id);
              this.pending.delete(id);
              pending?.cleanup?.();
              reject(new Error(`gateway request timeout for ${method}`));
            }, timeoutMs);
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
      };
      const abortHandler: (() => void) | undefined = () => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.cleanup?.();
        reject(createGatewayRequestAbortError(method));
      };
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal,
        timeout,
        cleanup,
        onAccepted: opts?.onAccepted,
      });
      signal?.addEventListener("abort", abortHandler, { once: true });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }
}

function createGatewayRequestAbortError(method: string): Error {
  const err = new Error(`gateway request aborted for ${method}`);
  err.name = "AbortError";
  return err;
}

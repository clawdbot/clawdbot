import { randomUUID } from "node:crypto";
import { WebSocket, type ClientOptions, type CertMeta } from "ws";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../infra/device-auth-store.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import {
  ensureInheritedManagedProxyRoutingActive,
  withManagedProxyGatewayLoopbackRouting,
} from "../infra/net/proxy/proxy-lifecycle.js";
import { normalizeFingerprint } from "../infra/tls/fingerprint.js";
import { rawDataToString } from "../infra/ws.js";
import { logDebug, logError } from "../logger.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../utils/message-channel.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { VERSION } from "../version.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { resolveConnectChallengeTimeoutMs } from "./handshake-timeouts.js";
import { isLoopbackHost, isSecureWebSocketUrl } from "./net.js";
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorDetailCode,
  readConnectErrorRecoveryAdvice,
  type ConnectErrorRecoveryAdvice,
} from "./protocol/connect-error-details.js";
import {
  type ConnectParams,
  type EventFrame,
  type HelloOk,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type RequestFrame,
  validateEventFrame,
  validateRequestFrame,
  validateResponseFrame,
} from "./protocol/index.js";
import { resolveGatewayStartupRetryAfterMs } from "./protocol/startup-unavailable.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  expectFinal: boolean;
  timeout: NodeJS.Timeout | null;
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

type FingerprintCheckingClientOptions = Omit<ClientOptions, "checkServerIdentity"> & {
  checkServerIdentity?: (servername: string, cert: CertMeta) => Error | undefined;
};

const DEFAULT_GATEWAY_CLIENT_URL = "ws://127.0.0.1:18789";

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
  requestTimeoutMs?: number;
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
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
  private pendingStartupReconnectDelayMs: number | null = null;
  private pendingConnectErrorDetailCode: string | null = null;
  // Track last tick to detect silent stalls.
  private lastTick: number | null = null;
  private tickIntervalMs = 30_000;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly requestTimeoutMs: number;
  private pendingStop: PendingStop | null = null;
  private socketOpened = false;

  constructor(opts: GatewayClientOptions) {
    this.opts = {
      ...opts,
      deviceIdentity:
        opts.deviceIdentity === null
          ? undefined
          : (opts.deviceIdentity ?? loadOrCreateDeviceIdentity()),
    };
    this.requestTimeoutMs =
      typeof opts.requestTimeoutMs === "number" && Number.isFinite(opts.requestTimeoutMs)
        ? resolveSafeTimeoutDelayMs(opts.requestTimeoutMs)
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
      this.opts.onConnectError?.(new Error("gateway tls fingerprint requires wss:// gateway url"));
      return;
    }

    const allowPrivateWs = process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1";
    // Security check: block ALL plaintext ws:// to non-loopback addresses (CWE-319, CVSS 9.8)
    // This protects both credentials AND chat/conversation data from MITM attacks.
    // Device tokens may be loaded later in sendConnect(), so we block regardless of hasCredentials.
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
      this.opts.onConnectError?.(error);
      return;
    }
    // Allow node screen snapshots and other large responses.
    ensureInheritedManagedProxyRoutingActive();
    const wsOptions: FingerprintCheckingClientOptions = {
      maxPayload: 25 * 1024 * 1024,
    };
    if (url.startsWith("wss://") && this.opts.tlsFingerprint) {
      wsOptions.rejectUnauthorized = false;
      wsOptions.checkServerIdentity = (_host: string, cert: CertMeta) => {
        const fingerprintValue =
          typeof cert === "object" && cert && "fingerprint256" in cert
            ? ((cert as { fingerprint256?: string }).fingerprint256 ?? "")
            : "";
        const fingerprint = normalizeFingerprint(
          typeof fingerprintValue === "string" ? fingerprintValue : "",
        );
        const expected = normalizeFingerprint(this.opts.tlsFingerprint ?? "");
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
    const ws = withManagedProxyGatewayLoopbackRouting(
      url,
      () => new WebSocket(url, wsOptions as ClientOptions),
    );
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
          this.opts.onConnectError?.(tlsError);
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
      this.pendingConnectErrorDetailCode = null;
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
          clearDeviceAuthToken({ deviceId, role, env: this.opts.env });
          logDebug(`cleared stale device-auth token for device ${deviceId}`);
        } catch (err) {
          logDebug(
            `failed clearing stale device-auth token for device ${deviceId}: ${String(err)}`,
          );
        }
      }
      this.flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));
      if (this.shouldPauseReconnectAfterAuthFailure(connectErrorDetailCode)) {
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
      logDebug(`gateway client error: ${String(err)}`);
      if (!this.connectSent) {
        this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
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
      typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
        ? Math.max(1, Math.floor(opts.timeoutMs))
        : STOP_AND_WAIT_TIMEOUT_MS;
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

  private sendConnect() {
    if (this.connectSent) {
      return;
    }
    const nonce = normalizeOptionalString(this.connectNonce) ?? "";
    if (!nonce) {
      this.opts.onConnectError?.(new Error("gateway connect challenge missing nonce"));
      this.ws?.close(1008, "connect challenge missing nonce");
      return;
    }
    this.connectSent = true;
    this.clearConnectChallengeTimeout();
    const role = this.opts.role ?? "operator";
    const {
      authToken,
      authBootstrapToken,
      authDeviceToken,
      authPassword,
      signatureToken,
      resolvedDeviceToken,
      storedToken,
      storedScopes,
      usingStoredDeviceToken,
    } = this.selectConnectAuth(role);
    if (this.pendingDeviceTokenRetry && authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    const auth =
      authToken || authBootstrapToken || authPassword || resolvedDeviceToken
        ? {
            token: authToken,
            bootstrapToken: authBootstrapToken,
            deviceToken: authDeviceToken ?? resolvedDeviceToken,
            password: authPassword,
          }
        : undefined;
    const signedAtMs = Date.now();
    const scopes = this.resolveConnectScopes({
      usingStoredDeviceToken,
      storedScopes,
    });
    const platform = this.opts.platform ?? process.platform;
    const device = (() => {
      if (!this.opts.deviceIdentity) {
        return undefined;
      }
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
      const signature = signDevicePayload(this.opts.deviceIdentity.privateKeyPem, payload);
      return {
        id: this.opts.deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(this.opts.deviceIdentity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    })();
    const params: ConnectParams = {
      minProtocol: this.opts.minProtocol ?? MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: this.opts.maxProtocol ?? PROTOCOL_VERSION,
      client: {
        id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        displayName: this.opts.clientDisplayName,
        version: this.opts.clientVersion ?? VERSION,
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
      device,
    };

    void this.request<HelloOk>("connect", params)
      .then((helloOk) => {
        this.pendingDeviceTokenRetry = false;
        this.deviceTokenRetryBudgetUsed = false;
        this.pendingStartupReconnectDelayMs = null;
        this.pendingConnectErrorDetailCode = null;
        const authInfo = helloOk?.auth;
        if (authInfo?.deviceToken && this.opts.deviceIdentity) {
          storeDeviceAuthToken({
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
      .catch((err) => {
        this.pendingConnectErrorDetailCode =
          err instanceof GatewayClientRequestError ? readConnectErrorDetailCode(err.details) : null;
        const shouldRetryWithDeviceToken = this.shouldRetryWithStoredDeviceToken({
          error: err,
          explicitGatewayToken: normalizeOptionalString(this.opts.token),
          resolvedDeviceToken,
          storedToken: storedToken ?? undefined,
        });
        if (
          this.opts.deviceIdentity &&
          usingStoredDeviceToken &&
          err instanceof GatewayClientRequestError &&
          readConnectErrorDetailCode(err.details) ===
            ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
        ) {
          const deviceId = this.opts.deviceIdentity.deviceId;
          try {
            clearDeviceAuthToken({ deviceId, role });
            logDebug(`cleared stale device-auth token for device ${deviceId}`);
          } catch (clearErr) {
            logDebug(
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
          logDebug(`gateway connect failed: ${String(err)}`);
          this.ws?.close(1013, "gateway starting");
          return;
        }
        this.opts.onConnectError?.(err instanceof Error ? err : new Error(String(err)));
        const msg = `gateway connect failed: ${String(err)}`;
        if (this.opts.mode === GATEWAY_CLIENT_MODES.PROBE || isGatewayClientStoppedError(err)) {
          logDebug(msg);
        } else {
          logError(msg);
        }
        this.ws?.close(1008, "connect failed");
      });
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
    const storedAuth = loadDeviceAuthToken({
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

  private shouldPauseReconnectAfterAuthFailure(detailCode: string | null): boolean {
    if (!detailCode) {
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
      detailCode === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
    ) {
      return true;
    }
    if (detailCode !== ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) {
      return false;
    }
    if (this.pendingDeviceTokenRetry) {
      return false;
    }
    // If the endpoint is not trusted for retry, mismatch is terminal until operator action.
    if (!this.isTrustedDeviceRetryEndpoint()) {
      return true;
    }
    // Pause mismatch reconnect loops once the one-shot device-token retry is consumed.
    return this.deviceTokenRetryBudgetUsed;
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
      signatureToken: authToken ?? authBootstrapToken ?? undefined,
      resolvedDeviceToken,
      storedToken: storedToken ?? undefined,
      storedScopes,
      usingStoredDeviceToken: reusingStoredDeviceToken,
    };
  }

  private handleMessage(raw: string) {
    try {
      const parsed = JSON.parse(raw);
      if (validateEventFrame(parsed)) {
        this.lastTick = Date.now();
        const evt = parsed;
        if (evt.event === "connect.challenge") {
          const payload = evt.payload as { nonce?: unknown } | undefined;
          const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
          if (!nonce || nonce.trim().length === 0) {
            this.opts.onConnectError?.(new Error("gateway connect challenge missing nonce"));
            this.ws?.close(1008, "connect challenge missing nonce");
            return;
          }
          this.connectNonce = nonce.trim();
          if (this.socketOpened) {
            this.sendConnect();
          }
          return;
        }
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
        return;
      }
      if (validateResponseFrame(parsed)) {
        this.lastTick = Date.now();
        const pending = this.pending.get(parsed.id);
        if (!pending) {
          return;
        }
        // If the payload is an ack with status accepted, keep waiting for final.
        const payload = parsed.payload as { status?: unknown } | undefined;
        const status = payload?.status;
        if (pending.expectFinal && status === "accepted") {
          return;
        }
        this.pending.delete(parsed.id);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
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
    } catch (err) {
      logDebug(`gateway client parse error: ${String(err)}`);
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
      this.opts.onConnectError?.(
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
      if (p.timeout) {
        clearTimeout(p.timeout);
      }
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
    const interval = Math.max(this.tickIntervalMs, minInterval);
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
      if (gap > this.tickIntervalMs * 2) {
        this.ws?.close(4000, "tick timeout");
      }
    }, interval);
  }

  private validateTlsFingerprint(): Error | null {
    if (!this.opts.tlsFingerprint || !this.ws) {
      return null;
    }
    const expected = normalizeFingerprint(this.opts.tlsFingerprint);
    if (!expected) {
      return new Error("gateway tls fingerprint missing");
    }
    const socket = (
      this.ws as WebSocket & {
        _socket?: { getPeerCertificate?: () => { fingerprint256?: string } };
      }
    )._socket;
    if (!socket || typeof socket.getPeerCertificate !== "function") {
      return new Error("gateway tls fingerprint unavailable");
    }
    const cert = socket.getPeerCertificate();
    const fingerprint = normalizeFingerprint(cert?.fingerprint256 ?? "");
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
    opts?: { expectFinal?: boolean; timeoutMs?: number | null },
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    if (!validateRequestFrame(frame)) {
      throw new Error(
        `invalid request frame: ${JSON.stringify(validateRequestFrame.errors, null, 2)}`,
      );
    }
    const expectFinal = opts?.expectFinal === true;
    const timeoutMs =
      opts?.timeoutMs === null
        ? null
        : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
          ? resolveSafeTimeoutDelayMs(opts.timeoutMs)
          : expectFinal
            ? null
            : this.requestTimeoutMs;
    const p = new Promise<T>((resolve, reject) => {
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`gateway request timeout for ${method}`));
            }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal,
        timeout,
      });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }
}

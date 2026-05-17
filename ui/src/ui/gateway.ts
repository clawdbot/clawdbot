import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../src/gateway/protocol/client-info.js";
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorRecoveryAdvice,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "../../../src/gateway/protocol/connect-error-details.js";
import {
  isRetryableGatewayStartupUnavailableError,
  resolveGatewayStartupRetryAfterMs,
} from "../../../src/gateway/protocol/startup-unavailable.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../src/gateway/protocol/version.js";
import { clearDeviceAuthToken, loadDeviceAuthToken, storeDeviceAuthToken } from "./device-auth.ts";
import { loadOrCreateDeviceIdentity, signDevicePayload } from "./device-identity.ts";
import { generateUUID } from "./uuid.ts";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean;
    retryAfterMs?: number;
  };
};

export type GatewayErrorInfo = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export class GatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(error: GatewayErrorInfo) {
    super(
      formatConnectErrorMessage({
        message: error.message,
        details: enrichProtocolMismatchDetails(error.message, error.details),
      }),
    );
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = error.details;
    this.retryable = error.retryable === true;
    this.retryAfterMs = error.retryAfterMs;
  }
}

function enrichProtocolMismatchDetails(message: string | undefined, details: unknown): unknown {
  if (readConnectErrorDetailCode(details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) {
    return details;
  }
  if (!message?.toLowerCase().includes("protocol mismatch")) {
    return details;
  }
  return {
    code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    clientMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    clientMaxProtocol: PROTOCOL_VERSION,
    ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
  };
}

export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}

function shouldContinueReconnectForPairingRequired(details: unknown): boolean {
  const pairingDetails = readPairingConnectErrorDetails(details);
  return (
    pairingDetails?.pauseReconnect === false ||
    pairingDetails?.recommendedNextStep === "wait_then_retry"
  );
}

/**
 * Auth errors that won't resolve without user action — don't auto-reconnect.
 *
 * NOTE: AUTH_TOKEN_MISMATCH is intentionally NOT included here because the
 * browser client supports a bounded one-time retry with a cached device token
 * when the endpoint is trusted. Reconnect suppression for mismatch is handled
 * with client state (after retry budget is exhausted).
 */
export function isNonRecoverableAuthError(error: GatewayErrorInfo | undefined): boolean {
  if (!error) {
    return false;
  }
  const code = resolveGatewayErrorDetailCode(error);
  if (
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED &&
    shouldContinueReconnectForPairingRequired(error.details)
  ) {
    return false;
  }
  return (
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING ||
    code === ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    code === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH ||
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED
  );
}

function isLoopbackIPv4Host(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) {
      return false;
    }
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function isTrustedRetryEndpoint(url: string): boolean {
  try {
    const gatewayUrl = new URL(url, window.location.href);
    const host = gatewayUrl.hostname.trim().toLowerCase();
    const isLoopbackHost = host === "localhost" || host === "::1" || host === "[::1]";
    const isLoopbackIPv4 = isLoopbackIPv4Host(host);
    if (isLoopbackHost || isLoopbackIPv4) {
      return true;
    }
    const pageUrl = new URL(window.location.href);
    return gatewayUrl.host === pageUrl.host;
  } catch {
    return false;
  }
}

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server?: {
    version?: string;
    connId?: string;
  };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  auth: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
  };
  pluginSurfaceUrls?: Record<string, string>;
  policy?: { tickIntervalMs?: number };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  method: string;
  startedAtMs: number;
};

type SelectedConnectAuth = {
  authToken?: string;
  authDeviceToken?: string;
  authPassword?: string;
  resolvedDeviceToken?: string;
  storedToken?: string;
  storedScopes?: string[];
  canFallbackToShared: boolean;
};

const CONTROL_UI_OPERATOR_ROLE = "operator";

export const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

export type GatewayConnectAuth = {
  token?: string;
  deviceToken?: string;
  password?: string;
};

export type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

export type GatewayConnectClientInfo = {
  id: GatewayClientName;
  version: string;
  platform: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

export type GatewayConnectParams = {
  minProtocol: typeof MIN_CLIENT_PROTOCOL_VERSION;
  maxProtocol: typeof PROTOCOL_VERSION;
  client: GatewayConnectClientInfo;
  role: string;
  scopes: string[];
  device?: GatewayConnectDevice;
  caps: string[];
  auth?: GatewayConnectAuth;
  userAgent: string;
  locale: string;
};

type ConnectPlan = {
  role: string;
  scopes: string[];
  client: GatewayConnectClientInfo;
  explicitGatewayToken?: string;
  selectedAuth: SelectedConnectAuth;
  auth?: GatewayConnectAuth;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  device?: GatewayConnectDevice;
};

type DeviceTokenRetryDecision = {
  deviceTokenRetryBudgetUsed: boolean;
  authDeviceToken?: string;
  explicitGatewayToken?: string;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  storedToken?: string;
  canRetryWithDeviceTokenHint: boolean;
  url: string;
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: { code: number; reason: string; error?: GatewayErrorInfo }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onRequestTiming?: (timing: GatewayRequestTiming) => void;
};

export type GatewayEventListener = (evt: GatewayEventFrame) => void;

export type GatewayRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;
const BROWSER_WEBSOCKET_CLOSE_CODE = 1006;
const BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE = "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR";
const BROWSER_WEBSOCKET_SECURITY_ERROR_CODE = "BROWSER_WEBSOCKET_SECURITY_ERROR";

function buildGatewayConnectAuth(
  selectedAuth: SelectedConnectAuth,
): GatewayConnectAuth | undefined {
  const authToken = selectedAuth.authToken;
  if (!(authToken || selectedAuth.authPassword)) {
    return undefined;
  }
  return {
    token: authToken,
    deviceToken: selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken,
    password: selectedAuth.authPassword,
  };
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function getErrorName(err: unknown): string | undefined {
  if (err instanceof Error && err.name) {
    return err.name;
  }
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name : undefined;
  }
  return undefined;
}

function isBrowserWebSocketSecurityError(err: unknown): boolean {
  const name = getErrorName(err)?.toLowerCase();
  const message = getErrorMessage(err).toLowerCase();
  return (
    name === "securityerror" ||
    message.includes("security error") ||
    message.includes("mixed content") ||
    message.includes("insecure websocket")
  );
}

function formatBrowserWebSocketConstructorError(err: unknown, url: string): GatewayErrorInfo {
  const securityError = isBrowserWebSocketSecurityError(err);
  const browserMessage = getErrorMessage(err);
  const isPlaintextWs = url.trim().toLowerCase().startsWith("ws://");
  if (securityError) {
    return {
      code: BROWSER_WEBSOCKET_SECURITY_ERROR_CODE,
      message:
        "Browser refused the Gateway WebSocket for security reasons." +
        (isPlaintextWs
          ? " Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789."
          : " Check the Gateway WebSocket URL and browser security policy."),
      details: {
        code: BROWSER_WEBSOCKET_SECURITY_ERROR_CODE,
        browserErrorName: getErrorName(err),
        browserMessage,
      },
    };
  }
  return {
    code: BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE,
    message: `Could not create the Gateway WebSocket: ${browserMessage}`,
    details: {
      code: BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE,
      browserErrorName: getErrorName(err),
      browserMessage,
    },
  };
}

function resolveControlUiConnectScopes(selectedAuth: SelectedConnectAuth): string[] {
  const isUsingStoredDeviceToken =
    Boolean(selectedAuth.storedToken) &&
    (selectedAuth.resolvedDeviceToken === selectedAuth.storedToken ||
      selectedAuth.authDeviceToken === selectedAuth.storedToken);
  if (
    isUsingStoredDeviceToken &&
    selectedAuth.storedScopes &&
    selectedAuth.storedScopes.length > 0
  ) {
    return [...selectedAuth.storedScopes];
  }
  return [...CONTROL_UI_OPERATOR_SCOPES];
}

async function buildGatewayConnectDevice(params: {
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  client: GatewayConnectClientInfo;
  role: string;
  scopes: string[];
  authToken?: string;
  connectNonce: string | null;
}): Promise<GatewayConnectDevice | undefined> {
  const { deviceIdentity } = params;
  if (!deviceIdentity) {
    return undefined;
  }
  const signedAtMs = Date.now();
  const nonce = params.connectNonce ?? "";
  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: params.authToken ?? null,
    nonce,
  });
  const signature = await signDevicePayload(deviceIdentity.privateKey, payload);
  return {
    id: deviceIdentity.deviceId,
    publicKey: deviceIdentity.publicKey,
    signature,
    signedAt: signedAtMs,
    nonce,
  };
}

export function shouldRetryWithDeviceToken(params: DeviceTokenRetryDecision): boolean {
  return (
    !params.deviceTokenRetryBudgetUsed &&
    !params.authDeviceToken &&
    Boolean(params.explicitGatewayToken) &&
    Boolean(params.deviceIdentity) &&
    Boolean(params.storedToken) &&
    params.canRetryWithDeviceTokenHint &&
    isTrustedRetryEndpoint(params.url)
  );
}

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: number | null = null;
  private connectGeneration = 0;
  private backoffMs = 800;
  private pendingConnectError: GatewayErrorInfo | undefined;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private pendingStartupReconnectDelayMs: number | null = null;
  private eventListeners = new Set<GatewayEventListener>();

  constructor(private opts: GatewayBrowserClientOptions) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.clearConnectTimer();
    this.ws?.close();
    this.ws = null;
    this.pendingConnectError = undefined;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.pendingStartupReconnectDelayMs = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      const error = formatBrowserWebSocketConstructorError(err, this.opts.url);
      this.ws = null;
      this.pendingConnectError = undefined;
      this.pendingDeviceTokenRetry = false;
      this.pendingStartupReconnectDelayMs = null;
      this.flushPending(new Error(error.message));
      this.opts.onClose?.({
        code: BROWSER_WEBSOCKET_CLOSE_CODE,
        reason:
          error.code === BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
            ? "security error"
            : "websocket error",
        error,
      });
      return;
    }
    const generation = ++this.connectGeneration;
    this.ws = ws;
    ws.addEventListener("open", () => this.queueConnect(ws, generation));
    ws.addEventListener("message", (ev) => {
      if (!this.isActiveSocket(ws, generation)) {
        return;
      }
      this.handleMessage(ws, generation, String(ev.data ?? ""));
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) {
        return;
      }
      const reason = ev.reason ?? "";
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      if (this.pendingStartupReconnectDelayMs !== null) {
        this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
        this.scheduleReconnect();
        return;
      }
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
      if (connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) {
        if (this.pendingDeviceTokenRetry) {
          this.scheduleReconnect();
        }
        return;
      }
      if (!isNonRecoverableAuthError(connectError)) {
        this.scheduleReconnect();
      }
    });
    ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const startupDelay = this.pendingStartupReconnectDelayMs;
    this.pendingStartupReconnectDelayMs = null;
    const delay = startupDelay ?? this.backoffMs;
    if (startupDelay === null) {
      this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    }
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, delay);
  }

  private flushPending(err: Error) {
    for (const [id, p] of this.pending) {
      this.emitRequestTiming(id, p, false, "CLIENT_CLOSED");
      p.reject(err);
    }
    this.pending.clear();
  }

  private nowMs(): number {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  private emitRequestTiming(id: string, pending: Pending, ok: boolean, errorCode?: string): void {
    const endedAtMs = this.nowMs();
    try {
      this.opts.onRequestTiming?.({
        id,
        method: pending.method,
        ok,
        durationMs: Math.max(0, endedAtMs - pending.startedAtMs),
        startedAtMs: pending.startedAtMs,
        endedAtMs,
        errorCode,
      });
    } catch (err) {
      console.error("[gateway] request timing handler error:", err);
    }
  }

  private buildConnectClient(): GatewayConnectClientInfo {
    return {
      id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: this.opts.clientVersion ?? "control-ui",
      platform: this.opts.platform ?? navigator.platform ?? "web",
      mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
      instanceId: this.opts.instanceId,
    };
  }

  private buildConnectParams(plan: ConnectPlan): GatewayConnectParams {
    return {
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: plan.client,
      role: plan.role,
      scopes: plan.scopes,
      device: plan.device,
      caps: ["tool-events"],
      auth: plan.auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };
  }

  private async buildConnectPlan(connectNonce: string | null): Promise<ConnectPlan> {
    const role = CONTROL_UI_OPERATOR_ROLE;
    const client = this.buildConnectClient();
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: SelectedConnectAuth = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
      canFallbackToShared: false,
    };

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      selectedAuth = this.selectConnectAuth({
        role,
        deviceId: deviceIdentity.deviceId,
      });
    }
    const scopes = resolveControlUiConnectScopes(selectedAuth);

    return {
      role,
      scopes,
      client,
      explicitGatewayToken,
      selectedAuth,
      auth: buildGatewayConnectAuth(selectedAuth),
      deviceIdentity,
      device: await buildGatewayConnectDevice({
        deviceIdentity,
        client,
        role,
        scopes,
        authToken: selectedAuth.authToken,
        connectNonce,
      }),
    };
  }

  private handleConnectHello(
    hello: GatewayHelloOk,
    plan: ConnectPlan,
    ws: WebSocket,
    generation: number,
  ) {
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.pendingStartupReconnectDelayMs = null;
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        role: hello.auth.role ?? plan.role,
        token: hello.auth.deviceToken,
        scopes: hello.auth.scopes ?? [],
      });
    }
    this.backoffMs = 800;
    this.opts.onHello?.(hello);
  }

  private handleConnectFailure(err: unknown, plan: ConnectPlan, ws: WebSocket, generation: number) {
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    const connectErrorCode =
      err instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(err) : null;
    const recoveryAdvice =
      err instanceof GatewayRequestError ? readConnectErrorRecoveryAdvice(err.details) : {};
    const retryWithDeviceTokenRecommended =
      recoveryAdvice.recommendedNextStep === "retry_with_device_token";
    const canRetryWithDeviceTokenHint =
      recoveryAdvice.canRetryWithDeviceToken === true ||
      retryWithDeviceTokenRecommended ||
      connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;

    if (
      shouldRetryWithDeviceToken({
        deviceTokenRetryBudgetUsed: this.deviceTokenRetryBudgetUsed,
        authDeviceToken: plan.selectedAuth.authDeviceToken,
        explicitGatewayToken: plan.explicitGatewayToken,
        deviceIdentity: plan.deviceIdentity,
        storedToken: plan.selectedAuth.storedToken,
        canRetryWithDeviceTokenHint,
        url: this.opts.url,
      })
    ) {
      this.pendingDeviceTokenRetry = true;
      this.deviceTokenRetryBudgetUsed = true;
    }
    if (err instanceof GatewayRequestError) {
      this.pendingConnectError = {
        code: err.gatewayCode,
        message: err.message,
        details: err.details,
        retryable: err.retryable,
        retryAfterMs: err.retryAfterMs,
      };
    } else {
      this.pendingConnectError = undefined;
    }
    const usedStoredDeviceToken =
      Boolean(plan.selectedAuth.storedToken) &&
      (plan.selectedAuth.resolvedDeviceToken === plan.selectedAuth.storedToken ||
        plan.selectedAuth.authDeviceToken === plan.selectedAuth.storedToken);
    if (
      usedStoredDeviceToken &&
      plan.deviceIdentity &&
      connectErrorCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
    ) {
      clearDeviceAuthToken({ deviceId: plan.deviceIdentity.deviceId, role: plan.role });
    }
    const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err);
    if (startupRetryAfterMs !== null) {
      this.pendingStartupReconnectDelayMs = startupRetryAfterMs;
    }
    if (isRetryableGatewayStartupUnavailableError(err)) {
      ws.close(STARTUP_RETRY_CLOSE_CODE, "gateway starting");
      return;
    }
    ws.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
  }

  private isActiveSocket(ws: WebSocket, generation: number): boolean {
    return !this.closed && this.ws === ws && this.connectGeneration === generation;
  }

  private async sendConnect(ws: WebSocket, generation: number) {
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    this.clearConnectTimer();

    const plan = await this.buildConnectPlan(this.connectNonce);
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    void this.requestOnSocket<GatewayHelloOk>(ws, "connect", this.buildConnectParams(plan))
      .then((hello) => this.handleConnectHello(hello, plan, ws, generation))
      .catch((err: unknown) => this.handleConnectFailure(err, plan, ws, generation));
  }

  private handleMessage(ws: WebSocket, generation: number, raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: unknown } | undefined;
        const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect(ws, generation);
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
      try {
        this.opts.onEvent?.(evt);
        for (const listener of this.eventListeners) {
          listener(evt);
        }
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      this.pending.delete(res.id);
      if (res.ok) {
        this.emitRequestTiming(res.id, pending, true);
        pending.resolve(res.payload);
      } else {
        this.emitRequestTiming(res.id, pending, false, res.error?.code);
        pending.reject(
          new GatewayRequestError({
            code: res.error?.code ?? "UNAVAILABLE",
            message: res.error?.message ?? "request failed",
            details: res.error?.details,
            retryable: res.error?.retryable,
            retryAfterMs: res.error?.retryAfterMs,
          }),
        );
      }
      return;
    }
  }

  private selectConnectAuth(params: { role: string; deviceId: string }): SelectedConnectAuth {
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      role: params.role,
    });
    const storedScopes = storedEntry?.scopes ?? [];
    const storedTokenCanRead =
      params.role !== CONTROL_UI_OPERATOR_ROLE ||
      storedScopes.includes("operator.read") ||
      storedScopes.includes("operator.write") ||
      storedScopes.includes("operator.admin");
    const storedToken = storedTokenCanRead ? storedEntry?.token : undefined;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      isTrustedRetryEndpoint(this.opts.url);
    const resolvedDeviceToken = !(explicitGatewayToken || authPassword)
      ? (storedToken ?? undefined)
      : undefined;
    const authToken = explicitGatewayToken ?? resolvedDeviceToken;
    return {
      authToken,
      authDeviceToken: shouldUseDeviceRetryToken ? (storedToken ?? undefined) : undefined,
      authPassword,
      resolvedDeviceToken,
      storedToken: storedToken ?? undefined,
      storedScopes: storedEntry?.scopes ?? undefined,
      canFallbackToShared: Boolean(storedToken && explicitGatewayToken),
    };
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    return this.requestOnSocket(this.ws, method, params);
  }

  private requestOnSocket<T = unknown>(
    ws: WebSocket,
    method: string,
    params?: unknown,
  ): Promise<T> {
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateUUID();
    const frame = { type: "req", id, method, params };
    const startedAtMs = this.nowMs();
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, method, startedAtMs });
    });
    ws.send(JSON.stringify(frame));
    return p;
  }

  addEventListener(listener: GatewayEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private queueConnect(ws: WebSocket, generation: number) {
    if (!this.isActiveSocket(ws, generation)) {
      return;
    }
    this.connectNonce = null;
    this.connectSent = false;
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      void this.sendConnect(ws, generation);
    }, 750);
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}

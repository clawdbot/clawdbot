// Control UI module implements gateway behavior.
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  readConnectErrorRecoveryAdvice,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  isRetryableGatewayStartupUnavailableError,
  resolveGatewayStartupRetryAfterMs,
} from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { buildDeviceAuthPayload } from "../../../src/gateway/device-auth.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  peekStoredDeviceIdentityId,
  signDevicePayload,
} from "../lib/nodes/index.ts";
import { generateUUID } from "../lib/uuid.ts";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

type GatewayResponseFrame = {
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
    const details = enrichProtocolMismatchDetails(error.message, error.details);
    super(
      formatConnectErrorMessage({
        message: error.message,
        details,
      }),
    );
    this.name = "GatewayRequestError";
    this.gatewayCode = error.code;
    this.details = details;
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
 * Connect failures that cannot recover while client and server state stay unchanged.
 * AUTH_TOKEN_MISMATCH stays out: the close handler owns its bounded cached-token retry.
 */
export function isNonRecoverableConnectError(error: { details?: unknown } | undefined): boolean {
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
    code === ConnectErrorDetailCodes.PROTOCOL_MISMATCH ||
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

export type GatewayControlUiPluginTab = {
  pluginId: string;
  id: string;
  label: string;
  description?: string;
  icon?: string;
  path?: string;
  group?: "control" | "agent";
  order?: number;
};

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
  controlUiTabs?: GatewayControlUiPluginTab[];
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
  authBootstrapToken?: string;
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

export const CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES = [
  "operator.approvals",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;

export type GatewayConnectAuth = {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
};

type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

type GatewayConnectClientInfo = {
  id: GatewayClientName;
  version: string;
  platform: string;
  mode: GatewayClientMode;
  instanceId?: string;
};

type GatewayConnectParams = {
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
  bootstrapToken?: string;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onClose?: (info: {
    code: number;
    reason: string;
    error?: GatewayErrorInfo;
    willRetry: boolean;
  }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onRequestTiming?: (timing: GatewayRequestTiming) => void;
  onConnectTiming?: (timing: GatewayConnectTiming) => void;
};

export type GatewayEventListener = (evt: GatewayEventFrame) => void;

type GatewayRequestTiming = {
  id: string;
  method: string;
  ok: boolean;
  durationMs: number;
  startedAtMs: number;
  endedAtMs: number;
  errorCode?: string;
};

type GatewayConnectTimingPhase =
  | "socket-open"
  | "challenge"
  | "fallback"
  | "device-identity-ready"
  | "connect-plan-ready"
  | "request-sent"
  | "hello"
  | "failed";

type GatewayConnectTiming = {
  generation: number;
  phase: GatewayConnectTimingPhase;
  durationMs: number;
  phaseDurationMs: number;
  hasChallenge: boolean;
  usedFallback: boolean;
  secureContext?: boolean;
  hasDeviceIdentity?: boolean;
  hasDevice?: boolean;
  hasAuthToken?: boolean;
  hasBootstrapToken?: boolean;
  hasDeviceToken?: boolean;
  hasPassword?: boolean;
  errorCode?: string;
};

type ConnectTimingState = {
  startedAtMs: number;
  lastAtMs: number;
  hasChallenge: boolean;
  usedFallback: boolean;
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
  const bootstrapToken = selectedAuth.authBootstrapToken;
  if (!(authToken || bootstrapToken || selectedAuth.authPassword)) {
    return undefined;
  }
  return {
    token: authToken,
    bootstrapToken,
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
  if (selectedAuth.authBootstrapToken) {
    return [...CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES];
  }
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

// Operator connects only trust stored device tokens that can at least read;
// weaker tokens go through the pairing upgrade flow instead of silent auth.
function storedDeviceTokenScopesAllowRead(role: string, scopes: readonly string[]): boolean {
  return (
    role !== CONTROL_UI_OPERATOR_ROLE ||
    scopes.includes("operator.read") ||
    scopes.includes("operator.write") ||
    scopes.includes("operator.admin")
  );
}

/**
 * True when the next connect() from this browser would present stored
 * credentials: an explicit token/password, or a readable stored device token
 * in a secure context. Render gating only — lets the app paint a connecting
 * state instead of flashing the login gate while a likely-authenticated first
 * attempt is in flight. connect() remains the source of truth for auth.
 */
export function hasStoredGatewayAuth(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}): boolean {
  if (params.token?.trim() || params.password?.trim()) {
    return true;
  }
  // Mirrors buildConnectPlan: insecure contexts skip device identity, so a
  // stored device token would not be presented and must not suppress the gate.
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return false;
  }
  const deviceId = peekStoredDeviceIdentityId();
  if (!deviceId) {
    return false;
  }
  const storedEntry = loadDeviceAuthToken({
    deviceId,
    gatewayUrl: params.gatewayUrl,
    role: CONTROL_UI_OPERATOR_ROLE,
  });
  if (!storedEntry) {
    return false;
  }
  return storedDeviceTokenScopesAllowRead(CONTROL_UI_OPERATOR_ROLE, storedEntry.scopes);
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
  private connectTiming = new Map<number, ConnectTimingState>();

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
    this.connectTiming.clear();
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
      this.notifyClose({
        code: BROWSER_WEBSOCKET_CLOSE_CODE,
        reason:
          error.code === BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
            ? "security error"
            : "websocket error",
        error,
        // Constructor failures (bad URL, mixed content) never resolve on
        // their own; no reconnect is scheduled for them.
        willRetry: false,
      });
      return;
    }
    const generation = ++this.connectGeneration;
    this.ws = ws;
    this.startConnectTiming(generation);
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
      this.emitConnectTiming(generation, "failed", {
        errorCode: connectError?.code ?? "SOCKET_CLOSED",
      });
      this.ws = null;
      const closeError = connectError
        ? new GatewayRequestError(connectError)
        : new Error(`gateway closed (${ev.code}): ${reason}`);
      if (this.pendingStartupReconnectDelayMs !== null) {
        this.flushPending(closeError);
        this.scheduleReconnect();
        return;
      }
      this.flushPending(closeError);
      const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
      // willRetry drives both the reconnect scheduling below and the app
      // layer's "still reconnecting vs gave up" rendering; keep them in sync.
      const willRetry =
        !this.closed &&
        (connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
          ? this.pendingDeviceTokenRetry
          : !isNonRecoverableConnectError(connectError));
      this.notifyClose({ code: ev.code, reason, error: connectError, willRetry });
      if (willRetry) {
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

  private startConnectTiming(generation: number): void {
    const now = this.nowMs();
    this.connectTiming.set(generation, {
      startedAtMs: now,
      lastAtMs: now,
      hasChallenge: false,
      usedFallback: false,
    });
  }

  private updateConnectTimingState(
    generation: number,
    updates: Partial<Pick<ConnectTimingState, "hasChallenge" | "usedFallback">>,
  ): void {
    const state = this.connectTiming.get(generation);
    if (!state) {
      return;
    }
    Object.assign(state, updates);
  }

  private emitConnectTiming(
    generation: number,
    phase: GatewayConnectTimingPhase,
    payload: Partial<GatewayConnectTiming> = {},
  ): void {
    const state = this.connectTiming.get(generation);
    if (!state) {
      return;
    }
    const endedAtMs = this.nowMs();
    try {
      this.opts.onConnectTiming?.({
        generation,
        phase,
        durationMs: Math.max(0, endedAtMs - state.startedAtMs),
        phaseDurationMs: Math.max(0, endedAtMs - state.lastAtMs),
        hasChallenge: state.hasChallenge,
        usedFallback: state.usedFallback,
        ...payload,
      });
    } catch (err) {
      console.error("[gateway] connect timing handler error:", err);
    } finally {
      state.lastAtMs = endedAtMs;
      if (phase === "hello" || phase === "failed") {
        this.connectTiming.delete(generation);
      }
    }
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

  private connectPlanTimingPayload(plan: ConnectPlan): Partial<GatewayConnectTiming> {
    return {
      secureContext: Boolean(plan.deviceIdentity),
      hasDeviceIdentity: Boolean(plan.deviceIdentity),
      hasDevice: Boolean(plan.device),
      hasAuthToken: Boolean(plan.selectedAuth.authToken),
      hasBootstrapToken: Boolean(plan.selectedAuth.authBootstrapToken),
      hasDeviceToken: Boolean(
        plan.selectedAuth.authDeviceToken ?? plan.selectedAuth.resolvedDeviceToken,
      ),
      hasPassword: Boolean(plan.selectedAuth.authPassword),
    };
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
      caps: [
        GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
        GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
        GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
      ],
      auth: plan.auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };
  }

  private async buildConnectPlan(
    connectNonce: string | null,
    generation: number,
  ): Promise<ConnectPlan> {
    const role = CONTROL_UI_OPERATOR_ROLE;
    const client = this.buildConnectClient();
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && Boolean(crypto.subtle);
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: SelectedConnectAuth = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
      canFallbackToShared: false,
    };

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      this.emitConnectTiming(generation, "device-identity-ready", {
        secureContext: true,
        hasDeviceIdentity: true,
      });
      selectedAuth = this.selectConnectAuth({
        role,
        deviceId: deviceIdentity.deviceId,
      });
    }
    const scopes = resolveControlUiConnectScopes(selectedAuth);
    const device = await buildGatewayConnectDevice({
      deviceIdentity,
      client,
      role,
      scopes,
      authToken: selectedAuth.authBootstrapToken ?? selectedAuth.authToken,
      connectNonce,
    });
    this.emitConnectTiming(generation, "connect-plan-ready", {
      secureContext: isSecureContext,
      hasDeviceIdentity: Boolean(deviceIdentity),
      hasDevice: Boolean(device),
      hasAuthToken: Boolean(selectedAuth.authToken),
      hasBootstrapToken: Boolean(selectedAuth.authBootstrapToken),
      hasDeviceToken: Boolean(selectedAuth.authDeviceToken ?? selectedAuth.resolvedDeviceToken),
      hasPassword: Boolean(selectedAuth.authPassword),
    });

    return {
      role,
      scopes,
      client,
      explicitGatewayToken,
      selectedAuth,
      auth: buildGatewayConnectAuth(selectedAuth),
      deviceIdentity,
      device,
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
    this.opts.bootstrapToken = undefined;
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      this.storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        role: hello.auth.role ?? plan.role,
        token: hello.auth.deviceToken,
        scopes: hello.auth.scopes ?? [],
      });
    }
    this.backoffMs = 800;
    this.emitConnectTiming(generation, "hello", this.connectPlanTimingPayload(plan));
    this.notifyHello(hello);
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
    this.emitConnectTiming(generation, "failed", {
      ...this.connectPlanTimingPayload(plan),
      errorCode: err instanceof GatewayRequestError ? err.gatewayCode : "CLIENT_CONNECT_ERROR",
    });
    const usedStoredDeviceToken =
      Boolean(plan.selectedAuth.storedToken) &&
      (plan.selectedAuth.resolvedDeviceToken === plan.selectedAuth.storedToken ||
        plan.selectedAuth.authDeviceToken === plan.selectedAuth.storedToken);
    if (
      usedStoredDeviceToken &&
      plan.deviceIdentity &&
      connectErrorCode === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH
    ) {
      clearDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        gatewayUrl: this.opts.url,
        role: plan.role,
      });
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

  private storeDeviceAuthToken(params: {
    deviceId: string;
    role: string;
    token: string;
    scopes?: string[];
  }): void {
    storeDeviceAuthToken({
      ...params,
      gatewayUrl: this.opts.url,
    });
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

    const plan = await this.buildConnectPlan(this.connectNonce, generation);
    if (!this.isActiveSocket(ws, generation) || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    this.emitConnectTiming(generation, "request-sent", this.connectPlanTimingPayload(plan));
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
          this.updateConnectTimingState(generation, { hasChallenge: true });
          this.emitConnectTiming(generation, "challenge");
          void this.sendConnect(ws, generation);
        }
        return;
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.notifyGap({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      this.notifyEvent(evt);
      for (const listener of this.eventListeners) {
        try {
          listener(evt);
        } catch (err) {
          console.error("[gateway] event listener error:", err);
        }
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
    }
  }

  private notifyHello(hello: GatewayHelloOk): void {
    try {
      this.opts.onHello?.(hello);
    } catch (err) {
      console.error("[gateway] hello handler error:", err);
    }
  }

  private notifyClose(info: {
    code: number;
    reason: string;
    error?: GatewayErrorInfo;
    willRetry: boolean;
  }): void {
    try {
      this.opts.onClose?.(info);
    } catch (err) {
      console.error("[gateway] close handler error:", err);
    }
  }

  private notifyGap(info: { expected: number; received: number }): void {
    try {
      this.opts.onGap?.(info);
    } catch (err) {
      console.error("[gateway] gap handler error:", err);
    }
  }

  private notifyEvent(evt: GatewayEventFrame): void {
    try {
      this.opts.onEvent?.(evt);
    } catch (err) {
      console.error("[gateway] event handler error:", err);
    }
  }

  private selectConnectAuth(params: { role: string; deviceId: string }): SelectedConnectAuth {
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitBootstrapToken = this.opts.bootstrapToken?.trim() || undefined;
    const authPassword = this.opts.password?.trim() || undefined;
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      gatewayUrl: this.opts.url,
      role: params.role,
    });
    const storedTokenCanRead = storedDeviceTokenScopesAllowRead(
      params.role,
      storedEntry?.scopes ?? [],
    );
    const storedToken = storedTokenCanRead ? storedEntry?.token : undefined;
    const shouldUseDeviceRetryToken =
      this.pendingDeviceTokenRetry &&
      Boolean(explicitGatewayToken) &&
      Boolean(storedToken) &&
      isTrustedRetryEndpoint(this.opts.url);
    const resolvedDeviceToken = !(explicitGatewayToken || authPassword)
      ? (storedToken ?? undefined)
      : undefined;
    if (explicitBootstrapToken) {
      return {
        authBootstrapToken: explicitBootstrapToken,
        authPassword,
        storedToken: storedToken ?? undefined,
        storedScopes: storedEntry?.scopes ?? undefined,
        canFallbackToShared: false,
      };
    }
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
    this.emitConnectTiming(generation, "socket-open");
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      this.updateConnectTimingState(generation, { usedFallback: true });
      this.emitConnectTiming(generation, "fallback");
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

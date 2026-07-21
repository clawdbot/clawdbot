// Control UI module implements gateway behavior.
import {
  buildGatewayConnectAuth,
  buildDeviceAuthPayload,
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  ConnectErrorDetailCodes,
  formatConnectErrorMessage,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  type GatewayConnectAuthSelection,
  type GatewayClientMode,
  type GatewayClientName,
  type GatewayProtocolCloseContext,
  type GatewayProtocolRequestOptions,
  type GatewayProtocolRequestTiming,
  type GatewayProtocolTiming,
  type ConnectParams,
  type ErrorShape,
  type EventFrame,
  type HelloOk,
  shouldPauseGatewayReconnect,
  resolveGatewayConnectScopes,
  readConnectErrorDetailCode,
  selectGatewayConnectAuth,
  shouldRetryGatewayWithDeviceToken,
  isRetryableGatewayStartupUnavailableError,
  resolveGatewayStartupRetryAfterMs,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@openclaw/gateway-client/browser";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  signDevicePayload,
} from "../lib/nodes/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import {
  gatewayRecoveryScopeMaterial,
  GatewayRecoveryScopeTracker,
  storedDeviceTokenScopesAllowRead,
} from "./gateway-browser-auth.ts";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

export { hasStoredGatewayAuth } from "./gateway-browser-auth.ts";

export type GatewayEventFrame = EventFrame;

type GatewayErrorInfo = ErrorShape;

export class GatewayRequestError extends GatewayProtocolRequestError {
  constructor(error: GatewayErrorInfo) {
    const details = enrichProtocolMismatchDetails(error.message, error.details);
    super({
      ...error,
      details,
      message: formatConnectErrorMessage({ message: error.message, details }),
    });
    this.name = "GatewayRequestError";
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

/**
 * Connect failures that cannot recover while client and server state stay unchanged.
 * AUTH_TOKEN_MISMATCH stays out: the close handler owns its bounded cached-token retry.
 */
function isNonRecoverableConnectError(error: { details?: unknown } | undefined): boolean {
  if (!error) {
    return false;
  }
  return shouldPauseGatewayReconnect({
    details: error.details,
    protocolMismatchIsTerminal: true,
  });
}

function isLoopbackIPv4Host(host: string): boolean {
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)
  );
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

export type GatewayControlUiPluginTab = NonNullable<HelloOk["controlUiTabs"]>[number];
export type GatewayHelloOk = Omit<HelloOk, "server" | "features" | "snapshot" | "policy"> & {
  server?: Partial<HelloOk["server"]>;
  features?: Partial<HelloOk["features"]>;
  snapshot?: unknown;
  policy?: Partial<HelloOk["policy"]>;
};

const CONTROL_UI_OPERATOR_ROLE = "operator";

const CONTROL_UI_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
] as const;

const CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES = [
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
] as const;

type GatewayConnectDevice = NonNullable<ConnectParams["device"]>;
type GatewayConnectClientInfo = ConnectParams["client"];

type ConnectPlan = {
  generation: number;
  params: ConnectParams;
  explicitGatewayToken?: string;
  selectedAuth: GatewayConnectAuthSelection;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  recoveryScopeMaterial?: string;
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
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onConnectTiming?: (timing: GatewayConnectTiming) => void;
  onRecoveryScopeChange?: () => void;
};

export type GatewayEventListener = (evt: GatewayEventFrame) => void;

type GatewayConnectTiming = Omit<GatewayProtocolTiming<ConnectPlan>, "plan" | "detail"> & {
  secureContext?: boolean;
  hasDeviceIdentity?: boolean;
  hasDevice?: boolean;
  hasAuthToken?: boolean;
  hasBootstrapToken?: boolean;
  hasDeviceToken?: boolean;
  hasPassword?: boolean;
  errorCode?: string;
};

// 4008 = application-defined code (browser rejects 1008 "Policy Violation")
const CONNECT_FAILED_CLOSE_CODE = 4008;
const STARTUP_RETRY_CLOSE_CODE = 4013;
const BROWSER_WEBSOCKET_CLOSE_CODE = 1006;
const BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE = "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR";
const BROWSER_WEBSOCKET_SECURITY_ERROR_CODE = "BROWSER_WEBSOCKET_SECURITY_ERROR";

function getErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

function toGatewayErrorInfo(error: GatewayRequestError): GatewayErrorInfo {
  const { gatewayCode: code, message, details, retryable, retryAfterMs } = error;
  return { code, message, details, retryable, retryAfterMs };
}

function getErrorName(err: unknown): string | undefined {
  const name =
    err && typeof err === "object" && "name" in err ? (err as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.trim() ? name : undefined;
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
  const details = {
    code: securityError
      ? BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
      : BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE,
    browserErrorName: getErrorName(err),
    browserMessage,
  };
  if (securityError) {
    return {
      code: BROWSER_WEBSOCKET_SECURITY_ERROR_CODE,
      message:
        "Browser refused the Gateway WebSocket for security reasons." +
        (isPlaintextWs
          ? " Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789."
          : " Check the Gateway WebSocket URL and browser security policy."),
      details,
    };
  }
  return {
    code: BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR_CODE,
    message: `Could not create the Gateway WebSocket: ${browserMessage}`,
    details,
  };
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

export class GatewayBrowserClient {
  private readonly client: GatewayProtocolClient<ConnectPlan>;
  inboundActivitySeq = 0;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  private readonly recoveryScopeTracker = new GatewayRecoveryScopeTracker();

  constructor(private opts: GatewayBrowserClientOptions) {
    this.client = new GatewayProtocolClient<ConnectPlan>({
      createSocket: (handlers) => createBrowserGatewaySocket(this.opts.url, handlers),
      createRequestId: generateUUID,
      createRequestError: (error) =>
        new GatewayRequestError({
          code: error.code ?? "UNAVAILABLE",
          message: error.message ?? "request failed",
          details: error.details,
          retryable: error.retryable,
          retryAfterMs: error.retryAfterMs,
        }),
      buildConnectPlan: ({ nonce, generation }) => this.buildConnectPlan(nonce, generation),
      buildConnectParams: (plan) => plan.params,
      onConnectHello: (hello, context) => this.handleConnectHello(hello, context.plan),
      onHello: (hello) => this.opts.onHello?.(hello),
      onConnectFailure: (error, context) => {
        this.client.recordTiming("failed", context.generation, context.plan, {
          errorCode: error.code,
        });
        return this.handleConnectFailure(error, context.plan);
      },
      resolveClose: (context) => this.resolveClose(context),
      onClose: (context, decision) => {
        const error = context.connectFailure?.error;
        this.client.recordTiming("failed", context.generation, undefined, {
          errorCode: error instanceof GatewayRequestError ? error.code : "SOCKET_CLOSED",
        });
        if (decision.notify) {
          this.opts.onClose?.({
            code: context.code,
            reason: context.reason,
            error: error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined,
            willRetry: decision.retry,
          });
        }
      },
      onSocketFactoryError: (error) => this.handleSocketFactoryError(error),
      onEvent: (event) => this.opts.onEvent?.(event),
      onGap: (info) => this.opts.onGap?.(info),
      onActivity: () => (this.inboundActivitySeq += 1),
      onTiming: ({ plan, detail, ...timing }) => {
        this.opts.onConnectTiming?.({
          ...timing,
          ...(plan ? this.connectPlanTimingPayload(plan) : {}),
          ...(detail && typeof detail === "object" ? detail : {}),
        });
      },
      onRequestTiming: (timing) => this.opts.onRequestTiming?.(timing),
      onCallbackError: (label, error) => console.error(`[gateway] ${label} handler error:`, error),
      handshake: { mode: "fallback", timeoutMs: 750 },
      reconnect: { initialMs: 800, multiplier: 1.7, maxMs: 15_000 },
      nowMs: () =>
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now(),
    });
  }

  get instanceId(): string | undefined {
    return this.opts.instanceId;
  }

  start() {
    this.client.start();
  }

  stop() {
    this.client.stop();
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
  }

  get connected() {
    return this.client.connected;
  }

  get recoveryScope() {
    return this.recoveryScopeTracker.scope;
  }

  get recoveryScopeReady() {
    return this.recoveryScopeTracker.ready;
  }
  private connectPlanTimingPayload(plan: ConnectPlan): Partial<GatewayConnectTiming> {
    return {
      secureContext: Boolean(plan.deviceIdentity),
      hasDeviceIdentity: Boolean(plan.deviceIdentity),
      hasDevice: Boolean(plan.params.device),
      hasAuthToken: Boolean(plan.selectedAuth.authToken),
      hasBootstrapToken: Boolean(plan.selectedAuth.authBootstrapToken),
      hasDeviceToken: Boolean(
        plan.selectedAuth.authDeviceToken ?? plan.selectedAuth.resolvedDeviceToken,
      ),
      hasPassword: Boolean(plan.selectedAuth.authPassword),
    };
  }

  private async buildConnectPlan(
    connectNonce: string | null,
    generation: number,
  ): Promise<ConnectPlan> {
    this.recoveryScopeTracker.begin(generation);
    const role = CONTROL_UI_OPERATOR_ROLE;
    const client: GatewayConnectClientInfo = {
      id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: this.opts.clientVersion ?? "control-ui",
      platform: this.opts.platform ?? navigator.platform ?? "web",
      mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
      instanceId: this.opts.instanceId,
    };
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    // Over plain HTTP, we skip device identity and fall back to token-only auth.
    // Gateways may reject this unless gateway.controlUi.allowInsecureAuth is enabled.
    const isSecureContext = typeof crypto !== "undefined" && Boolean(crypto.subtle);
    let deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    let selectedAuth: GatewayConnectAuthSelection = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
    };

    if (isSecureContext) {
      deviceIdentity = await loadOrCreateDeviceIdentity();
      this.client.recordTiming("device-identity-ready", generation, undefined, {
        secureContext: true,
        hasDeviceIdentity: true,
      });
      selectedAuth = this.selectConnectAuth({
        role,
        deviceId: deviceIdentity.deviceId,
      });
    }
    const scopes = resolveGatewayConnectScopes({
      requestedScopes: selectedAuth.authBootstrapToken
        ? [...CONTROL_UI_BOOTSTRAP_OPERATOR_SCOPES]
        : undefined,
      usingStoredDeviceToken: selectedAuth.usingStoredDeviceToken,
      storedScopes: selectedAuth.storedScopes,
      defaultScopes: CONTROL_UI_OPERATOR_SCOPES,
    });
    const device = await buildGatewayConnectDevice({
      deviceIdentity,
      client,
      role,
      scopes,
      authToken: selectedAuth.authBootstrapToken ?? selectedAuth.authToken,
      connectNonce,
    });
    const plan: ConnectPlan = {
      generation,
      params: {
        minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role,
        scopes,
        device,
        caps: [
          GATEWAY_CLIENT_CAPS.AGENT_KIND,
          GATEWAY_CLIENT_CAPS.APPROVALS,
          GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS,
          GATEWAY_CLIENT_CAPS.TERMINAL_OFFSET_SEQ,
          GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
          GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
          GATEWAY_CLIENT_CAPS.UI_COMMANDS,
        ],
        auth: buildGatewayConnectAuth(selectedAuth),
        userAgent: navigator.userAgent,
        locale: navigator.language,
      },
      explicitGatewayToken,
      selectedAuth,
      deviceIdentity,
      recoveryScopeMaterial: gatewayRecoveryScopeMaterial(selectedAuth),
    };
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    return plan;
  }

  private handleConnectHello(hello: GatewayHelloOk, plan: ConnectPlan) {
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.opts.bootstrapToken = undefined;
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        gatewayUrl: this.opts.url,
        role: hello.auth.role ?? plan.params.role ?? CONTROL_UI_OPERATOR_ROLE,
        token: hello.auth.deviceToken,
        scopes: hello.auth.scopes ?? [],
      });
    }
    void this.updateRecoveryScopeForHello(hello, plan);
  }

  private async updateRecoveryScopeForHello(hello: GatewayHelloOk, plan: ConnectPlan) {
    if (
      await this.recoveryScopeTracker.resolve({
        generation: plan.generation,
        scopeMaterial: hello.auth?.deviceToken ?? plan.recoveryScopeMaterial,
        isConnected: () => this.client.connected,
      })
    ) {
      this.opts.onRecoveryScopeChange?.();
    }
  }

  private handleConnectFailure(err: GatewayProtocolRequestError, plan: ConnectPlan) {
    const connectErrorCode =
      err instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(err) : null;
    if (
      shouldRetryGatewayWithDeviceToken({
        retryBudgetUsed: this.deviceTokenRetryBudgetUsed,
        currentDeviceToken: plan.selectedAuth.authDeviceToken,
        explicitToken: plan.explicitGatewayToken,
        storedToken: plan.selectedAuth.storedToken,
        trustedEndpoint: Boolean(plan.deviceIdentity) && isTrustedRetryEndpoint(this.opts.url),
        errorDetails: err instanceof GatewayRequestError ? err.details : undefined,
      })
    ) {
      this.pendingDeviceTokenRetry = true;
      this.deviceTokenRetryBudgetUsed = true;
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
      clearDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        gatewayUrl: this.opts.url,
        role: plan.params.role ?? CONTROL_UI_OPERATOR_ROLE,
      });
    }
    const startupRetryAfterMs = resolveGatewayStartupRetryAfterMs(err);
    if (isRetryableGatewayStartupUnavailableError(err)) {
      return {
        closeCode: STARTUP_RETRY_CLOSE_CODE,
        closeReason: "gateway starting",
        reconnectDelayMs: startupRetryAfterMs ?? undefined,
      };
    }
    return { closeCode: CONNECT_FAILED_CLOSE_CODE, closeReason: "connect failed" };
  }

  private selectConnectAuth(params: {
    role: string;
    deviceId: string;
  }): GatewayConnectAuthSelection {
    const storedEntry = loadDeviceAuthToken({
      deviceId: params.deviceId,
      gatewayUrl: this.opts.url,
      role: params.role,
    });
    const storedTokenCanRead = storedDeviceTokenScopesAllowRead(
      params.role,
      storedEntry?.scopes ?? [],
    );
    return selectGatewayConnectAuth({
      token: this.opts.token,
      bootstrapToken: this.opts.bootstrapToken,
      password: this.opts.password,
      storedToken: storedTokenCanRead ? storedEntry?.token : undefined,
      storedScopes: storedEntry?.scopes,
      pendingDeviceTokenRetry: this.pendingDeviceTokenRetry,
      trustedDeviceTokenRetry: isTrustedRetryEndpoint(this.opts.url),
      preferBootstrapToken: true,
    });
  }

  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    return this.client.request<T>(method, params, options);
  }

  addEventListener(listener: GatewayEventListener): () => void {
    return this.client.addEventListener(listener);
  }

  /** Drops a stale socket; the shared reconnect supervisor owns recovery. */
  forceReconnect(reason: string): void {
    this.client.closeSocket(4000, reason);
  }

  private resolveClose(context: GatewayProtocolCloseContext) {
    const error = context.connectFailure?.error;
    const startupDelay = context.connectFailure?.reconnectDelayMs;
    if (startupDelay !== undefined) {
      return { retry: true, notify: false, reconnectDelayMs: startupDelay, pendingError: error };
    }
    const connectError =
      error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined;
    const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
    // This decision drives both scheduling and the store's reconnect rendering.
    const retry =
      connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
        ? this.pendingDeviceTokenRetry
        : !isNonRecoverableConnectError(connectError);
    return { retry, notify: true, pendingError: error };
  }

  private handleSocketFactoryError(error: Error): void {
    const formatted = formatBrowserWebSocketConstructorError(error, this.opts.url);
    this.pendingDeviceTokenRetry = false;
    try {
      this.opts.onClose?.({
        code: BROWSER_WEBSOCKET_CLOSE_CODE,
        reason:
          formatted.code === BROWSER_WEBSOCKET_SECURITY_ERROR_CODE
            ? "security error"
            : "websocket error",
        error: formatted,
        willRetry: false,
      });
    } catch (callbackError) {
      console.error("[gateway] close handler error:", callbackError);
    }
  }
}

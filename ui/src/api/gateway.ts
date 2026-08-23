import {
  buildGatewayConnectAuth,
  buildDeviceAuthPayload,
  ConnectErrorDetailCodes,
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
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
  resolveGatewayConnectScopes,
  selectGatewayConnectAuth,
  shouldRetryGatewayWithDeviceToken,
  isRetryableGatewayStartupUnavailableError,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  resolveGatewayStartupRetryAfterMs,
  resolveSafeTimeoutDelayMs,
  shouldPauseGatewayReconnect,
} from "@openclaw/gateway-client/browser";
import type {
  GatewayScopeUpgrade,
  ScopeUpgradeBinding,
} from "@openclaw/gateway-client/scope-upgrade";
// Control UI module implements gateway behavior.
import {
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT,
  type ControlUiBootstrapProfileHint,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES,
} from "../../../src/shared/device-bootstrap-profile.js";
import { formatUiError } from "../lib/format-error.ts";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  signDevicePayload,
} from "../lib/nodes/index.ts";
import { generateUUID } from "../lib/uuid.ts";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";
import {
  enrichProtocolMismatchDetails,
  resolveGatewayErrorDetailCode,
} from "./gateway-connect-errors.ts";
export type { EventFrame as GatewayEventFrame } from "@openclaw/gateway-client/browser";

export { resolveGatewayErrorDetailCode };

export class GatewayRequestError extends GatewayProtocolRequestError {
  constructor(error: ErrorShape) {
    const details = enrichProtocolMismatchDetails(error.message, error.details);
    super({
      ...error,
      details,
      message: formatConnectErrorMessage({ message: error.message, details }),
    });
    this.name = "GatewayRequestError";
  }
}

function browserSecureContext(): boolean {
  const win = typeof window !== "undefined" ? window : undefined;
  return win?.isSecureContext === true;
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
export type GatewayControlUiPluginWidgetKind = NonNullable<HelloOk["controlUiWidgetKinds"]>[number];
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

type ConnectPlan = {
  generation: number;
  params: ConnectParams;
  explicitGatewayToken?: string;
  selectedAuth: GatewayConnectAuthSelection;
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
};

export type GatewayBrowserClientOptions = {
  url: string;
  token?: string;
  bootstrapToken?: string;
  bootstrapProfile?: ControlUiBootstrapProfileHint;
  password?: string;
  clientName?: GatewayClientName;
  clientVersion?: string;
  clientBuildId?: string;
  platform?: string;
  mode?: GatewayClientMode;
  instanceId?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onEvent?: (evt: EventFrame) => void;
  onClose?: (info: {
    code: number;
    reason: string;
    error?: ErrorShape;
    willRetry: boolean;
  }) => void;
  onGap?: (info: { expected: number; received: number }) => void;
  onRequestTiming?: (timing: GatewayProtocolRequestTiming) => void;
  onConnectTiming?: (timing: GatewayConnectTiming) => void;
  onRecoveryScopeChange?: () => void;
};

export type GatewayEventListener = (evt: EventFrame) => void;

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
const DEFAULT_GATEWAY_TICK_INTERVAL_MS = 30_000;
const MIN_GATEWAY_TICK_WATCH_INTERVAL_MS = 1_000;
function toGatewayErrorInfo(error: GatewayRequestError): ErrorShape {
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
  const message = formatUiError(err).toLowerCase();
  return (
    name === "securityerror" ||
    message.includes("security error") ||
    message.includes("mixed content") ||
    message.includes("insecure websocket")
  );
}

function formatBrowserWebSocketConstructorError(err: unknown, url: string): ErrorShape {
  const securityError = isBrowserWebSocketSecurityError(err);
  const browserMessage = formatUiError(err);
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

async function deriveLegacyV4RecoveryScope(material: string | undefined): Promise<string> {
  if (!material || typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return "";
  }
}

async function buildGatewayConnectDevice(params: {
  deviceIdentity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null;
  client: ConnectParams["client"];
  role: string;
  scopes: string[];
  authToken?: string;
  connectNonce: string | null;
  connectChallengeTs: number | null | undefined;
}): Promise<NonNullable<ConnectParams["device"]> | undefined> {
  const { deviceIdentity } = params;
  if (!deviceIdentity) {
    return undefined;
  }
  if (params.connectChallengeTs === null) {
    throw new Error("gateway connect challenge timestamp invalid");
  }
  // The Control UI alone supports pre-challenge Gateways; that timeout fallback has no server time.
  const signedAtMs = params.connectChallengeTs ?? Date.now();
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
  private maxPayloadBytes: number | undefined;
  private scopeUpgradeRuntime: Promise<GatewayScopeUpgrade> | null = null;
  inboundActivitySeq = 0;
  private lastInboundActivityAtMs: number | null = null;
  private tickWatchTimer: ReturnType<typeof setInterval> | null = null;
  private pendingDeviceTokenRetry = false;
  private deviceTokenRetryBudgetUsed = false;
  // Close/stop advances this generation before another socket can make stale hello work look active.
  private recovery = { value: "", resolved: false, generation: 0 };
  private scopeUpgradeBinding: ScopeUpgradeBinding | null = null;

  constructor(private opts: GatewayBrowserClientOptions) {
    this.client = new GatewayProtocolClient<ConnectPlan>({
      createSocket: (handlers) => {
        this.maxPayloadBytes = undefined;
        const socket = createBrowserGatewaySocket(this.opts.url, handlers);
        return {
          ...socket,
          send: (data) => {
            if (
              this.maxPayloadBytes !== undefined &&
              new TextEncoder().encode(data).byteLength > this.maxPayloadBytes
            ) {
              throw new Error(
                "Request exceeds the Gateway payload limit. Shorten the message or remove one or more attachments and retry.",
              );
            }
            socket.send(data);
          },
        };
      },
      createRequestId: generateUUID,
      createRequestError: (error) =>
        new GatewayRequestError({
          code: error.code ?? "UNAVAILABLE",
          message: error.message ?? "request failed",
          details: error.details,
          retryable: error.retryable,
          retryAfterMs: error.retryAfterMs,
        }),
      buildConnectPlan: ({ nonce, challengeTs, generation }) =>
        this.buildConnectPlan(nonce, challengeTs, generation),
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
        this.recovery = { ...this.recovery, generation: context.generation + 1, resolved: false };
        this.stopTickWatch();
        this.scopeUpgradeBinding = null;
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
      onActivity: () => {
        this.inboundActivitySeq += 1;
        this.lastInboundActivityAtMs = Date.now();
      },
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

  get gatewayUrl(): string {
    return this.opts.url;
  }

  start() {
    this.client.start();
  }

  stop() {
    this.stopTickWatch();
    this.recovery = { ...this.recovery, generation: this.recovery.generation + 1, resolved: false };
    this.client.stop();
    this.cancelScopeUpgrade();
    this.scopeUpgradeBinding = null;
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
  }

  get connected() {
    return this.client.connected;
  }

  get recoveryScope() {
    return this.recovery.value;
  }

  get recoveryScopeReady() {
    return this.recovery.resolved;
  }

  get scopeUpgradeReady() {
    return this.connected && this.scopeUpgradeBinding !== null;
  }

  private connectPlanTimingPayload(plan: ConnectPlan): Partial<GatewayConnectTiming> {
    return {
      secureContext: browserSecureContext(),
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
    connectChallengeTs: number | null | undefined,
    generation: number,
  ): Promise<ConnectPlan> {
    this.recovery = { ...this.recovery, generation, resolved: false };
    const role = CONTROL_UI_OPERATOR_ROLE;
    // Gateway Coupling makes the connect handshake the only version-skew gate.
    // A configured build identity must never be omitted or downgraded.
    const client: ConnectParams["client"] = {
      id: this.opts.clientName ?? GATEWAY_CLIENT_NAMES.CONTROL_UI,
      version: this.opts.clientVersion ?? "control-ui",
      buildId: this.opts.clientBuildId,
      platform: this.opts.platform ?? navigator.platform ?? "web",
      mode: this.opts.mode ?? GATEWAY_CLIENT_MODES.WEBCHAT,
      instanceId: this.opts.instanceId,
    };
    const explicitGatewayToken = this.opts.token?.trim() || undefined;
    const explicitPassword = this.opts.password?.trim() || undefined;

    // Pure-JS Ed25519 signing keeps device identity working on any origin,
    // including plain-HTTP dashboards without crypto.subtle; only a failed
    // mint (no WebCrypto RNG) degrades to a device-less connect.
    let selectedAuth: GatewayConnectAuthSelection = {
      authToken: explicitGatewayToken,
      authPassword: explicitPassword,
    };
    const deviceIdentity = await loadOrCreateDeviceIdentity().catch(() => null);
    this.client.recordTiming("device-identity-ready", generation, undefined, {
      secureContext: browserSecureContext(),
      hasDeviceIdentity: deviceIdentity !== null,
    });
    if (deviceIdentity) {
      selectedAuth = this.selectConnectAuth({ role, deviceId: deviceIdentity.deviceId });
    }
    const scopes = resolveGatewayConnectScopes({
      requestedScopes: selectedAuth.authBootstrapToken
        ? this.opts.bootstrapProfile === CONTROL_UI_OWNER_BOOTSTRAP_PROFILE_HINT
          ? [...CONTROL_UI_OWNER_BOOTSTRAP_OPERATOR_SCOPES]
          : [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]
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
      connectChallengeTs,
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
    };
    if (this.pendingDeviceTokenRetry && plan.selectedAuth.authDeviceToken) {
      this.pendingDeviceTokenRetry = false;
    }
    return plan;
  }

  private handleConnectHello(hello: GatewayHelloOk, plan: ConnectPlan) {
    this.maxPayloadBytes = hello.policy?.maxPayload;
    this.startTickWatch(hello);
    this.pendingDeviceTokenRetry = false;
    this.deviceTokenRetryBudgetUsed = false;
    this.opts.bootstrapToken = undefined;
    this.opts.bootstrapProfile = undefined;
    this.scopeUpgradeBinding = plan.deviceIdentity && {
      clientId: plan.params.client.id,
      deviceId: plan.deviceIdentity.deviceId,
      role: plan.params.role ?? CONTROL_UI_OPERATOR_ROLE,
    };
    if (hello?.auth?.deviceToken && plan.deviceIdentity) {
      const role = hello.auth.role ?? plan.params.role ?? CONTROL_UI_OPERATOR_ROLE;
      const scopes =
        role === plan.params.role && hello.auth.deviceToken === plan.selectedAuth.storedToken
          ? (plan.selectedAuth.storedScopes ?? hello.auth.scopes ?? [])
          : (hello.auth.scopes ?? []);
      storeDeviceAuthToken({
        deviceId: plan.deviceIdentity.deviceId,
        gatewayUrl: this.opts.url,
        role,
        token: hello.auth.deviceToken,
        scopes,
      });
    }
    void this.resolveRecoveryScope(hello, plan);
  }

  private async resolveRecoveryScope(hello: GatewayHelloOk, plan: ConnectPlan) {
    const serverScope = hello.auth?.recoveryScope;
    const legacyScope = await deriveLegacyV4RecoveryScope(
      hello.auth?.deviceToken ??
        plan.selectedAuth.authDeviceToken ??
        plan.selectedAuth.resolvedDeviceToken ??
        plan.selectedAuth.authToken,
    );
    const migrateRecoveryScope =
      serverScope && hello.auth?.recoveryMigrationAllowed === true && legacyScope
        ? (await import("../lib/sessions/session-placement-recovery-migration.runtime.ts")).default
        : undefined;
    if (plan.generation !== this.recovery.generation || !this.client.connected) {
      return;
    }
    migrateRecoveryScope?.(this.opts.url, legacyScope, serverScope!);
    this.recovery.value = serverScope ?? legacyScope;
    this.recovery.resolved = true;
    this.opts.onRecoveryScopeChange?.();
  }

  private startTickWatch(hello: GatewayHelloOk): void {
    this.stopTickWatch();
    const advertisedTickIntervalMs = hello.policy?.tickIntervalMs;
    // Gateway policy is remote input; use the shared timer clamp so an
    // oversized interval cannot wrap into a resource-exhausting hot loop.
    const tickIntervalMs = resolveSafeTimeoutDelayMs(
      typeof advertisedTickIntervalMs === "number" &&
        Number.isFinite(advertisedTickIntervalMs) &&
        advertisedTickIntervalMs > 0
        ? advertisedTickIntervalMs
        : DEFAULT_GATEWAY_TICK_INTERVAL_MS,
      { minMs: MIN_GATEWAY_TICK_WATCH_INTERVAL_MS },
    );
    this.lastInboundActivityAtMs = Date.now();
    this.tickWatchTimer = setInterval(() => {
      const lastActivityAtMs = this.lastInboundActivityAtMs;
      // Preserve long-running requests while real Gateway heartbeats arrive;
      // only a silent socket should enter the shared reconnect lifecycle.
      if (lastActivityAtMs !== null && Date.now() - lastActivityAtMs > tickIntervalMs * 2) {
        this.forceReconnect("tick timeout");
      }
    }, tickIntervalMs);
  }

  private stopTickWatch(): void {
    if (this.tickWatchTimer !== null) {
      clearInterval(this.tickWatchTimer);
      this.tickWatchTimer = null;
    }
    this.lastInboundActivityAtMs = null;
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
    const storedScopes = storedEntry?.scopes ?? [];
    const storedTokenCanRead =
      params.role !== CONTROL_UI_OPERATOR_ROLE ||
      storedScopes.includes("operator.read") ||
      storedScopes.includes("operator.write") ||
      storedScopes.includes("operator.admin");
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

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayProtocolRequestOptions,
  ): Promise<T> {
    return await this.client.request<T>(method, params, options);
  }

  async requestScopeUpgrade(options: { onPending?: (requestId: string) => void } = {}) {
    const binding = this.scopeUpgradeBinding;
    if (!this.connected || !binding) {
      throw new Error("scope upgrade requires a connected browser device");
    }
    const runtime = await this.loadScopeUpgradeRuntime();
    return runtime.requestScopeUpgrade({
      binding,
      scopes: CONTROL_UI_OPERATOR_SCOPES,
      onPending: options.onPending,
    });
  }

  cancelScopeUpgrade(): void {
    void this.scopeUpgradeRuntime
      ?.then((runtime) => runtime.cancelScopeUpgrade())
      .catch(() => undefined);
  }

  private loadScopeUpgradeRuntime(): Promise<GatewayScopeUpgrade> {
    return (this.scopeUpgradeRuntime ??= import("./gateway-scope-upgrade.runtime.ts")
      .then(({ createGatewayScopeUpgradeRuntime }) =>
        createGatewayScopeUpgradeRuntime({
          gatewayUrl: this.opts.url,
          request: (method, params, options) => this.request(method, params, options),
          reconnect: () => this.forceReconnect("scope upgrade approved"),
        }),
      )
      .catch((error: unknown) => {
        this.scopeUpgradeRuntime = null;
        throw error;
      }));
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
      return { retry: true, notify: true, reconnectDelayMs: startupDelay, pendingError: error };
    }
    const connectError =
      error instanceof GatewayRequestError ? toGatewayErrorInfo(error) : undefined;
    const connectErrorCode = resolveGatewayErrorDetailCode(connectError);
    // This decision drives both scheduling and the store's reconnect rendering.
    const retry =
      connectErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
        ? this.pendingDeviceTokenRetry
        : !shouldPauseGatewayReconnect({
            details: connectError?.details,
            protocolMismatchIsTerminal: true,
          });
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

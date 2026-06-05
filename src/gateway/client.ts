// OpenClaw Gateway client facade.
// Wraps the shared gateway-client package with OpenClaw host dependencies.
import {
  GatewayClient as BaseGatewayClient,
  GATEWAY_CLOSE_CODE_HINTS as BASE_GATEWAY_CLOSE_CODE_HINTS,
  GatewayClientRequestError as BaseGatewayClientRequestError,
  describeGatewayCloseCode as baseDescribeGatewayCloseCode,
  isGatewayConnectAssemblyError as baseIsGatewayConnectAssemblyError,
  resolveGatewayClientConnectChallengeTimeoutMs as baseResolveGatewayClientConnectChallengeTimeoutMs,
} from "../../packages/gateway-client/src/index.js";
import type {
  GatewayClientMode,
  GatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { EventFrame, HelloOk } from "../../packages/gateway-protocol/src/index.js";
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
  registerManagedProxyGatewayLoopbackBypass,
} from "../infra/net/proxy/proxy-lifecycle.js";
import { normalizeFingerprint } from "../infra/tls/fingerprint.js";
import { logDebug, logError } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { VERSION } from "../version.js";

export type DeviceAuthTokenRecord = {
  token?: string;
  scopes?: string[];
};

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

export type GatewayClientRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onAccepted?: (payload: unknown) => void;
};

export type GatewayReconnectPausedInfo = {
  code: number;
  reason: string;
  detailCode: string | null;
};

type GatewayClientErrorShape = {
  message: string;
  code?: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export const GATEWAY_CLOSE_CODE_HINTS: Readonly<Record<number, string>> =
  BASE_GATEWAY_CLOSE_CODE_HINTS;

export const GatewayClientRequestError = BaseGatewayClientRequestError as unknown as {
  new (error: GatewayClientErrorShape): Error & {
    readonly gatewayCode: string;
    readonly details?: unknown;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;
  };
};

export type GatewayClientRequestError = InstanceType<typeof GatewayClientRequestError>;

export function describeGatewayCloseCode(code: number): string | undefined {
  return baseDescribeGatewayCloseCode(code);
}

export function isGatewayConnectAssemblyError(value: unknown): value is Error {
  return baseIsGatewayConnectAssemblyError(value);
}

export type GatewayClientOptions = {
  url?: string;
  connectChallengeTimeoutMs?: number;
  /** @deprecated Use connectChallengeTimeoutMs. */
  connectDelayMs?: number;
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

export type GatewayClientConnectionMetadata = {
  clientName?: GatewayClientName;
  hasDeviceIdentity: boolean;
  mode?: GatewayClientMode;
  preauthHandshakeTimeoutMs?: number;
};

function createOpenClawGatewayClientHostDeps(
  overrides?: GatewayClientHostDeps,
): GatewayClientHostDeps {
  return {
    // This wrapper is the only place the package reaches into OpenClaw runtime
    // state. Keep device identity, token storage, proxy, and redaction here.
    loadOrCreateDeviceIdentity,
    signDevicePayload,
    publicKeyRawBase64UrlFromPem,
    loadDeviceAuthToken,
    storeDeviceAuthToken,
    clearDeviceAuthToken,
    beforeConnect: ensureInheritedManagedProxyRoutingActive,
    registerGatewayLoopbackBypass: registerManagedProxyGatewayLoopbackBypass,
    normalizeTlsFingerprint: (fingerprint) => normalizeFingerprint(fingerprint ?? ""),
    logDebug,
    logError,
    redactForLog: redactToolPayloadText,
    ...overrides,
  };
}

export function resolveGatewayClientConnectChallengeTimeoutMs(
  opts: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs"
  >,
): number {
  return baseResolveGatewayClientConnectChallengeTimeoutMs(opts);
}

export class GatewayClient {
  #client: BaseGatewayClient;

  constructor(opts: GatewayClientOptions) {
    // Inject host deps here so the reusable package stays decoupled from
    // OpenClaw device identity, token storage, proxy routing, and logging.
    this.#client = new BaseGatewayClient({
      ...opts,
      clientVersion: opts.clientVersion ?? VERSION,
      hostDeps: createOpenClawGatewayClientHostDeps(opts.hostDeps),
    });
  }

  start(): void {
    this.#client.start();
  }

  stop(): void {
    this.#client.stop();
  }

  stopAndWait(opts?: { timeoutMs?: number }): Promise<void> {
    return this.#client.stopAndWait(opts);
  }

  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    return this.#client.request<T>(method, params, opts);
  }

  getConnectionMetadata(): GatewayClientConnectionMetadata {
    const opts = (this.#client as unknown as { opts: GatewayClientOptions }).opts;
    return {
      clientName: opts.clientName,
      hasDeviceIdentity: Boolean(opts.deviceIdentity),
      mode: opts.mode,
      preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs,
    };
  }
}

export type { DeviceIdentity };

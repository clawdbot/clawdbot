// OpenClaw Gateway client facade.
// Injects OpenClaw host dependencies into the shared gateway-client package.
import { GatewayClient as BaseGatewayClient } from "../../packages/gateway-client/src/index.js";
import type {
  GatewayClientConnectionMetadata,
  GatewayClientHostDeps,
  GatewayClientOptions,
  GatewayClientRequestOptions,
} from "../../packages/gateway-client/src/index.js";
import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "../infra/device-auth-store.js";
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

export {
  GatewayClientRequestError,
  isGatewayConnectAssemblyError,
} from "../../packages/gateway-client/src/index.js";
export type {
  GatewayClientCloseInfo,
  GatewayClientOptions,
  GatewayClientRequestOptions,
  GatewayReconnectPausedInfo,
} from "../../packages/gateway-client/src/index.js";

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

export class GatewayClient {
  #client: BaseGatewayClient;

  constructor(opts: GatewayClientOptions) {
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
    return this.#client.getConnectionMetadata();
  }
}

// OpenClaw Gateway client facade.
// Injects OpenClaw host dependencies into the shared gateway-client package.
import { GatewayClient as BaseGatewayClient } from "../../packages/gateway-client/src/index.js";
import type {
  GatewayClientConnectionMetadata,
  GatewayClientHostDeps,
  GatewayClientOptions as BaseGatewayClientOptions,
  GatewayClientRequestOptions,
} from "../../packages/gateway-client/src/index.js";
import {
  clearDeviceAuthToken,
  clearOriginDeviceToken,
  loadDeviceAuthToken,
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceToken,
  loadOriginDeviceTokenReadOnly,
  storeDeviceAuthToken,
  storeOriginDeviceToken,
} from "../infra/device-auth-store.js";
import {
  loadDeviceIdentityIfPresent,
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
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { DeviceAuthEntry } from "../shared/device-auth.js";
import { VERSION } from "../version.js";

export {
  GatewayClientRequestError,
  isGatewayConnectAssemblyError,
} from "../../packages/gateway-client/src/index.js";
export type {
  GatewayClientCloseInfo,
  GatewayClientRequestOptions,
  GatewayReconnectPausedInfo,
} from "../../packages/gateway-client/src/index.js";

export type GatewayClientOptions = BaseGatewayClientOptions & {
  /** Exact normalized remote gateway scope for origin-bound device credentials. */
  deviceAuthScope?: string;
  /** Prevent this client lifecycle from creating or mutating shared state. */
  sharedStateMode?: "read-only";
  /** Auth already resolved and validated by the one-shot call owner. */
  preparedDeviceAuth?: DeviceAuthEntry;
};

function createOpenClawGatewayClientHostDeps(
  overrides?: GatewayClientHostDeps,
  deviceAuthScope?: string,
  suppressOriginDeviceAuth = false,
  sharedStateMode?: "read-only",
  preparedDeviceAuth?: DeviceAuthEntry,
): GatewayClientHostDeps {
  const readOnly = sharedStateMode === "read-only";
  const deviceAuthDeps: Pick<
    GatewayClientHostDeps,
    "loadDeviceAuthToken" | "storeDeviceAuthToken" | "clearDeviceAuthToken"
  > = deviceAuthScope
    ? {
        loadDeviceAuthToken: (params) =>
          suppressOriginDeviceAuth
            ? null
            : readOnly
              ? loadOriginDeviceTokenReadOnly({ ...params, gatewayScope: deviceAuthScope })
              : loadOriginDeviceToken({ ...params, gatewayScope: deviceAuthScope }),
        storeDeviceAuthToken: readOnly
          ? () => {}
          : (params) => storeOriginDeviceToken({ ...params, gatewayScope: deviceAuthScope }),
        clearDeviceAuthToken: readOnly
          ? () => {}
          : (params) => clearOriginDeviceToken({ ...params, gatewayScope: deviceAuthScope }),
      }
    : readOnly
      ? {
          loadDeviceAuthToken: loadDeviceAuthTokenReadOnly,
          storeDeviceAuthToken: () => {},
          clearDeviceAuthToken: () => {},
        }
      : { loadDeviceAuthToken, storeDeviceAuthToken, clearDeviceAuthToken };
  const preparedDeviceAuthDeps = preparedDeviceAuth
    ? { ...deviceAuthDeps, loadDeviceAuthToken: () => preparedDeviceAuth }
    : deviceAuthDeps;
  return {
    // This wrapper is the only place the package reaches into OpenClaw runtime
    // state. Keep device identity, token storage, proxy, and redaction here.
    loadOrCreateDeviceIdentity,
    signDevicePayload,
    publicKeyRawBase64UrlFromPem,
    ...preparedDeviceAuthDeps,
    beforeConnect: ensureInheritedManagedProxyRoutingActive,
    registerGatewayLoopbackBypass: registerManagedProxyGatewayLoopbackBypass,
    normalizeTlsFingerprint: (fingerprint) => normalizeFingerprint(fingerprint ?? ""),
    logDebug,
    logError,
    redactForLog: redactToolPayloadText,
    ...overrides,
    ...(readOnly
      ? {
          // Read-only is an authoritative lifecycle policy: caller overrides
          // must not restore identity creation or token writes behind it.
          loadOrCreateDeviceIdentity: () => loadDeviceIdentityIfPresent() ?? undefined,
          ...preparedDeviceAuthDeps,
        }
      : {}),
  };
}

export class GatewayClient {
  #client: BaseGatewayClient;

  constructor(opts: GatewayClientOptions) {
    const { deviceAuthScope, preparedDeviceAuth, sharedStateMode, ...baseOptions } = opts;
    const suppressOriginDeviceAuth = Boolean(
      deviceAuthScope && (baseOptions.token?.trim() || baseOptions.password?.trim()),
    );
    if (baseOptions.cloudflareAccess) {
      registerSecretValueForRedaction(baseOptions.cloudflareAccess.clientId);
      registerSecretValueForRedaction(baseOptions.cloudflareAccess.clientSecret);
    }
    this.#client = new BaseGatewayClient({
      ...baseOptions,
      clientVersion: baseOptions.clientVersion ?? VERSION,
      hostDeps: createOpenClawGatewayClientHostDeps(
        baseOptions.hostDeps,
        deviceAuthScope,
        suppressOriginDeviceAuth,
        sharedStateMode,
        preparedDeviceAuth,
      ),
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

  updateNodeManifest(manifest: {
    caps: string[];
    commands: string[];
    computerUse?: BaseGatewayClientOptions["computerUse"];
  }): void {
    this.#client.updateNodeManifest(manifest);
  }
}

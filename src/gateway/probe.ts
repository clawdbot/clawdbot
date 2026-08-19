// Gateway reachability probe client.
// Connects to a gateway and summarizes auth, health, status, and presence.
import { randomUUID } from "node:crypto";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { classifyGatewayConnectFailure } from "../../packages/gateway-protocol/src/connect-error-details.js";
import {
  readMissingScopeError,
  type MissingScopeErrorDetails,
} from "../../packages/gateway-protocol/src/gateway-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadDeviceAuthTokenReadOnly,
  loadOriginDeviceTokenReadOnly,
} from "../infra/device-auth-store.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, GatewayClientRequestError } from "./client.js";
import {
  gatewayEdgeAuthValueForTarget,
  normalizeEdgeAuthHeadersConfig,
  resolveEdgeAuthHeaders,
  type EdgeAuthHeadersConfig,
} from "./edge-auth.js";
import { READ_SCOPE } from "./method-scopes.js";
import { isLoopbackHost } from "./net.js";

export type GatewayProbeAuth = {
  token?: string;
  password?: string;
};

export type GatewayProbeClose = {
  code: number;
  reason: string;
  hint?: string;
};

export type GatewayProbeCapability =
  | "unknown"
  | "pairing_pending"
  | "connected_no_operator_scope"
  | "read_only"
  | "write_capable"
  | "admin_capable";

export type GatewayProbeAuthSummary = {
  role: string | null;
  scopes: string[];
  capability: GatewayProbeCapability;
};

export type GatewayProbeServerSummary = {
  version: string | null;
  buildId?: string;
  connId: string | null;
};

export type GatewayProbeResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  connectErrorDetails?: unknown;
  missingScopeErrorDetails?: MissingScopeErrorDetails;
  close: GatewayProbeClose | null;
  auth: GatewayProbeAuthSummary;
  server?: GatewayProbeServerSummary;
  health: unknown;
  status: unknown;
  presence: SystemPresence[] | null;
  configSnapshot: unknown;
};

type GatewayProbeDetailLevel = "none" | "presence" | "config" | "full";

const MIN_PROBE_TIMEOUT_MS = 250;
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_ADMIN_SCOPE = "operator.admin";
const DEVICE_IDENTITY_REQUIRED_CLOSE_CODE = 1008;
const DEVICE_IDENTITY_REQUIRED_CLOSE_REASON = "device identity required";
const DEVICE_REQUIRED_PROBE_FAILURE_THRESHOLD = 3;
const DEVICE_REQUIRED_PROBE_TTL_MS = 5 * 60_000;
const PROBE_CLIENT_STOP_TIMEOUT_MS = 1_000;

type DeviceRequiredProbeCacheEntry = {
  failures: number;
  firstFailureAtMs: number;
};

const deviceRequiredProbeCache = new Map<string, DeviceRequiredProbeCacheEntry>();

export function clampProbeTimeoutMs(timeoutMs: number): number {
  return resolveSafeTimeoutDelayMs(timeoutMs, { minMs: MIN_PROBE_TIMEOUT_MS });
}

function formatProbeCloseError(close: GatewayProbeClose): string {
  return `gateway closed (${close.code}): ${close.reason}`;
}

function resolveDeviceRequiredProbeCacheKey(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function isDeviceIdentityRequiredClose(close: GatewayProbeClose | null): boolean {
  return (
    close?.code === DEVICE_IDENTITY_REQUIRED_CLOSE_CODE &&
    close.reason.trim().toLowerCase() === DEVICE_IDENTITY_REQUIRED_CLOSE_REASON
  );
}

function hasProbeAuth(auth: GatewayProbeAuth | undefined): boolean {
  return Boolean(auth?.token?.trim() || auth?.password?.trim());
}

function resolveProbeDeviceAuthScope(url: string): string | undefined {
  try {
    return isLoopbackHost(new URL(url).hostname) ? undefined : gatewayOriginScope(url);
  } catch {
    return undefined;
  }
}

function shouldShortCircuitDeviceRequiredProbe(cacheKey: string, nowMs: number): boolean {
  // Repeated unauthenticated probes can trigger pairing/device-required closes.
  // Short-circuit briefly so status checks do not spam the gateway.
  const entry = deviceRequiredProbeCache.get(cacheKey);
  if (!entry) {
    return false;
  }
  if (nowMs - entry.firstFailureAtMs >= DEVICE_REQUIRED_PROBE_TTL_MS) {
    deviceRequiredProbeCache.delete(cacheKey);
    return false;
  }
  return entry.failures >= DEVICE_REQUIRED_PROBE_FAILURE_THRESHOLD;
}

function noteDeviceRequiredProbeFailure(cacheKey: string, nowMs: number): void {
  const existing = deviceRequiredProbeCache.get(cacheKey);
  if (!existing || nowMs - existing.firstFailureAtMs >= DEVICE_REQUIRED_PROBE_TTL_MS) {
    deviceRequiredProbeCache.set(cacheKey, { failures: 1, firstFailureAtMs: nowMs });
    return;
  }
  existing.failures += 1;
}

function clearDeviceRequiredProbeFailures(cacheKey: string): void {
  deviceRequiredProbeCache.delete(cacheKey);
}

function emptyProbeAuth(): GatewayProbeAuthSummary {
  return {
    role: null,
    scopes: [],
    capability: "unknown",
  };
}

function emptyProbeServer(): GatewayProbeServerSummary {
  return {
    version: null,
    connId: null,
  };
}

function makeDeviceRequiredShortCircuitResult(url: string): GatewayProbeResult {
  const close = {
    code: DEVICE_IDENTITY_REQUIRED_CLOSE_CODE,
    reason: DEVICE_IDENTITY_REQUIRED_CLOSE_REASON,
    hint: "probe short-circuited by recent device-required rejections",
  };
  return {
    ok: false,
    url,
    connectLatencyMs: null,
    error: formatProbeCloseError(close),
    close,
    auth: emptyProbeAuth(),
    server: emptyProbeServer(),
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

function resolveProbeAuthSummary(params: {
  role?: string | null;
  scopes?: string[];
  authMetadataPresent?: boolean;
  connectErrorDetails?: unknown;
  error?: string | null;
  close?: GatewayProbeClose | null;
  verifiedRead?: boolean;
  connectLatencyMs?: number | null;
}): GatewayProbeAuthSummary {
  const scopes = Array.isArray(params.scopes) ? params.scopes : [];
  return {
    role: params.role ?? null,
    scopes,
    capability: resolveGatewayProbeCapability({
      auth: { scopes },
      authMetadataPresent: params.authMetadataPresent,
      connectErrorDetails: params.connectErrorDetails,
      error: params.error,
      close: params.close,
      verifiedRead: params.verifiedRead,
      connectLatencyMs: params.connectLatencyMs,
    }),
  };
}

function resolveGatewayProbeCapability(params: {
  auth?: Pick<GatewayProbeAuthSummary, "scopes"> | null;
  authMetadataPresent?: boolean;
  connectErrorDetails?: unknown;
  error?: string | null;
  close?: GatewayProbeClose | null;
  verifiedRead?: boolean;
  connectLatencyMs?: number | null;
}): GatewayProbeCapability {
  if (
    classifyGatewayConnectFailure({
      details: params.connectErrorDetails,
      reason: params.close?.reason,
      message: params.error,
    }).kind === "pairing-required"
  ) {
    return "pairing_pending";
  }
  const scopes = Array.isArray(params.auth?.scopes) ? params.auth.scopes : [];
  if (scopes.includes(OPERATOR_ADMIN_SCOPE)) {
    return "admin_capable";
  }
  if (scopes.includes(OPERATOR_WRITE_SCOPE)) {
    return "write_capable";
  }
  if (scopes.includes(OPERATOR_READ_SCOPE) || params.verifiedRead === true) {
    return "read_only";
  }
  if (params.connectLatencyMs != null && params.authMetadataPresent === true) {
    return "connected_no_operator_scope";
  }
  return "unknown";
}

export async function probeGateway(opts: {
  url: string;
  /** Treat an explicitly remote loopback URL as a stable origin-scoped auth target. */
  originScopedDeviceAuth?: boolean;
  /** Disable persisted device auth when the transport does not identify a stable Gateway origin. */
  suppressStoredDeviceAuth?: boolean;
  auth?: GatewayProbeAuth;
  config?: OpenClawConfig;
  timeoutMs: number;
  preauthHandshakeTimeoutMs?: number;
  includeDetails?: boolean;
  detailLevel?: GatewayProbeDetailLevel;
  tlsFingerprint?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GatewayProbeResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  let connectLatencyMs: number | null = null;
  let connectError: string | null = null;
  let connectErrorDetails: unknown = null;
  let close: GatewayProbeClose | null = null;
  let auth = emptyProbeAuth();
  let server = emptyProbeServer();
  let authMetadataPresent = false;

  const detailLevel = opts.includeDetails === false ? "none" : (opts.detailLevel ?? "full");
  const deviceAuthScope = opts.suppressStoredDeviceAuth
    ? undefined
    : opts.originScopedDeviceAuth
      ? gatewayOriginScope(opts.url)
      : resolveProbeDeviceAuthScope(opts.url);

  const deviceIdentity = await (async () => {
    try {
      if (!URL.canParse(opts.url)) {
        return null;
      }
      const { loadDeviceIdentityIfPresent } = await import("../infra/device-identity.js");
      const identity = loadDeviceIdentityIfPresent({ env: opts.env });
      if (!identity) {
        return null;
      }
      // Keep probes non-mutating: only attach a device identity when this CLI
      // already has a cached operator device token. Fresh diagnostics should not
      // create a read-only pairing baseline that later blocks admin commands.
      const cachedOperatorToken = opts.suppressStoredDeviceAuth
        ? null
        : deviceAuthScope
          ? loadOriginDeviceTokenReadOnly({
              gatewayScope: deviceAuthScope,
              deviceId: identity.deviceId,
              role: "operator",
              env: opts.env,
            })
          : loadDeviceAuthTokenReadOnly({
              deviceId: identity.deviceId,
              role: "operator",
              env: opts.env,
            });
      return cachedOperatorToken ? identity : null;
    } catch {
      // Read-only or restricted environments should still be able to run
      // token/password-auth detail probes without mutating identity state.
      return null;
    }
  })();
  const cacheKey = resolveDeviceRequiredProbeCacheKey(opts.url);
  const cacheEligible = deviceIdentity == null && !hasProbeAuth(opts.auth);
  if (cacheEligible && shouldShortCircuitDeviceRequiredProbe(cacheKey, Date.now())) {
    return makeDeviceRequiredShortCircuitResult(opts.url);
  }
  const initialProbeTimeoutMs = clampProbeTimeoutMs(opts.timeoutMs);
  const edgeAuthConfig: EdgeAuthHeadersConfig | undefined = normalizeEdgeAuthHeadersConfig(
    gatewayEdgeAuthValueForTarget({ config: opts.config ?? {}, targetUrl: opts.url }),
  );
  const edgeAuthHeaders = await resolveEdgeAuthHeaders({
    config: opts.config ?? {},
    value: edgeAuthConfig,
    targetUrl: opts.url,
    env: opts.env ?? process.env,
  });

  return await new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startAbort = new AbortController();
    const clearProbeTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const armProbeTimer = (onTimeout: () => void, timeoutMs = initialProbeTimeoutMs) => {
      clearProbeTimer();
      timer = setTimeout(onTimeout, resolveSafeTimeoutDelayMs(timeoutMs));
    };
    const settle = (
      result: Omit<GatewayProbeResult, "url" | "connectErrorDetails"> & {
        connectErrorDetails?: unknown;
      },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      startAbort.abort();
      clearProbeTimer();
      void (async () => {
        try {
          await client.stopAndWait({ timeoutMs: PROBE_CLIENT_STOP_TIMEOUT_MS });
        } catch {
          client.stop();
        }
        if (result.ok) {
          clearDeviceRequiredProbeFailures(cacheKey);
        } else if (cacheEligible && isDeviceIdentityRequiredClose(result.close)) {
          noteDeviceRequiredProbeFailure(cacheKey, Date.now());
        }
        const { connectErrorDetails: resultConnectErrorDetails, ...rest } = result;
        resolve({
          url: opts.url,
          ...rest,
          ...(resultConnectErrorDetails != null
            ? { connectErrorDetails: resultConnectErrorDetails }
            : {}),
        });
      })();
    };
    const settleProbe = (params: {
      ok: boolean;
      error: string | null;
      missingScopeErrorDetails?: MissingScopeErrorDetails;
      verifiedRead?: boolean;
      health: unknown;
      status: unknown;
      presence: SystemPresence[] | null;
      configSnapshot: unknown;
    }) => {
      settle({
        ok: params.ok,
        connectLatencyMs,
        error: params.error,
        ...(params.missingScopeErrorDetails
          ? { missingScopeErrorDetails: params.missingScopeErrorDetails }
          : {}),
        connectErrorDetails,
        close,
        auth: resolveProbeAuthSummary({
          role: auth.role,
          scopes: auth.scopes,
          authMetadataPresent,
          connectErrorDetails,
          error: params.error,
          close,
          verifiedRead: params.verifiedRead,
          connectLatencyMs,
        }),
        server,
        health: params.health,
        status: params.status,
        presence: params.presence,
        configSnapshot: params.configSnapshot,
      });
    };

    const client = new GatewayClient({
      url: opts.url,
      ...(deviceAuthScope ? { deviceAuthScope } : {}),
      token: opts.auth?.token,
      password: opts.auth?.password,
      edgeAuthHeaders,
      tlsFingerprint: opts.tlsFingerprint,
      preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs,
      env: opts.env,
      scopes: [READ_SCOPE],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.PROBE,
      sharedStateMode: "read-only",
      instanceId,
      deviceIdentity,
      onConnectError: (err) => {
        connectError = formatErrorMessage(err);
        connectErrorDetails = err instanceof GatewayClientRequestError ? err.details : null;
      },
      onClose: (code, reason, info) => {
        close = { code, reason };
        if (connectLatencyMs == null) {
          // Preserve the transport boundary: request-level handshake failures
          // still prove the listener was reachable once the socket opened.
          if (info?.transportValidated === true) {
            connectLatencyMs = Date.now() - startedAt;
          }
          settleProbe({
            ok: false,
            error: connectError || formatProbeCloseError(close),
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        }
      },
      onHelloOk: (hello) => {
        void (async () => {
          connectLatencyMs = Date.now() - startedAt;
          authMetadataPresent = typeof hello?.auth === "object" && hello.auth !== null;
          server = {
            version: typeof hello?.server?.version === "string" ? hello.server.version : null,
            ...(typeof hello?.server?.buildId === "string"
              ? { buildId: hello.server.buildId }
              : {}),
            connId: typeof hello?.server?.connId === "string" ? hello.server.connId : null,
          };
          auth = resolveProbeAuthSummary({
            role: typeof hello?.auth?.role === "string" ? hello.auth.role : null,
            scopes: Array.isArray(hello?.auth?.scopes)
              ? hello.auth.scopes.filter((scope): scope is string => typeof scope === "string")
              : [],
            authMetadataPresent,
          });
          if (detailLevel === "none") {
            settleProbe({
              ok: true,
              error: null,
              verifiedRead: false,
              health: null,
              status: null,
              presence: null,
              configSnapshot: null,
            });
            return;
          }
          // Once the gateway has accepted the session, a slow follow-up RPC should no longer
          // downgrade the probe to "unreachable". Give detail fetching its own budget.
          armProbeTimer(() => {
            settleProbe({
              ok: false,
              error: "timeout",
              health: null,
              status: null,
              presence: null,
              configSnapshot: null,
            });
          });
          try {
            if (detailLevel === "presence") {
              const presence = await client.request("system-presence");
              settleProbe({
                ok: true,
                error: null,
                verifiedRead: true,
                health: null,
                status: null,
                presence: Array.isArray(presence) ? (presence as SystemPresence[]) : null,
                configSnapshot: null,
              });
              return;
            }
            if (detailLevel === "config") {
              const configSnapshot = await client.request("config.get", {});
              settleProbe({
                ok: true,
                error: null,
                verifiedRead: true,
                health: null,
                status: null,
                presence: null,
                configSnapshot,
              });
              return;
            }
            const [health, status, presence, configSnapshot] = await Promise.all([
              client.request("health"),
              client.request("status"),
              client.request("system-presence"),
              client.request("config.get", {}),
            ]);
            settleProbe({
              ok: true,
              error: null,
              verifiedRead: true,
              health,
              status,
              presence: Array.isArray(presence) ? (presence as SystemPresence[]) : null,
              configSnapshot,
            });
          } catch (err) {
            const error = formatErrorMessage(err);
            const missingScopeErrorDetails = readMissingScopeError(err);
            settleProbe({
              ok: false,
              error,
              ...(missingScopeErrorDetails ? { missingScopeErrorDetails } : {}),
              health: null,
              status: null,
              presence: null,
              configSnapshot: null,
            });
          }
        })();
      },
    });

    armProbeTimer(() => {
      const error = connectError ? `connect failed: ${connectError}` : "timeout";
      settleProbe({
        ok: false,
        error,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
    });

    void startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: initialProbeTimeoutMs,
      signal: startAbort.signal,
    })
      .then((readiness) => {
        if (settled || readiness.ready || readiness.aborted) {
          return;
        }
        settleProbe({
          ok: false,
          error: "timeout",
          health: null,
          status: null,
          presence: null,
          configSnapshot: null,
        });
      })
      .catch((err: unknown) => {
        if (settled) {
          return;
        }
        connectError = formatErrorMessage(err);
        settleProbe({
          ok: false,
          error: connectError,
          health: null,
          status: null,
          presence: null,
          configSnapshot: null,
        });
      });
  });
}

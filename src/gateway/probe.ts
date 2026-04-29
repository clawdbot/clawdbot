import { randomUUID } from "node:crypto";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { MAX_SAFE_TIMEOUT_DELAY_MS, resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { GatewayClient, GatewayClientRequestError } from "./client.js";
import { READ_SCOPE } from "./method-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "./protocol/client-info.js";

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
  connId: string | null;
};

export type GatewayProbeResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  connectErrorDetails?: unknown;
  close: GatewayProbeClose | null;
  auth: GatewayProbeAuthSummary;
  server?: GatewayProbeServerSummary;
  health: unknown;
  status: unknown;
  presence: SystemPresence[] | null;
  configSnapshot: unknown;
};

export const MIN_PROBE_TIMEOUT_MS = 250;
export const MAX_TIMER_DELAY_MS = MAX_SAFE_TIMEOUT_DELAY_MS;
const PAIRING_REQUIRED_PATTERN = /\bpairing required\b/i;
const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";
const OPERATOR_ADMIN_SCOPE = "operator.admin";

export function clampProbeTimeoutMs(timeoutMs: number): number {
  return resolveSafeTimeoutDelayMs(timeoutMs, { minMs: MIN_PROBE_TIMEOUT_MS });
}

function formatProbeCloseError(close: GatewayProbeClose): string {
  return `gateway closed (${close.code}): ${close.reason}`;
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

function resolveProbeAuthSummary(params: {
  role?: string | null;
  scopes?: string[];
  authMetadataPresent?: boolean;
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
      error: params.error,
      close: params.close,
      verifiedRead: params.verifiedRead,
      connectLatencyMs: params.connectLatencyMs,
    }),
  };
}

export function isPairingPendingProbeFailure(params: {
  error?: string | null;
  close?: GatewayProbeClose | null;
}): boolean {
  return PAIRING_REQUIRED_PATTERN.test(params.close?.reason ?? params.error ?? "");
}

export function resolveGatewayProbeCapability(params: {
  auth?: Pick<GatewayProbeAuthSummary, "scopes"> | null;
  authMetadataPresent?: boolean;
  error?: string | null;
  close?: GatewayProbeClose | null;
  verifiedRead?: boolean;
  connectLatencyMs?: number | null;
}): GatewayProbeCapability {
  if (isPairingPendingProbeFailure(params)) {
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
  auth?: GatewayProbeAuth;
  timeoutMs: number;
  preauthHandshakeTimeoutMs?: number;
  includeDetails?: boolean;
  detailLevel?: "none" | "presence" | "full";
  tlsFingerprint?: string;
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

  const deviceIdentity = await (async () => {
    try {
      if (!URL.canParse(opts.url)) {
        return null;
      }
      const { loadDeviceIdentityIfPresent } = await import("../infra/device-identity.js");
      const identity = loadDeviceIdentityIfPresent();
      if (!identity) {
        return null;
      }
      // Keep probes non-mutating: only attach a device identity when this CLI
      // already has a cached operator device token. Fresh diagnostics should not
      // create a read-only pairing baseline that later blocks admin commands.
      const cachedOperatorToken = loadDeviceAuthToken({
        deviceId: identity.deviceId,
        role: "operator",
      });
      return cachedOperatorToken ? identity : null;
    } catch {
      // Read-only or restricted environments should still be able to run
      // token/password-auth detail probes without mutating identity state.
      return null;
    }
  })();

  return await new Promise<GatewayProbeResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearProbeTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const armProbeTimer = (onTimeout: () => void) => {
      clearProbeTimer();
      timer = setTimeout(onTimeout, clampProbeTimeoutMs(opts.timeoutMs));
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
      clearProbeTimer();
      client.stop();
      const { connectErrorDetails: resultConnectErrorDetails, ...rest } = result;
      resolve({
        url: opts.url,
        ...rest,
        ...(resultConnectErrorDetails != null
          ? { connectErrorDetails: resultConnectErrorDetails }
          : {}),
      });
    };
    const settleProbe = (params: {
      ok: boolean;
      error: string | null;
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
        connectErrorDetails,
        close,
        auth: resolveProbeAuthSummary({
          role: auth.role,
          scopes: auth.scopes,
          authMetadataPresent,
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
      token: opts.auth?.token,
      password: opts.auth?.password,
      tlsFingerprint: opts.tlsFingerprint,
      preauthHandshakeTimeoutMs: opts.preauthHandshakeTimeoutMs,
      scopes: [READ_SCOPE],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.PROBE,
      instanceId,
      deviceIdentity,
      onConnectError: (err) => {
        connectError = formatErrorMessage(err);
        connectErrorDetails = err instanceof GatewayClientRequestError ? err.details : null;
      },
      onClose: (code, reason) => {
        close = { code, reason };
        if (connectLatencyMs == null) {
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
      onHelloOk: async (hello) => {
        connectLatencyMs = Date.now() - startedAt;
        authMetadataPresent = typeof hello?.auth === "object" && hello.auth !== null;
        server = {
          version: typeof hello?.server?.version === "string" ? hello.server.version : null,
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
          settleProbe({
            ok: false,
            error,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        }
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

    client.start();
  });
}

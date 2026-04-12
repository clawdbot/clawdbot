import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import type { SystemPresence } from "../infra/system-presence.js";
import { GatewayClient } from "./client.js";
import { READ_SCOPE } from "./method-scopes.js";
import { isLoopbackHost } from "./net.js";
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

export type GatewayProbeResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: GatewayProbeClose | null;
  health: unknown;
  status: unknown;
  presence: SystemPresence[] | null;
  configSnapshot: unknown;
};

export const MIN_PROBE_TIMEOUT_MS = 250;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function clampProbeTimeoutMs(timeoutMs: number): number {
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_PROBE_TIMEOUT_MS, timeoutMs));
}

function formatProbeCloseError(close: GatewayProbeClose): string {
  return `gateway closed (${close.code}): ${close.reason}`;
}

export async function probeGateway(opts: {
  url: string;
  auth?: GatewayProbeAuth;
  timeoutMs: number;
  includeDetails?: boolean;
  detailLevel?: "none" | "presence" | "full";
  tlsFingerprint?: string;
}): Promise<GatewayProbeResult> {
  const startedAt = Date.now();
  const instanceId = randomUUID();
  let connectLatencyMs: number | null = null;
  let connectError: string | null = null;
  let close: GatewayProbeClose | null = null;

  const detailLevel = opts.includeDetails === false ? "none" : (opts.detailLevel ?? "full");

  const deviceIdentity = await (async () => {
    let hostname: string;
    try {
      hostname = new URL(opts.url).hostname;
    } catch {
      return null;
    }
    // Local authenticated probes should stay device-bound so read/detail RPCs
    // are not scope-limited by the shared-auth scope stripping hardening.
    if (isLoopbackHost(hostname) && !(opts.auth?.token || opts.auth?.password)) {
      return null;
    }
    try {
      const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
      return loadOrCreateDeviceIdentity();
    } catch {
      // Read-only or restricted environments should still be able to run
      // token/password-auth detail probes without crashing on identity persistence.
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
    const settle = (result: Omit<GatewayProbeResult, "url">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearProbeTimer();
      client.stop();
      resolve({ url: opts.url, ...result });
    };

    const client = new GatewayClient({
      url: opts.url,
      token: opts.auth?.token,
      password: opts.auth?.password,
      tlsFingerprint: opts.tlsFingerprint,
      scopes: [READ_SCOPE],
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientVersion: "dev",
      mode: GATEWAY_CLIENT_MODES.PROBE,
      instanceId,
      deviceIdentity,
      onConnectError: (err) => {
        connectError = formatErrorMessage(err);
      },
      onClose: (code, reason) => {
        close = { code, reason };
        if (connectLatencyMs == null) {
          settle({
            ok: false,
            connectLatencyMs,
            error: formatProbeCloseError(close),
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        }
      },
      onHelloOk: async () => {
        connectLatencyMs = Date.now() - startedAt;
        if (detailLevel === "none") {
          settle({
            ok: true,
            connectLatencyMs,
            error: null,
            close,
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
          settle({
            ok: false,
            connectLatencyMs,
            error: "timeout",
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        });
        try {
          if (detailLevel === "presence") {
            const presence = await client.request("system-presence");
            settle({
              ok: true,
              connectLatencyMs,
              error: null,
              close,
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
          settle({
            ok: true,
            connectLatencyMs,
            error: null,
            close,
            health,
            status,
            presence: Array.isArray(presence) ? (presence as SystemPresence[]) : null,
            configSnapshot,
          });
        } catch (err) {
          settle({
            ok: false,
            connectLatencyMs,
            error: formatErrorMessage(err),
            close,
            health: null,
            status: null,
            presence: null,
            configSnapshot: null,
          });
        }
      },
    });

    armProbeTimer(() => {
      settle({
        ok: false,
        connectLatencyMs,
        error: connectError ? `connect failed: ${connectError}` : "timeout",
        close,
        health: null,
        status: null,
        presence: null,
        configSnapshot: null,
      });
    });

    client.start();
  });
}

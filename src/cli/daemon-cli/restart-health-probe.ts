import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { PluginHealthErrorSummary } from "../../commands/health.types.js";
import { createConfigIO } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../../gateway/probe-auth.js";
import { probeGateway } from "../../gateway/probe.js";
import { inspectPortUsage, type PortUsage } from "../../infra/ports.js";
import type { GatewayPortHealthSnapshot } from "./restart-health.types.js";
import { allListenersOwnedByRuntimePid } from "./restart-port-ownership.js";

export type GatewayRestartProbeAuth = {
  token?: string;
  password?: string;
};

export type GatewayReachability = {
  reachable: boolean;
  gatewayVersion: string | null;
  activatedPluginErrors: PluginHealthErrorSummary[];
  channelProbeErrors: Array<{ id: string; error: string }>;
};

function looksLikeAuthClose(code: number | undefined, reason: string | undefined): boolean {
  if (code !== 1008) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  if (!normalized) {
    return false;
  }
  // The restart probe runs against loopback only and only decides restart
  // liveness, not authorization. Keep this allowlist exact so a local listener
  // cannot satisfy the health check with broad device/auth-looking text.
  return (
    normalized === "auth required" ||
    normalized === "owner auth required" ||
    normalized === "connect failed" ||
    normalized === "device required" ||
    normalized === "pairing required" ||
    normalized.startsWith("pairing required:") ||
    normalized.startsWith("unauthorized: gateway token missing") ||
    normalized.startsWith("unauthorized: gateway token mismatch") ||
    normalized.startsWith("unauthorized: gateway token not configured") ||
    normalized.startsWith("unauthorized: gateway password missing") ||
    normalized.startsWith("unauthorized: gateway password mismatch") ||
    normalized.startsWith("unauthorized: gateway password not configured") ||
    normalized.startsWith("unauthorized: bootstrap token invalid or expired") ||
    normalized.startsWith("unauthorized: tailscale identity missing") ||
    normalized.startsWith("unauthorized: tailscale proxy headers missing") ||
    normalized.startsWith("unauthorized: tailscale identity check failed") ||
    normalized.startsWith("unauthorized: tailscale identity mismatch") ||
    normalized.startsWith("unauthorized: too many failed authentication attempts") ||
    normalized.startsWith("unauthorized: device token mismatch") ||
    normalized.startsWith("unauthorized: device token rejected")
  );
}

function readActivatedPluginErrors(health: unknown): PluginHealthErrorSummary[] {
  if (!health || typeof health !== "object") {
    return [];
  }
  const plugins = (health as { plugins?: unknown }).plugins;
  if (!plugins || typeof plugins !== "object") {
    return [];
  }
  const errors = (plugins as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors
    .filter((entry): entry is PluginHealthErrorSummary => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const candidate = entry as Partial<PluginHealthErrorSummary>;
      return (
        candidate.activated === true &&
        typeof candidate.id === "string" &&
        typeof candidate.error === "string"
      );
    })
    .map((entry) => {
      const error: PluginHealthErrorSummary = {
        id: entry.id,
        origin: typeof entry.origin === "string" ? entry.origin : "unknown",
        activated: true,
        error: entry.error,
      };
      if (typeof entry.activationSource === "string") {
        error.activationSource = entry.activationSource;
      }
      if (typeof entry.activationReason === "string") {
        error.activationReason = entry.activationReason;
      }
      if (typeof entry.failurePhase === "string") {
        error.failurePhase = entry.failurePhase;
      }
      return error;
    });
}

function readChannelProbeErrors(health: unknown): Array<{ id: string; error: string }> {
  if (!health || typeof health !== "object") {
    return [];
  }
  const channels = (health as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  const errors: Array<{ id: string; error: string }> = [];
  for (const [id, summary] of Object.entries(channels)) {
    if (!summary || typeof summary !== "object") {
      continue;
    }
    const probe = (summary as { probe?: unknown }).probe;
    if (!probe || typeof probe !== "object") {
      continue;
    }
    const ok = (probe as { ok?: unknown }).ok;
    if (ok !== false) {
      continue;
    }
    const error = (probe as { error?: unknown }).error;
    errors.push({
      id,
      error: typeof error === "string" && error.trim() ? error : "probe failed",
    });
  }
  return errors;
}

export async function confirmGatewayReachable(params: {
  port: number;
  includeHealthDetails?: boolean;
  auth?: GatewayRestartProbeAuth;
  env?: NodeJS.ProcessEnv;
  allowDeviceIdentityRequired?: boolean;
}): Promise<GatewayReachability> {
  const token = normalizeOptionalString(params.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN);
  const password = normalizeOptionalString(
    params.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD,
  );
  const probe = await probeGateway({
    url: `ws://127.0.0.1:${params.port}`,
    auth: token || password ? { token, password } : undefined,
    timeoutMs: 3_000,
    includeDetails: params.includeHealthDetails === true,
    env: params.env,
  });
  const reachedGateway =
    probe.ok ||
    looksLikeAuthClose(probe.close?.code, probe.close?.reason) ||
    (params.allowDeviceIdentityRequired === true &&
      probe.close?.code === 1008 &&
      normalizeLowercaseStringOrEmpty(probe.close.reason) === "device identity required") ||
    (probe.connectLatencyMs != null &&
      probe.server?.version != null &&
      probe.auth.capability === "connected_no_operator_scope");
  return {
    reachable: reachedGateway,
    gatewayVersion: probe.server?.version ?? null,
    activatedPluginErrors: readActivatedPluginErrors(probe.health),
    channelProbeErrors: readChannelProbeErrors(probe.health),
  };
}

export async function resolveGatewayRestartProbeAuth(
  env: NodeJS.ProcessEnv | undefined,
): Promise<GatewayRestartProbeAuth | undefined> {
  const mergedEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...(env ?? undefined),
  } as NodeJS.ProcessEnv;
  const cfg = await createConfigIO({
    env: mergedEnv,
    pluginValidation: "skip",
    suppressFutureVersionWarning: true,
  })
    .readBestEffortConfig()
    .catch((): OpenClawConfig => ({}));
  const resolved = await resolveGatewayProbeAuthSafeWithSecretInputs({
    cfg,
    mode: "local",
    env: mergedEnv,
  });
  return resolved.auth;
}

export async function inspectGatewayPortHealth(params: {
  port: number;
  auth?: GatewayRestartProbeAuth;
  expectedListenerPid?: number;
}): Promise<GatewayPortHealthSnapshot> {
  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port);
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  let healthy = false;
  if (portUsage.status === "busy") {
    const expectedListenerPid = params.expectedListenerPid;
    const listenerOwnershipVerified =
      expectedListenerPid !== undefined &&
      allListenersOwnedByRuntimePid(portUsage.listeners, expectedListenerPid);
    try {
      healthy = (
        await confirmGatewayReachable({
          port: params.port,
          auth: params.auth,
          env: process.env,
          allowDeviceIdentityRequired: listenerOwnershipVerified,
        })
      ).reachable;
    } catch {
      // best-effort probe
    }
  }

  return { portUsage, healthy };
}

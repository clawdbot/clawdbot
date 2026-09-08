import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { classifyGatewayConnectFailure } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { createConfigIO } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { isGatewayProtocolResponseError } from "../../gateway/client.js";
import type { PluginHealthErrorSummary } from "../../gateway/health/types.js";
import {
  createConfiguredGatewayLocalProbe,
  type ConfiguredGatewayLocalProbe,
} from "../../gateway/local-http-probe.js";
import { READ_SCOPE } from "../../gateway/method-scopes.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../../gateway/probe-auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { inspectPortUsage } from "../../infra/ports-inspect.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../../infra/ports-probe.js";
import type { PortUsage } from "../../infra/ports-types.js";
import { sleep } from "../../utils.js";
import type { GatewayPortHealthSnapshot } from "./restart-health.types.js";
import { allListenersOwnedByRuntimePid } from "./restart-port-ownership.js";

export type GatewayRestartProbeAuth = {
  token?: string;
  password?: string;
};

export type GatewayReachability = {
  reachable: boolean;
  gatewayVersion: string | null;
  gatewayBuildId: string | null | undefined;
  activatedPluginErrors: PluginHealthErrorSummary[];
  channelProbeErrors: Array<{ id: string; error: string }>;
  probeError?: string;
};

export type GatewayHttpReadiness = {
  healthz: number | null;
  readyz: number | null;
};

/** Waits for the unauthenticated HTTP(S) readiness contracts reported by service start. */
export async function waitForGatewayHttpReadiness(params: {
  attempts: number;
  config?: OpenClawConfig;
  deadlineAt: number;
  delayMs: number;
  port: number;
  signal?: AbortSignal;
}): Promise<GatewayHttpReadiness> {
  params.signal?.throwIfAborted();
  const probe = createConfiguredGatewayLocalProbe(params.config ?? {});
  let latest: GatewayHttpReadiness = { healthz: null, readyz: null };
  for (let attempt = 0; attempt < params.attempts; attempt += 1) {
    params.signal?.throwIfAborted();
    const remainingMs = params.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return latest;
    }
    const [healthz, readyz] = await Promise.all([
      probe
        .requestHttp({
          host: "127.0.0.1",
          pathname: "/healthz",
          port: params.port,
          timeoutMs: Math.min(remainingMs, 3_000),
          ...(params.signal ? { signal: params.signal } : {}),
        })
        .then((result) => result?.statusCode ?? null),
      probe
        .requestHttp({
          host: "127.0.0.1",
          pathname: "/readyz",
          port: params.port,
          timeoutMs: Math.min(remainingMs, 3_000),
          ...(params.signal ? { signal: params.signal } : {}),
        })
        .then((result) => result?.statusCode ?? null),
    ]);
    params.signal?.throwIfAborted();
    latest = { healthz, readyz };
    if (healthz === 200 && readyz === 200) {
      return latest;
    }
    if (attempt + 1 < params.attempts) {
      const remainingDelayMs = params.deadlineAt - Date.now();
      if (remainingDelayMs <= 0) {
        return latest;
      }
      await sleep(Math.min(params.delayMs, remainingDelayMs), params.signal);
    }
  }
  return latest;
}

function formatGatewayRestartProbeError(error: unknown): string {
  return truncateUtf16Safe(
    sanitizeTerminalText(redactSensitiveUrlLikeString(formatErrorMessage(error))),
    1_024,
  );
}

function isGatewayAuthRejection(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  const pairingFailure = classifyGatewayConnectFailure({ reason: normalized });
  if (
    pairingFailure.kind === "pairing-required" &&
    (normalized === "pairing required" || normalized.startsWith("pairing required:"))
  ) {
    return true;
  }
  // The restart probe runs against loopback only and only decides restart
  // liveness, not authorization. Keep this allowlist exact so a local listener
  // cannot satisfy the health check with broad device/auth-looking text.
  return (
    normalized === "auth required" ||
    normalized === "owner auth required" ||
    normalized === "connect failed" ||
    normalized === "device required" ||
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
  auth?: GatewayRestartProbeAuth;
  config?: OpenClawConfig;
  configuredProbe?: ConfiguredGatewayLocalProbe;
  env?: NodeJS.ProcessEnv;
  allowDeviceIdentityRequired?: boolean;
  signal?: AbortSignal;
}): Promise<GatewayReachability> {
  params.signal?.throwIfAborted();
  const result: GatewayReachability = {
    reachable: false,
    gatewayVersion: null,
    gatewayBuildId: undefined,
    activatedPluginErrors: [],
    channelProbeErrors: [],
  };
  try {
    const context = params.config
      ? { config: params.config, auth: params.auth }
      : await resolveGatewayRestartProbeContext(params.env);
    const auth = params.auth ?? context.auth;
    const configuredProbe =
      params.configuredProbe ?? createConfiguredGatewayLocalProbe(context.config);
    const target = await configuredProbe.resolveWebSocketTarget(params.port);
    if (!target) {
      return { ...result, gatewayBuildId: null, probeError: "gateway TLS certificate unavailable" };
    }
    const authNone = context.config.gateway?.auth?.mode === "none";
    // Readiness is first-party local control. CLI shared auth preserves read scopes;
    // auth-none uses the existing loopback backend contract without pairing a device.
    params.signal?.throwIfAborted();
    const health = await callGateway({
      config: context.config,
      localPortOverride: params.port,
      token: auth?.token,
      password: auth?.password,
      skipImplicitAuth: true,
      tlsFingerprint: target.tlsFingerprint,
      method: "health",
      scopes: [READ_SCOPE],
      clientName: authNone ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
      mode: authNone ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
      requireLocalBackendSharedAuth: authNone,
      deviceIdentity: null,
      sharedStateMode: "read-only",
      timeoutMs: 3_000,
      ...(params.signal ? { signal: params.signal } : {}),
      onHelloOk: (hello) => {
        result.gatewayVersion = hello.server.version;
        result.gatewayBuildId = hello.server.buildId ?? null;
      },
    });
    result.reachable = true;
    result.activatedPluginErrors = readActivatedPluginErrors(health);
    result.channelProbeErrors = readChannelProbeErrors(health);
  } catch (error) {
    params.signal?.throwIfAborted();
    // Only a correlated Gateway rejection proves protocol reachability. Bare socket
    // closes (including foreign listeners) must never satisfy restart health.
    result.reachable =
      result.gatewayVersion === null &&
      isGatewayProtocolResponseError(error) &&
      (isGatewayAuthRejection(error.message) ||
        (params.allowDeviceIdentityRequired === true &&
          error.message === "device identity required"));
    if (result.reachable) {
      result.gatewayBuildId ??= null;
    } else {
      result.probeError = formatGatewayRestartProbeError(error);
    }
  }
  params.signal?.throwIfAborted();
  return result;
}

export type GatewayRestartProbeContext = {
  auth: GatewayRestartProbeAuth | undefined;
  config: OpenClawConfig;
};

export async function resolveGatewayRestartProbeContext(
  env: NodeJS.ProcessEnv | undefined,
): Promise<GatewayRestartProbeContext> {
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  const cfg = await createConfigIO({
    env: mergedEnv,
    observe: false,
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
  return { auth: resolved.auth, config: cfg };
}

export async function inspectGatewayPortHealth(params: {
  port: number;
  auth?: GatewayRestartProbeAuth;
  config?: OpenClawConfig;
  configuredProbe?: ConfiguredGatewayLocalProbe;
  expectedListenerPid?: number;
}): Promise<GatewayPortHealthSnapshot> {
  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(params.port, {
      probeHosts: LOOPBACK_PORT_PROBE_HOSTS,
    });
  } catch (err) {
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  if (portUsage.status !== "busy") {
    return { portUsage, healthy: false };
  }
  const expectedListenerPid = params.expectedListenerPid;
  const listenerOwnershipVerified =
    expectedListenerPid !== undefined &&
    allListenersOwnedByRuntimePid(portUsage.listeners, expectedListenerPid);
  const { reachable, probeError } = await confirmGatewayReachable({
    port: params.port,
    auth: params.auth,
    ...(params.config ? { config: params.config } : {}),
    ...(params.configuredProbe ? { configuredProbe: params.configuredProbe } : {}),
    env: process.env,
    allowDeviceIdentityRequired: listenerOwnershipVerified,
  });
  return { portUsage, healthy: reachable, ...(probeError ? { probeError } : {}) };
}

import type { PluginHealthErrorSummary } from "../../commands/health.types.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { probeGateway } from "../../gateway/probe.js";
import {
  classifyPortListener,
  formatPortDiagnostics,
  inspectPortUsage,
  type PortUsage,
} from "../../infra/ports.js";
import { killProcessTree } from "../../process/kill-tree.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { sleep } from "../../utils.js";

export const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60_000;
export const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
export const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(
  DEFAULT_RESTART_HEALTH_TIMEOUT_MS / DEFAULT_RESTART_HEALTH_DELAY_MS,
);
const STOPPED_FREE_EARLY_EXIT_GRACE_MS = 10_000;
const WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS = 90_000;

export type GatewayRestartWaitOutcome =
  | "healthy"
  | "plugin-errors"
  | "channel-errors"
  | "version-mismatch"
  | "stale-pids"
  | "stopped-free"
  | "timeout";

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  staleGatewayPids: number[];
  gatewayVersion?: string | null;
  activatedPluginErrors?: PluginHealthErrorSummary[];
  channelProbeErrors?: Array<{ id: string; error: string }>;
  expectedVersion?: string;
  versionMismatch?: {
    expected: string;
    actual: string | null;
  };
  waitOutcome?: GatewayRestartWaitOutcome;
  elapsedMs?: number;
};

export type GatewayPortHealthSnapshot = {
  portUsage: PortUsage;
  healthy: boolean;
};

type GatewayReachability = {
  reachable: boolean;
  gatewayVersion: string | null;
  activatedPluginErrors: PluginHealthErrorSummary[];
  channelProbeErrors: Array<{ id: string; error: string }>;
};

function hasListenerAttributionGap(portUsage: PortUsage): boolean {
  if (portUsage.status !== "busy" || portUsage.listeners.length > 0) {
    return false;
  }
  if (portUsage.errors?.length) {
    return true;
  }
  return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}

function listenerOwnedByRuntimePid(params: {
  listener: PortUsage["listeners"][number];
  runtimePid: number;
}): boolean {
  return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}

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

function applyExpectedVersion(
  snapshot: GatewayRestartSnapshot,
  expectedVersion: string | undefined,
): GatewayRestartSnapshot {
  if (!expectedVersion) {
    return snapshot;
  }
  if (snapshot.gatewayVersion === expectedVersion) {
    return { ...snapshot, expectedVersion };
  }
  if (snapshot.gatewayVersion == null) {
    return { ...snapshot, healthy: false, expectedVersion };
  }
  return {
    ...snapshot,
    healthy: false,
    expectedVersion,
    versionMismatch: {
      expected: expectedVersion,
      actual: snapshot.gatewayVersion ?? null,
    },
  };
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

function applyActivatedPluginErrors(snapshot: GatewayRestartSnapshot): GatewayRestartSnapshot {
  if (!snapshot.activatedPluginErrors?.length) {
    return snapshot;
  }
  return { ...snapshot, healthy: false };
}

function applyChannelProbeErrors(snapshot: GatewayRestartSnapshot): GatewayRestartSnapshot {
  if (!snapshot.channelProbeErrors?.length) {
    return snapshot;
  }
  return { ...snapshot, healthy: false };
}

async function confirmGatewayReachable(params: {
  port: number;
  includeHealthDetails?: boolean;
}): Promise<GatewayReachability> {
  const token = normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN);
  const password = normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD);
  const probe = await probeGateway({
    url: `ws://127.0.0.1:${params.port}`,
    auth: token || password ? { token, password } : undefined,
    timeoutMs: 3_000,
    includeDetails: params.includeHealthDetails === true,
  });
  const reachedGateway =
    probe.ok ||
    looksLikeAuthClose(probe.close?.code, probe.close?.reason) ||
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

async function inspectGatewayPortHealth(port: number): Promise<GatewayPortHealthSnapshot> {
  let portUsage: PortUsage;
  try {
    portUsage = await inspectPortUsage(port);
  } catch (err) {
    portUsage = {
      port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  let healthy = false;
  if (portUsage.status === "busy") {
    try {
      healthy = (await confirmGatewayReachable({ port })).reachable;
    } catch {
      // best-effort probe
    }
  }

  return { portUsage, healthy };
}

export async function inspectGatewayRestart(params: {
  service: GatewayService;
  port: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const env = params.env ?? process.env;
  const expectedVersion = normalizeOptionalString(params.expectedVersion);
  let reachability: GatewayReachability | null = null;
  let activatedPluginErrors: PluginHealthErrorSummary[] = [];
  let channelProbeErrors: Array<{ id: string; error: string }> = [];
  const loadReachability = async () => {
    if (!reachability) {
      reachability = await confirmGatewayReachable({
        port: params.port,
        includeHealthDetails: Boolean(expectedVersion),
      });
      activatedPluginErrors = reachability.activatedPluginErrors;
      channelProbeErrors = reachability.channelProbeErrors;
    }
    return reachability;
  };
  let runtime: GatewayServiceRuntime = { status: "unknown" };
  try {
    runtime = await params.service.readRuntime(env);
  } catch (err) {
    runtime = { status: "unknown", detail: String(err) };
  }

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

  if (portUsage.status === "busy" && runtime.status !== "running") {
    try {
      const reachable = await loadReachability();
      if (reachable.reachable) {
        return applyChannelProbeErrors(
          applyActivatedPluginErrors(
            applyExpectedVersion(
              {
                runtime,
                portUsage,
                healthy: true,
                staleGatewayPids: [],
                gatewayVersion: reachable.gatewayVersion,
                ...(reachable.activatedPluginErrors.length > 0
                  ? { activatedPluginErrors: reachable.activatedPluginErrors }
                  : {}),
                ...(reachable.channelProbeErrors.length > 0
                  ? { channelProbeErrors: reachable.channelProbeErrors }
                  : {}),
              },
              expectedVersion,
            ),
          ),
        );
      }
    } catch {
      // Probe is best-effort; keep the ownership-based diagnostics.
    }
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const fallbackListenerPids =
    params.includeUnknownListenersAsStale &&
    process.platform === "win32" &&
    runtime.status !== "running" &&
    portUsage.status === "busy"
      ? portUsage.listeners
          .filter((listener) => classifyPortListener(listener, params.port) === "unknown")
          .map((listener) => listener.pid)
          .filter((pid): pid is number => Number.isFinite(pid))
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const listenerAttributionGap = hasListenerAttributionGap(portUsage);
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) =>
          listenerOwnedByRuntimePid({ listener, runtimePid }),
        ) || listenerAttributionGap
      : gatewayListeners.length > 0 || listenerAttributionGap;
  let healthy = running && ownsPort;
  let gatewayVersion: string | null | undefined;
  if (expectedVersion && healthy && portUsage.status === "busy") {
    try {
      const reachable = await loadReachability();
      healthy = reachable.reachable;
      gatewayVersion = reachable.gatewayVersion;
      if (reachable.activatedPluginErrors.length > 0) {
        healthy = false;
      }
      if (reachable.channelProbeErrors.length > 0) {
        healthy = false;
      }
    } catch {
      healthy = false;
    }
  }
  if (!healthy && running && portUsage.status === "busy" && !expectedVersion) {
    try {
      const reachable = await loadReachability();
      healthy = reachable.reachable;
      gatewayVersion = reachable.gatewayVersion;
    } catch {
      // best-effort probe
    }
  }
  const staleGatewayPids = Array.from(
    new Set([
      ...gatewayListeners
        .filter((listener) => Number.isFinite(listener.pid))
        .filter((listener) => {
          if (!running) {
            return true;
          }
          if (runtimePid == null) {
            return false;
          }
          return !listenerOwnedByRuntimePid({ listener, runtimePid });
        })
        .map((listener) => listener.pid as number),
      ...fallbackListenerPids.filter(
        (pid) => runtime.pid == null || pid !== runtime.pid || !running,
      ),
    ]),
  );

  return applyChannelProbeErrors(
    applyActivatedPluginErrors(
      applyExpectedVersion(
        {
          runtime,
          portUsage,
          healthy,
          staleGatewayPids,
          ...(gatewayVersion !== undefined ? { gatewayVersion } : {}),
          ...(activatedPluginErrors.length ? { activatedPluginErrors } : {}),
          ...(channelProbeErrors.length ? { channelProbeErrors } : {}),
        },
        expectedVersion,
      ),
    ),
  );
}

function shouldEarlyExitStoppedFree(
  snapshot: GatewayRestartSnapshot,
  attempt: number,
  minAttempt: number,
): boolean {
  return (
    attempt >= minAttempt &&
    snapshot.runtime.status === "stopped" &&
    snapshot.portUsage.status === "free"
  );
}

function stoppedFreeEarlyExitGraceMs(): number {
  return process.platform === "win32"
    ? WINDOWS_STOPPED_FREE_EARLY_EXIT_GRACE_MS
    : STOPPED_FREE_EARLY_EXIT_GRACE_MS;
}

function withWaitContext(
  snapshot: GatewayRestartSnapshot,
  waitOutcome: GatewayRestartWaitOutcome,
  elapsedMs: number,
): GatewayRestartSnapshot {
  return { ...snapshot, waitOutcome, elapsedMs };
}

export async function waitForGatewayHealthyRestart(params: {
  service: GatewayService;
  port: number;
  attempts?: number;
  delayMs?: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayRestart({
    service: params.service,
    port: params.port,
    env: params.env,
    expectedVersion: params.expectedVersion,
    includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
  });

  let consecutiveStoppedFreeCount = 0;
  const STOPPED_FREE_THRESHOLD = 6;
  const minAttemptForEarlyExit = Math.min(
    Math.ceil(stoppedFreeEarlyExitGraceMs() / delayMs),
    Math.floor(attempts / 2),
  );

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot.healthy) {
      return withWaitContext(snapshot, "healthy", attempt * delayMs);
    }
    if (snapshot.activatedPluginErrors?.length) {
      return withWaitContext(snapshot, "plugin-errors", attempt * delayMs);
    }
    if (snapshot.channelProbeErrors?.length) {
      return withWaitContext(snapshot, "channel-errors", attempt * delayMs);
    }
    if (snapshot.versionMismatch) {
      return withWaitContext(snapshot, "version-mismatch", attempt * delayMs);
    }
    if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") {
      return withWaitContext(snapshot, "stale-pids", attempt * delayMs);
    }
    if (shouldEarlyExitStoppedFree(snapshot, attempt, minAttemptForEarlyExit)) {
      consecutiveStoppedFreeCount += 1;
      if (consecutiveStoppedFreeCount >= STOPPED_FREE_THRESHOLD) {
        return withWaitContext(snapshot, "stopped-free", attempt * delayMs);
      }
    } else if (snapshot.runtime.status !== "stopped" || snapshot.portUsage.status !== "free") {
      consecutiveStoppedFreeCount = 0;
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayRestart({
      service: params.service,
      port: params.port,
      env: params.env,
      expectedVersion: params.expectedVersion,
      includeUnknownListenersAsStale: params.includeUnknownListenersAsStale,
    });
  }

  return withWaitContext(snapshot, "timeout", attempts * delayMs);
}

export async function waitForGatewayHealthyListener(params: {
  port: number;
  attempts?: number;
  delayMs?: number;
}): Promise<GatewayPortHealthSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayPortHealth(params.port);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot.healthy) {
      return snapshot;
    }
    await sleep(delayMs);
    snapshot = await inspectGatewayPortHealth(params.port);
  }

  return snapshot;
}

function renderPortUsageDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  const lines: string[] = [];

  if (snapshot.portUsage.status === "busy") {
    lines.push(...formatPortDiagnostics(snapshot.portUsage));
  } else {
    lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
  }

  if (snapshot.portUsage.errors?.length) {
    lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
  }

  return lines;
}

export function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.versionMismatch) {
    const actual = snapshot.versionMismatch.actual ?? "unavailable";
    lines.push(
      `Gateway version mismatch: expected ${snapshot.versionMismatch.expected}, running gateway reported ${actual}.`,
    );
  }
  if (snapshot.activatedPluginErrors?.length) {
    lines.push("Activated plugin load errors:");
    for (const plugin of snapshot.activatedPluginErrors) {
      lines.push(`- ${plugin.id}: ${plugin.error}`);
    }
  }
  if (snapshot.channelProbeErrors?.length) {
    lines.push("Channel health probe errors:");
    for (const channel of snapshot.channelProbeErrors) {
      lines.push(`- ${channel.id}: ${channel.error}`);
    }
  }
  const runtimeSummary = [
    snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
    snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
    snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
    snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  if (runtimeSummary) {
    lines.push(`Service runtime: ${runtimeSummary}`);
  }

  lines.push(...renderPortUsageDiagnostics(snapshot));

  return lines;
}

export function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  return renderPortUsageDiagnostics(snapshot);
}

export async function terminateStaleGatewayPids(pids: number[]): Promise<number[]> {
  const targets = Array.from(
    new Set(pids.filter((pid): pid is number => Number.isFinite(pid) && pid > 0)),
  );
  for (const pid of targets) {
    killProcessTree(pid, { graceMs: 300 });
  }
  if (targets.length > 0) {
    await sleep(500);
  }
  return targets;
}

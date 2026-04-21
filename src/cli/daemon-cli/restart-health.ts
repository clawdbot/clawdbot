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

export type GatewayRestartWaitOutcome = "healthy" | "stale-pids" | "stopped-free" | "timeout";

export type GatewayRestartSnapshot = {
  runtime: GatewayServiceRuntime;
  portUsage: PortUsage;
  healthy: boolean;
  staleGatewayPids: number[];
  waitOutcome?: GatewayRestartWaitOutcome;
  elapsedMs?: number;
};

export type GatewayPortHealthSnapshot = {
  portUsage: PortUsage;
  healthy: boolean;
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
  return (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("scope") ||
    normalized.includes("role")
  );
}

async function confirmGatewayReachable(port: number): Promise<boolean> {
  const token = normalizeOptionalString(process.env.OPENCLAW_GATEWAY_TOKEN);
  const password = normalizeOptionalString(process.env.OPENCLAW_GATEWAY_PASSWORD);
  const probe = await probeGateway({
    url: `ws://127.0.0.1:${port}`,
    auth: token || password ? { token, password } : undefined,
    timeoutMs: 3_000,
    includeDetails: false,
  });
  return probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason);
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
      healthy = await confirmGatewayReachable(port);
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
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const env = params.env ?? process.env;
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
      const reachable = await confirmGatewayReachable(params.port);
      if (reachable) {
        return {
          runtime,
          portUsage,
          healthy: true,
          staleGatewayPids: [],
        };
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
  if (!healthy && running && portUsage.status === "busy") {
    try {
      healthy = await confirmGatewayReachable(params.port);
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

  return {
    runtime,
    portUsage,
    healthy,
    staleGatewayPids,
  };
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
  includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot> {
  const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
  const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;

  let snapshot = await inspectGatewayRestart({
    service: params.service,
    port: params.port,
    env: params.env,
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

import { formatPortDiagnostics } from "../../infra/ports.js";
import type { GatewayPortHealthSnapshot, GatewayRestartSnapshot } from "./restart-health.types.js";

function renderPortUsageDiagnostics(
  snapshot: Pick<GatewayPortHealthSnapshot, "portUsage">,
): string[] {
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

export function formatRestartFailure(params: {
  health: GatewayRestartSnapshot;
  port: number;
  defaultTimeoutSeconds: number;
}): { statusLine: string; failMessage: string } {
  if (params.health.waitOutcome === "stopped-free") {
    const elapsedSeconds = Math.max(1, Math.round((params.health.elapsedMs ?? 0) / 1000));
    return {
      statusLine: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and port ${params.port} stayed free.`,
      failMessage: `Gateway restart failed after ${elapsedSeconds}s: service stayed stopped and health checks never came up.`,
    };
  }

  const timeoutSeconds = Math.max(
    1,
    Math.round(
      params.health.elapsedMs === undefined
        ? params.defaultTimeoutSeconds
        : params.health.elapsedMs / 1000,
    ),
  );
  return {
    statusLine: `Timed out after ${timeoutSeconds}s waiting for gateway port ${params.port} to become healthy.`,
    failMessage: `Gateway restart timed out after ${timeoutSeconds}s waiting for health checks.`,
  };
}

/**
 * Renders the "still starting" note for in-process (SIGUSR1) gateway restarts:
 * the PID is unchanged and the process is alive while the port is still free,
 * so the restart is progressing rather than failed. Explicitly non-failure
 * language — failure here would push operators toward destructive recovery of
 * a healthy, booting process.
 */
export function resolveStillStartingMessage(
  health: GatewayPortHealthSnapshot,
  pid: number | undefined,
  fallbackTimeoutSeconds: number,
): string | undefined {
  if (health.waitOutcome !== "still-starting" || pid === undefined) {
    return undefined;
  }
  const elapsedSeconds = Math.max(
    1,
    Math.round(health.elapsedMs === undefined ? fallbackTimeoutSeconds : health.elapsedMs / 1000),
  );
  return `Gateway restart is still in progress after ${elapsedSeconds}s: process PID ${pid} is alive and booting (in-process restart keeps the PID). Poll readiness with "openclaw gateway status --deep".`;
}

import { formatPortDiagnostics } from "../../infra/ports.js";
import type { GatewayPortHealthSnapshot, GatewayRestartSnapshot } from "./restart-health.types.js";

function renderPluginDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  const lines: string[] = [];
  if (snapshot.activatedPluginErrors?.length) {
    lines.push("Activated plugin load errors:");
    for (const plugin of snapshot.activatedPluginErrors) {
      lines.push(`- ${plugin.id}: ${plugin.error}`);
    }
  }
  if (snapshot.unavailablePlugins?.length) {
    lines.push("Configured plugins unavailable:");
    for (const plugin of snapshot.unavailablePlugins) {
      lines.push(`- ${plugin.id}: ${plugin.diagnostic.detail}`);
    }
  }
  return lines;
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
  if (snapshot.probeError) {
    lines.push(`Gateway probe failed: ${snapshot.probeError}`);
  }
  lines.push(...renderPluginDiagnostics(snapshot));
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
  if (snapshot.buildIdMismatch) {
    const actual = snapshot.buildIdMismatch.actual ?? "unavailable";
    lines.push(
      `Gateway build mismatch: expected ${snapshot.buildIdMismatch.expected}, running gateway reported ${actual}.`,
    );
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

export function formatGatewayRestartFailure(params: {
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

export function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[] {
  return renderPortUsageDiagnostics(snapshot);
}

import type { RuntimeEnv } from "../../runtime.js";
import { writeRuntimeJson } from "../../runtime.js";
import { colorize, theme } from "../../terminal/theme.js";
import { serializeGatewayDiscoveryBeacon } from "./discovery.js";
import {
  isProbeReachable,
  isPostConnectProbeFailure,
  isScopeLimitedProbeFailure,
  summarizeGatewayProbeCapability,
  renderProbeSummaryLine,
  renderTargetHeader,
} from "./helpers.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";

export type GatewayStatusWarning = {
  code: string;
  message: string;
  targetIds?: string[];
};

const noReachableGatewayDiagnostic =
  "No gateway answered any probe and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.";

function readModelPricingDegradedDetail(health: unknown): string | null {
  if (!health || typeof health !== "object") {
    return null;
  }
  const modelPricing = (health as { modelPricing?: unknown }).modelPricing;
  if (!modelPricing || typeof modelPricing !== "object") {
    return null;
  }
  const record = modelPricing as { state?: unknown; detail?: unknown };
  if (record.state !== "degraded") {
    return null;
  }
  return typeof record.detail === "string" && record.detail.trim()
    ? record.detail.trim()
    : "pricing bootstrap or refresh failed";
}

export function pickPrimaryProbedTarget(probed: GatewayStatusProbedTarget[]) {
  const reachable = probed.filter((entry) => isProbeReachable(entry.probe));
  return (
    reachable.find((entry) => entry.target.kind === "explicit") ??
    reachable.find((entry) => entry.target.kind === "sshTunnel") ??
    reachable.find((entry) => entry.target.kind === "configRemote") ??
    reachable.find((entry) => entry.target.kind === "localLoopback") ??
    null
  );
}

export function buildGatewayStatusWarnings(params: {
  probed: GatewayStatusProbedTarget[];
  sshTarget: string | null;
  sshTunnelStarted: boolean;
  sshTunnelError: string | null;
  localTlsLoadError?: string | null;
  discoveryCount?: number;
}): GatewayStatusWarning[] {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const degradedScopeLimited = params.probed.filter((entry) =>
    isScopeLimitedProbeFailure(entry.probe),
  );
  const degradedDetailFailed = params.probed.filter(
    (entry) => isPostConnectProbeFailure(entry.probe) && !isScopeLimitedProbeFailure(entry.probe),
  );
  const warnings: GatewayStatusWarning[] = [];
  if (params.sshTarget && !params.sshTunnelStarted) {
    warnings.push({
      code: "ssh_tunnel_failed",
      message: params.sshTunnelError
        ? `SSH tunnel failed: ${params.sshTunnelError}`
        : "SSH tunnel failed to start; falling back to direct probes.",
    });
  }
  if (params.localTlsLoadError) {
    warnings.push({
      code: "local_tls_runtime_unavailable",
      message: `Local gateway TLS is enabled but OpenClaw could not load the local certificate fingerprint: ${params.localTlsLoadError}`,
      targetIds: ["localLoopback"],
    });
  }
  if (reachable.length === 0 && params.discoveryCount === 0) {
    warnings.push({
      code: "no_gateway_reachable",
      message: noReachableGatewayDiagnostic,
      targetIds: params.probed.map((entry) => entry.target.id),
    });
  }
  if (reachable.length > 1) {
    warnings.push({
      code: "multiple_gateways",
      message:
        "Unconventional setup: multiple reachable gateways detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
      targetIds: reachable.map((entry) => entry.target.id),
    });
  }
  for (const result of params.probed) {
    if (result.authDiagnostics.length === 0 || isProbeReachable(result.probe)) {
      continue;
    }
    for (const diagnostic of result.authDiagnostics) {
      warnings.push({
        code: "auth_secretref_unresolved",
        message: diagnostic,
        targetIds: [result.target.id],
      });
    }
  }
  for (const result of degradedScopeLimited) {
    warnings.push({
      code: "probe_scope_limited",
      message:
        "Read-probe diagnostics are limited by gateway scopes (missing operator.read). Connection succeeded, but read-only status calls are incomplete. Hint: pair device identity or use credentials with operator.read.",
      targetIds: [result.target.id],
    });
  }
  for (const result of degradedDetailFailed) {
    const detail = result.probe.error ? `: ${result.probe.error}` : ".";
    warnings.push({
      code: "probe_detail_failed",
      message: `Gateway accepted the WebSocket connection, but follow-up read diagnostics failed${detail}`,
      targetIds: [result.target.id],
    });
  }
  for (const result of reachable) {
    const detail = readModelPricingDegradedDetail(result.probe.health);
    if (!detail) {
      continue;
    }
    warnings.push({
      code: "model_pricing_degraded",
      message: `Model pricing degraded: ${detail}`,
      targetIds: [result.target.id],
    });
  }
  return warnings;
}

export function writeGatewayStatusJson(params: {
  runtime: RuntimeEnv;
  startedAt: number;
  overallTimeoutMs: number;
  discoveryTimeoutMs: number;
  network: ReturnType<typeof import("./helpers.js").buildNetworkHints>;
  discovery: Parameters<typeof serializeGatewayDiscoveryBeacon>[0][];
  probed: GatewayStatusProbedTarget[];
  warnings: GatewayStatusWarning[];
  primaryTargetId: string | null;
}) {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const degraded =
    params.probed.some((entry) => isPostConnectProbeFailure(entry.probe)) ||
    reachable.some((entry) => readModelPricingDegradedDetail(entry.probe.health));
  const capability = summarizeGatewayProbeCapability(reachable.map((entry) => entry.probe));
  writeRuntimeJson(params.runtime, {
    ok: reachable.length > 0,
    degraded,
    capability,
    ts: Date.now(),
    durationMs: Date.now() - params.startedAt,
    timeoutMs: params.overallTimeoutMs,
    primaryTargetId: params.primaryTargetId,
    warnings: params.warnings,
    network: params.network,
    discovery: {
      timeoutMs: params.discoveryTimeoutMs,
      count: params.discovery.length,
      beacons: params.discovery.map((beacon) => serializeGatewayDiscoveryBeacon(beacon)),
    },
    targets: params.probed.map((entry) => ({
      id: entry.target.id,
      kind: entry.target.kind,
      url: entry.target.url,
      active: entry.target.active,
      tunnel: entry.target.tunnel ?? null,
      connect: {
        ok: isProbeReachable(entry.probe),
        rpcOk: entry.probe.ok,
        scopeLimited: isScopeLimitedProbeFailure(entry.probe),
        latencyMs: entry.probe.connectLatencyMs,
        error: entry.probe.error,
        close: entry.probe.close,
      },
      auth: entry.probe.auth,
      self: entry.self,
      config: entry.configSummary,
      health: entry.probe.health,
      summary: entry.probe.status,
      presence: entry.probe.presence,
    })),
  });
  if (reachable.length === 0) {
    params.runtime.exit(1);
  }
}

export function writeGatewayStatusText(params: {
  runtime: RuntimeEnv;
  rich: boolean;
  overallTimeoutMs: number;
  wideAreaDomain?: string | null;
  discovery: Parameters<typeof serializeGatewayDiscoveryBeacon>[0][];
  probed: GatewayStatusProbedTarget[];
  warnings: GatewayStatusWarning[];
}) {
  const reachable = params.probed.filter((entry) => isProbeReachable(entry.probe));
  const ok = reachable.length > 0;
  const capability = summarizeGatewayProbeCapability(reachable.map((entry) => entry.probe));
  params.runtime.log(colorize(params.rich, theme.heading, "Gateway Status"));
  params.runtime.log(
    ok
      ? `${colorize(params.rich, theme.success, "Reachable")}: yes`
      : `${colorize(params.rich, theme.error, "Reachable")}: no`,
  );
  params.runtime.log(
    `${colorize(params.rich, theme.info, "Capability")}: ${capability.replaceAll("_", "-")}`,
  );
  params.runtime.log(
    colorize(params.rich, theme.muted, `Probe budget: ${params.overallTimeoutMs}ms`),
  );

  if (params.warnings.length > 0) {
    params.runtime.log("");
    params.runtime.log(colorize(params.rich, theme.warn, "Warning:"));
    for (const warning of params.warnings) {
      params.runtime.log(`- ${warning.message}`);
    }
  }

  params.runtime.log("");
  params.runtime.log(colorize(params.rich, theme.heading, "Discovery (this machine)"));
  const discoveryDomains = params.wideAreaDomain ? `local. + ${params.wideAreaDomain}` : "local.";
  params.runtime.log(
    params.discovery.length > 0
      ? `Found ${params.discovery.length} gateway(s) via Bonjour (${discoveryDomains})`
      : `Found 0 gateways via Bonjour (${discoveryDomains})`,
  );
  if (params.discovery.length === 0) {
    params.runtime.log(
      colorize(
        params.rich,
        theme.muted,
        "Tip: if the gateway is remote, mDNS won’t cross networks; use Wide-Area Bonjour (split DNS) or SSH tunnels.",
      ),
    );
  }

  params.runtime.log("");
  params.runtime.log(colorize(params.rich, theme.heading, "Targets"));
  for (const result of params.probed) {
    params.runtime.log(renderTargetHeader(result.target, params.rich));
    params.runtime.log(`  ${renderProbeSummaryLine(result.probe, params.rich)}`);
    if (result.target.tunnel?.kind === "ssh") {
      params.runtime.log(
        `  ${colorize(params.rich, theme.muted, "ssh")}: ${colorize(params.rich, theme.command, result.target.tunnel.target)}`,
      );
    }
    if (result.probe.ok && result.self) {
      const host = result.self.host ?? "unknown";
      const ip = result.self.ip ? ` (${result.self.ip})` : "";
      const platform = result.self.platform ? ` · ${result.self.platform}` : "";
      const version = result.self.version ? ` · app ${result.self.version}` : "";
      params.runtime.log(
        `  ${colorize(params.rich, theme.info, "Gateway")}: ${host}${ip}${platform}${version}`,
      );
    }
    if (result.configSummary) {
      const wideArea =
        result.configSummary.discovery.wideAreaEnabled === true
          ? "enabled"
          : result.configSummary.discovery.wideAreaEnabled === false
            ? "disabled"
            : "unknown";
      params.runtime.log(
        `  ${colorize(params.rich, theme.info, "Wide-area discovery")}: ${wideArea}`,
      );
    }
    params.runtime.log("");
  }

  if (!ok) {
    params.runtime.exit(1);
  }
}

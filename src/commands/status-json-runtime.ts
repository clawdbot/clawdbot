// Resolves runtime-only inputs for status JSON after the fast scan completes.
// Keeps gateway health, usage, security audit, and service summaries behind explicit option gates.

import { readBackupFreshness } from "./backup-health.js";
import { buildStatusJsonPayload } from "./status-json-payload.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import { resolveStatusRuntimeSnapshot } from "./status-runtime-shared.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

/** Builds the status JSON object from a completed scan plus optional runtime/deep probes. */
export async function resolveStatusJsonOutput(params: {
  scan: StatusScanResult;
  opts: {
    deep?: boolean;
    usage?: boolean;
    agent?: string;
    timeoutMs?: number;
  };
  includeSecurityAudit: boolean;
  includePluginCompatibility?: boolean;
  suppressHealthErrors?: boolean;
}) {
  const { scan, opts } = params;
  const { securityAudit, usage, health, lastHeartbeat, gatewayService, nodeService } =
    await resolveStatusRuntimeSnapshot({
      config: scan.cfg,
      sourceConfig: scan.sourceConfig,
      timeoutMs: opts.timeoutMs,
      ...(opts.agent ? { agentId: opts.agent } : {}),
      usage: opts.usage,
      deep: opts.deep,
      gatewayReachable: scan.gatewayReachable,
      includeSecurityAudit: params.includeSecurityAudit,
      suppressHealthErrors: params.suppressHealthErrors,
    });

  const payload = buildStatusJsonPayload({
    summary: scan.summary,
    surface: buildStatusOverviewSurfaceFromScan({
      scan,
      gatewayService,
      nodeService,
    }),
    osSummary: scan.osSummary,
    memory: scan.memory,
    memoryPlugin: scan.memoryPlugin,
    agents: scan.agentStatus,
    configDiagnostics: scan.configDiagnostics,
    secretDiagnostics: scan.secretDiagnostics,
    securityAudit,
    health,
    usage,
    lastHeartbeat,
    pluginCompatibility: params.includePluginCompatibility ? scan.pluginCompatibility : undefined,
  });
  const backups = readBackupFreshness(scan.env ?? {});
  if (backups.latest || backups.latestOk) {
    Object.assign(payload, { backups });
  }
  return payload;
}

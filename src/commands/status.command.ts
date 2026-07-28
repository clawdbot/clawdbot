// Main `openclaw status` command orchestrator.
// It routes all/json/deep modes, collects scan/runtime state, and delegates formatting to report builders.

import {
  normalizePairingConnectRequestId,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
  type ConnectPairingRequiredReason,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { withProgress } from "../cli/progress.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { readRestartSentinel } from "../infra/restart-sentinel.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { buildStatusOverviewSurfaceFromScan } from "./status-overview-surface.ts";
import {
  loadStatusProviderUsageModule,
  resolveStatusGatewayHealth,
  resolveStatusSecurityAudit,
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import { formatUpdateRestartStatusValue } from "./status-update-restart.ts";
import { buildStatusCommandReportData } from "./status.command-report-data.ts";
import { buildStatusCommandReportLines } from "./status.command-report.ts";
import { logGatewayConnectionDetails } from "./status.gateway-connection.ts";

const statusScanModuleLoader = createLazyImportLoader(() => import("./status.scan.js"));
const statusScanFastJsonModuleLoader = createLazyImportLoader(
  () => import("./status.scan.fast-json.js"),
);
const statusAllModuleLoader = createLazyImportLoader(() => import("./status-all.js"));
const statusCommandTextRuntimeLoader = createLazyImportLoader(
  () => import("./status.command.text-runtime.js"),
);
const statusNodeModeModuleLoader = createLazyImportLoader(() => import("./status.node-mode.js"));

function loadStatusScanModule() {
  return statusScanModuleLoader.load();
}

function loadStatusScanFastJsonModule() {
  return statusScanFastJsonModuleLoader.load();
}

function loadStatusAllModule() {
  return statusAllModuleLoader.load();
}

function loadStatusCommandTextRuntime() {
  return statusCommandTextRuntimeLoader.load();
}

function loadStatusNodeModeModule() {
  return statusNodeModeModuleLoader.load();
}

/** Extracts device-pairing recovery context from structured gateway errors or legacy message text. */
function resolvePairingRecoveryContext(params: {
  error?: string | null;
  closeReason?: string | null;
  details?: unknown;
}): {
  requestId: string | null;
  reason: ConnectPairingRequiredReason | null;
  remediationHint: string | null;
} | null {
  const structured = readPairingConnectErrorDetails(params.details);
  if (structured) {
    return {
      requestId: normalizePairingConnectRequestId(structured.requestId) ?? null,
      reason: structured.reason ?? null,
      remediationHint: structured.remediationHint
        ? sanitizeTerminalText(structured.remediationHint)
        : null,
    };
  }
  // Older gateways only exposed pairing details in close/error text; keep status recovery helpful there.
  const source = [params.error, params.closeReason]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  const pairing = readConnectPairingRequiredMessage(source);
  if (!pairing) {
    return null;
  }
  return {
    requestId: normalizePairingConnectRequestId(pairing.requestId) ?? null,
    reason: pairing.reason ?? null,
    remediationHint: null,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.statusCommandTestApi")] = {
    resolvePairingRecoveryContext,
  };
}

function normalizeStatusWrapperPath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveServiceWrapperContextHint(params: {
  serviceWrapperPath?: string | null;
  cliWrapperPath?: string | null;
}): string | null {
  const serviceWrapperPath = normalizeStatusWrapperPath(params.serviceWrapperPath);
  if (!serviceWrapperPath) {
    return null;
  }
  if (normalizeStatusWrapperPath(params.cliWrapperPath) === serviceWrapperPath) {
    return null;
  }
  return `The installed gateway service uses ${OPENCLAW_WRAPPER_ENV_KEY} (${sanitizeTerminalText(serviceWrapperPath)}), but this CLI process is not running with that same wrapper. Missing-secret diagnostics may describe the current CLI process rather than the installed gateway service context.`;
}

/** Runs `openclaw status`, including JSON/all routing and optional deep probes. */
export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  if (opts.all && !opts.json) {
    // Human `--all` has a dedicated report path; JSON `--all` stays on the JSON schema.
    await loadStatusAllModule().then(({ statusAllCommand }) =>
      statusAllCommand(runtime, { timeoutMs: opts.timeoutMs }),
    );
    return;
  }

  if (opts.json) {
    await runStatusJsonCommand({
      opts,
      runtime,
      includeSecurityAudit: opts.all === true,
      includePluginCompatibility: true,
      suppressHealthErrors: true,
      scanStatusJsonFast: async (scanOpts, runtimeForScan) =>
        await loadStatusScanFastJsonModule().then(({ scanStatusJsonFast }) =>
          scanStatusJsonFast(scanOpts, runtimeForScan),
        ),
    });
    return;
  }

  const scan = await loadStatusScanModule().then(({ scanStatus }) =>
    scanStatus({ json: false, timeoutMs: opts.timeoutMs, all: opts.all, deep: opts.deep }, runtime),
  );

  const {
    cfg,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    advertisedControlUiLinks,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues,
    agentStatus,
    channels,
    summary,
    secretDiagnostics,
    memory,
    memoryPlugin,
    pluginCompatibility,
  } = scan;

  const {
    securityAudit,
    usage,
    health,
    lastHeartbeat,
    gatewayService: daemon,
    nodeService: nodeDaemon,
  } = await resolveStatusRuntimeSnapshot({
    config: scan.cfg,
    sourceConfig: scan.sourceConfig,
    timeoutMs: opts.timeoutMs,
    usage: opts.usage,
    deep: opts.deep,
    gatewayReachable,
    includeSecurityAudit: opts.all === true || opts.deep === true,
    resolveSecurityAudit: async (input) =>
      await withProgress(
        {
          label: "Running security audit…",
          indeterminate: true,
          enabled: true,
        },
        async () => await resolveStatusSecurityAudit(input),
      ),
    resolveUsage: async (input) =>
      await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusUsageSummary(input),
      ),
    resolveHealth: async (input) =>
      await withProgress(
        {
          label: "Checking gateway health…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusGatewayHealth(input),
      ),
  });

  const rich = true;
  const {
    buildStatusUpdateSurface,
    formatCliCommand,
    formatHealthChannelLines,
    formatKTokens,
    formatPromptCacheCompact,
    formatPluginCompatibilityNotice,
    formatTimeAgo,
    formatTokensCompact,
    formatUpdateAvailableHint,
    getTerminalTableWidth,
    info,
    renderTable,
    resolveMemoryCacheSummary,
    resolveMemoryFtsState,
    resolveMemoryVectorState,
    shortenText,
    theme,
  } = await loadStatusCommandTextRuntime();
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);
  const updateSurface = buildStatusUpdateSurface({
    updateConfigChannel: cfg.update?.channel,
    update,
  });

  if (opts.verbose) {
    // Verbose status prints the raw gateway target resolution before the report tables.
    const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
    const details = buildGatewayConnectionDetails({ config: scan.cfg });
    logGatewayConnectionDetails({
      runtime,
      info,
      message: details.message,
      trailingBlankLine: true,
    });
  }

  const tableWidth = getTerminalTableWidth();

  if (secretDiagnostics.length > 0) {
    // Secret diagnostics are already redacted by the scanner; show them before the main report.
    runtime.log(theme.warn("Secret diagnostics:"));
    for (const entry of secretDiagnostics) {
      runtime.log(`- ${entry}`);
    }
    const wrapperContextHint = resolveServiceWrapperContextHint({
      serviceWrapperPath: daemon.wrapperPath,
      cliWrapperPath: process.env[OPENCLAW_WRAPPER_ENV_KEY],
    });
    if (wrapperContextHint) {
      runtime.log(theme.warn(wrapperContextHint));
    }
    runtime.log("");
  }

  const nodeOnlyGateway = await loadStatusNodeModeModule().then(({ resolveNodeOnlyGatewayInfo }) =>
    resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeDaemon,
    }),
  );
  const pairingRecovery = resolvePairingRecoveryContext({
    error: gatewayProbe?.error ?? null,
    closeReason: gatewayProbe?.close?.reason ?? null,
    details: gatewayProbe?.connectErrorDetails,
  });

  const usageLines = usage
    ? await loadStatusProviderUsageModule().then(({ formatUsageReportLines }) =>
        formatUsageReportLines(usage),
      )
    : undefined;
  const overviewSurface = buildStatusOverviewSurfaceFromScan({
    scan: {
      cfg,
      update,
      tailscaleMode,
      tailscaleDns,
      tailscaleHttpsUrl,
      ...(advertisedControlUiLinks ? { advertisedControlUiLinks } : {}),
      gatewayMode,
      remoteUrlMissing,
      gatewayConnection,
      gatewayReachable,
      gatewayProbe,
      gatewayProbeAuth,
      gatewayProbeAuthWarning,
      gatewaySelf,
    },
    gatewayService: daemon,
    nodeService: nodeDaemon,
    nodeOnlyGateway,
  });
  const updateRestartValue = formatUpdateRestartStatusValue(
    (await readRestartSentinel().catch(() => null))?.payload,
    {
      ok,
      warn,
      muted,
      formatTimeAgo,
    },
  );
  const lines = await buildStatusCommandReportLines(
    await buildStatusCommandReportData({
      opts,
      surface: overviewSurface,
      osSummary,
      summary,
      securityAudit,
      health,
      usageLines,
      lastHeartbeat,
      agentStatus,
      channels,
      channelIssues,
      memory,
      memoryPlugin,
      pluginCompatibility,
      pairingRecovery,
      tableWidth,
      ok,
      warn,
      muted,
      shortenText,
      formatCliCommand,
      formatTimeAgo,
      formatKTokens,
      formatTokensCompact,
      formatPromptCacheCompact,
      formatHealthChannelLines,
      formatPluginCompatibilityNotice,
      formatUpdateAvailableHint,
      resolveMemoryVectorState,
      resolveMemoryFtsState,
      resolveMemoryCacheSummary,
      accentDim: theme.accentDim,
      theme,
      renderTable,
      updateValue: updateSurface.updateAvailable
        ? warn(`available · ${updateSurface.updateLine}`)
        : updateSurface.updateLine,
      updateRestartValue,
    }),
  );
  for (const line of lines) {
    runtime.log(line);
  }
}

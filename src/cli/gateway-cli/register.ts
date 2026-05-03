import type { Command } from "commander";
import type { HealthSummary } from "../../commands/health.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import type {
  DiagnosticStabilityBundle,
  ReadDiagnosticStabilityBundleResult,
} from "../../logging/diagnostic-stability-bundle.js";
import {
  normalizeDiagnosticStabilityQuery,
  selectDiagnosticStabilitySnapshot,
  type DiagnosticStabilityEventRecord,
  type DiagnosticStabilitySnapshot,
} from "../../logging/diagnostic-stability.js";
import type { WriteDiagnosticSupportExportResult } from "../../logging/diagnostic-support-export.js";
import { defaultRuntime } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayServiceCommands } from "../daemon-cli/register-service-commands.js";
import { formatHelpExamples } from "../help-format.js";
import { withProgress } from "../progress.js";
import { callGatewayCli, gatewayCallOpts, type GatewayRpcOpts } from "./call.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import {
  dedupeBeacons,
  parseDiscoverTimeoutMs,
  pickBeaconHost,
  pickGatewayPort,
  renderBeaconLines,
} from "./discover.js";
import { addGatewayRunCommand } from "./run.js";

const configModuleLoader = createLazyImportLoader(
  () => import("../../config/read-best-effort-config.runtime.js"),
);
const gatewayStatusModuleLoader = createLazyImportLoader(
  () => import("../../commands/gateway-status.js"),
);
const gatewayHealthModuleLoader = createLazyImportLoader(() => import("../../commands/health.js"));
const bonjourDiscoveryModuleLoader = createLazyImportLoader(
  () => import("../../infra/bonjour-discovery.js"),
);
const wideAreaDnsModuleLoader = createLazyImportLoader(() => import("../../infra/widearea-dns.js"));
const healthStyleModuleLoader = createLazyImportLoader(
  () => import("../../terminal/health-style.js"),
);
const usageFormatModuleLoader = createLazyImportLoader(() => import("../../utils/usage-format.js"));
const stabilityBundleModuleLoader = createLazyImportLoader(
  () => import("../../logging/diagnostic-stability-bundle.js"),
);
const supportExportModuleLoader = createLazyImportLoader(
  () => import("../../logging/diagnostic-support-export.js"),
);
const daemonStatusGatherModuleLoader = createLazyImportLoader(
  () => import("../daemon-cli/status.gather.js"),
);

function loadConfigModule() {
  return configModuleLoader.load();
}

function loadGatewayStatusModule() {
  return gatewayStatusModuleLoader.load();
}

function loadGatewayHealthModule() {
  return gatewayHealthModuleLoader.load();
}

function loadBonjourDiscoveryModule() {
  return bonjourDiscoveryModuleLoader.load();
}

function loadWideAreaDnsModule() {
  return wideAreaDnsModuleLoader.load();
}

function loadHealthStyleModule() {
  return healthStyleModuleLoader.load();
}

function loadUsageFormatModule() {
  return usageFormatModuleLoader.load();
}

function loadStabilityBundleModule() {
  return stabilityBundleModuleLoader.load();
}

function loadSupportExportModule() {
  return supportExportModuleLoader.load();
}

function loadDaemonStatusGatherModule() {
  return daemonStatusGatherModuleLoader.load();
}

function runGatewayCommand(action: () => Promise<void>, label?: string) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    const message = String(err);
    defaultRuntime.error(label ? `${label}: ${message}` : message);
    defaultRuntime.exit(1);
  });
}

function parseDaysOption(raw: unknown, fallback = 30): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.floor(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.floor(parsed));
    }
  }
  return fallback;
}

function resolveGatewayRpcOptions<T extends { token?: string; password?: string }>(
  opts: T,
  command?: Command,
): T {
  const parentToken = inheritOptionFromParent<string>(command, "token");
  const parentPassword = inheritOptionFromParent<string>(command, "password");
  return {
    ...opts,
    token: opts.token ?? parentToken,
    password: opts.password ?? parentPassword,
  };
}

async function renderCostUsageSummaryAsync(
  summary: CostUsageSummary,
  days: number,
  rich: boolean,
): Promise<string[]> {
  const { formatTokenCount, formatUsd } = await loadUsageFormatModule();
  const totalCost = formatUsd(summary.totals.totalCost) ?? "$0.00";
  const totalTokens = formatTokenCount(summary.totals.totalTokens) ?? "0";
  const lines = [
    colorize(rich, theme.heading, `Usage cost (${days} days)`),
    `${colorize(rich, theme.muted, "Total:")} ${totalCost} · ${totalTokens} tokens`,
  ];

  if (summary.totals.missingCostEntries > 0) {
    lines.push(
      `${colorize(rich, theme.muted, "Missing entries:")} ${summary.totals.missingCostEntries}`,
    );
  }

  const latest = summary.daily.at(-1);
  if (latest) {
    const latestCost = formatUsd(latest.totalCost) ?? "$0.00";
    const latestTokens = formatTokenCount(latest.totalTokens) ?? "0";
    lines.push(
      `${colorize(rich, theme.muted, "Latest day:")} ${latest.date} · ${latestCost} · ${latestTokens} tokens`,
    );
  }

  return lines;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || amount >= 100 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatStabilityEvent(record: DiagnosticStabilityEventRecord): string {
  const parts = [
    new Date(record.ts).toISOString(),
    `#${record.seq}`,
    record.type,
    record.level ? `level=${record.level}` : "",
    record.action ? `action=${record.action}` : "",
    record.outcome ? `outcome=${record.outcome}` : "",
    record.surface ? `surface=${record.surface}` : "",
    record.channel ? `channel=${record.channel}` : "",
    record.pluginId ? `plugin=${record.pluginId}` : "",
    record.reason ? `reason=${record.reason}` : "",
    record.bytes !== undefined ? `bytes=${formatBytes(record.bytes)}` : "",
    record.limitBytes !== undefined ? `limit=${formatBytes(record.limitBytes)}` : "",
    record.queueDepth !== undefined ? `queueDepth=${record.queueDepth}` : "",
    record.queued !== undefined ? `queued=${record.queued}` : "",
    record.memory ? `rss=${formatBytes(record.memory.rssBytes)}` : "",
    record.memory ? `heap=${formatBytes(record.memory.heapUsedBytes)}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

function renderStabilitySummary(snapshot: DiagnosticStabilitySnapshot, rich: boolean): string[] {
  const lines = [
    colorize(rich, theme.heading, "Gateway Stability"),
    `${colorize(rich, theme.muted, "Events:")} ${snapshot.count}/${snapshot.capacity}${
      snapshot.dropped > 0 ? ` · dropped=${snapshot.dropped}` : ""
    }`,
  ];

  const topTypes = Object.entries(snapshot.summary.byType)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  if (topTypes) {
    lines.push(`${colorize(rich, theme.muted, "Types:")} ${topTypes}`);
  }

  const memory = snapshot.summary.memory;
  if (memory) {
    lines.push(
      `${colorize(rich, theme.muted, "Memory:")} rss=${formatBytes(
        memory.latest?.rssBytes,
      )} heap=${formatBytes(memory.latest?.heapUsedBytes)} maxRss=${formatBytes(
        memory.maxRssBytes,
      )} pressure=${memory.pressureCount}`,
    );
  }

  const payloadLarge = snapshot.summary.payloadLarge;
  if (payloadLarge) {
    const surfaces = Object.entries(payloadLarge.bySurface)
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([surface, count]) => `${surface}=${count}`)
      .join(", ");
    lines.push(
      `${colorize(rich, theme.muted, "Large payloads:")} total=${payloadLarge.count} rejected=${
        payloadLarge.rejected
      } truncated=${payloadLarge.truncated} chunked=${payloadLarge.chunked}${
        surfaces ? ` · ${surfaces}` : ""
      }`,
    );
  }

  if (snapshot.events.length > 0) {
    lines.push(colorize(rich, theme.muted, "Recent:"));
    for (const event of snapshot.events) {
      lines.push(`  ${formatStabilityEvent(event)}`);
    }
  }

  return lines;
}

function normalizeStabilityBundleTarget(raw: unknown): string | null {
  if (raw === undefined || raw === false) {
    return null;
  }
  if (raw === true) {
    return "latest";
  }
  if (typeof raw !== "string") {
    return "latest";
  }
  const value = raw.trim();
  return value === "" ? "latest" : value;
}

function formatBundleError(result: ReadDiagnosticStabilityBundleResult): string {
  if (result.status === "missing") {
    return `No stability bundles found in ${result.dir}`;
  }
  if (result.status === "failed") {
    return result.error instanceof Error ? result.error.message : String(result.error);
  }
  return "Unexpected stability bundle read result";
}

async function readStabilityBundleTarget(
  bundleTarget: string,
): Promise<ReadDiagnosticStabilityBundleResult> {
  const { readDiagnosticStabilityBundleFileSync, readLatestDiagnosticStabilityBundleSync } =
    await loadStabilityBundleModule();
  return bundleTarget === "latest"
    ? readLatestDiagnosticStabilityBundleSync()
    : readDiagnosticStabilityBundleFileSync(bundleTarget);
}

function renderStabilityBundleSummary(params: {
  bundle: DiagnosticStabilityBundle;
  path: string;
  snapshot: DiagnosticStabilitySnapshot;
  rich: boolean;
}): string[] {
  const { bundle, path, rich, snapshot } = params;
  const processDetails = [
    `pid=${bundle.process.pid}`,
    `node=${bundle.process.node}`,
    `${bundle.process.platform}/${bundle.process.arch}`,
    `uptime=${Math.round(bundle.process.uptimeMs / 1000)}s`,
  ].join(" ");
  const lines = [
    colorize(rich, theme.heading, "Stability bundle"),
    `${colorize(rich, theme.muted, "Path:")} ${path}`,
    `${colorize(rich, theme.muted, "Generated:")} ${bundle.generatedAt}`,
    `${colorize(rich, theme.muted, "Reason:")} ${bundle.reason}`,
    `${colorize(rich, theme.muted, "Process:")} ${processDetails}`,
    `${colorize(rich, theme.muted, "Host:")} ${bundle.host.hostname}`,
  ];
  if (bundle.error) {
    const errorParts = [
      bundle.error.name ? `name=${bundle.error.name}` : "",
      bundle.error.code ? `code=${bundle.error.code}` : "",
    ].filter(Boolean);
    if (errorParts.length > 0) {
      lines.push(`${colorize(rich, theme.muted, "Error:")} ${errorParts.join(" ")}`);
    }
  }
  lines.push("", ...renderStabilitySummary(snapshot, rich));
  return lines;
}

function renderSupportExportResult(
  result: WriteDiagnosticSupportExportResult,
  rich: boolean,
): string[] {
  return [
    colorize(rich, theme.heading, "Diagnostics export"),
    `${colorize(rich, theme.muted, "Path:")} ${result.path}`,
    `${colorize(rich, theme.muted, "Size:")} ${formatBytes(result.bytes)}`,
    `${colorize(rich, theme.muted, "Files:")} ${result.manifest.contents.length}`,
    `${colorize(rich, theme.muted, "Privacy:")} payload-free stability, sanitized logs/status/health/config`,
  ];
}

function resolveSupportExportRpcOptions(
  rpc?: Pick<GatewayRpcOpts, "url" | "token" | "password" | "timeout">,
): GatewayRpcOpts {
  return {
    url: rpc?.url,
    token: rpc?.token,
    password: rpc?.password,
    timeout: rpc?.timeout ?? "3000",
    json: true,
  };
}

async function writeSupportExportFromCli(opts: {
  json?: boolean;
  output?: string;
  logLines?: string;
  logBytes?: string;
  stabilityBundle?: string | false;
  rpc?: Pick<GatewayRpcOpts, "url" | "token" | "password" | "timeout">;
}): Promise<void> {
  const { writeDiagnosticSupportExport } = await loadSupportExportModule();
  const rpc = resolveSupportExportRpcOptions(opts.rpc);
  const result = await writeDiagnosticSupportExport({
    outputPath: opts.output,
    logLimit: opts.logLines ? Number(opts.logLines) : undefined,
    logMaxBytes: opts.logBytes ? Number(opts.logBytes) : undefined,
    stabilityBundle: opts.stabilityBundle,
    readStatusSnapshot: async () => {
      const { gatherDaemonStatus } = await loadDaemonStatusGatherModule();
      return await gatherDaemonStatus({
        rpc,
        probe: true,
        requireRpc: false,
        deep: false,
      });
    },
    readHealthSnapshot: async () => await callGatewayCli("health", rpc),
  });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  const rich = isRich();
  for (const line of renderSupportExportResult(result, rich)) {
    defaultRuntime.log(line);
  }
}

export function registerGatewayCli(program: Command) {
  const gateway = addGatewayRunCommand(
    program
      .command("gateway")
      .description("Run, inspect, and query the WebSocket Gateway")
      .addHelpText(
        "after",
        () =>
          `\n${theme.heading("Examples:")}\n${formatHelpExamples([
            ["openclaw gateway run", "Run the gateway in the foreground."],
            ["openclaw gateway status", "Show service status plus connectivity/capability."],
            ["openclaw gateway discover", "Find local and wide-area gateway beacons."],
            ["openclaw gateway stability", "Show recent stability diagnostics."],
            ["openclaw gateway call health", "Call a gateway RPC method directly."],
          ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  addGatewayServiceCommands(gateway, {
    statusDescription: "Show gateway service status + probe connectivity/capability",
  });

  gatewayCallOpts(
    gateway
      .command("call")
      .description("Call a Gateway method")
      .argument("<method>", "Method name (health/status/system-presence/cron.*)")
      .option("--params <json>", "JSON object string for params", "{}")
      .action(async (method, opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, rpcOpts, params);
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          defaultRuntime.log(
            `${colorize(rich, theme.heading, "Gateway call")}: ${colorize(rich, theme.muted, String(method))}`,
          );
          defaultRuntime.writeJson(result);
        }, "Gateway call failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("usage-cost")
      .description("Fetch usage cost summary from session logs")
      .option("--days <days>", "Number of days to include", "30")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const days = parseDaysOption(opts.days);
          const result = await callGatewayCli("usage.cost", rpcOpts, { days });
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          const summary = result as CostUsageSummary;
          for (const line of await renderCostUsageSummaryAsync(summary, days, rich)) {
            defaultRuntime.log(line);
          }
        }, "Gateway usage cost failed");
      }),
  );

  gatewayCallOpts(
    gateway
      .command("health")
      .description("Fetch Gateway health")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const [{ formatHealthChannelLines }, { styleHealthChannelLine }] = await Promise.all([
            loadGatewayHealthModule(),
            loadHealthStyleModule(),
          ]);
          const result = await callGatewayCli("health", rpcOpts);
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          const obj: Record<string, unknown> = result && typeof result === "object" ? result : {};
          const durationMs = typeof obj.durationMs === "number" ? obj.durationMs : null;
          defaultRuntime.log(colorize(rich, theme.heading, "Gateway Health"));
          defaultRuntime.log(
            `${colorize(rich, theme.success, "OK")}${durationMs != null ? ` (${durationMs}ms)` : ""}`,
          );
          if (obj.channels && typeof obj.channels === "object") {
            for (const line of formatHealthChannelLines(obj as HealthSummary)) {
              defaultRuntime.log(styleHealthChannelLine(line, rich));
            }
          }
        });
      }),
  );

  gatewayCallOpts(
    gateway
      .command("stability")
      .description("Fetch payload-free Gateway stability diagnostics")
      .option("--limit <limit>", "Maximum number of recent events", "25")
      .option("--type <type>", "Filter by diagnostic event type")
      .option("--since-seq <seq>", "Only include events after this sequence")
      .option(
        "--bundle [path]",
        'Read a persisted stability bundle instead of calling Gateway; pass "latest" for newest',
      )
      .option("--export", "Write a shareable support diagnostics export", false)
      .option("--output <path>", "Diagnostics export output .zip path")
      .action(async (opts, command) => {
        await runGatewayCommand(async () => {
          const rpcOpts = resolveGatewayRpcOptions(opts, command);
          const query = normalizeDiagnosticStabilityQuery(
            {
              limit: opts.limit,
              sinceSeq: opts.sinceSeq,
              type: opts.type,
            },
            { defaultLimit: 25 },
          );
          const bundleTarget = normalizeStabilityBundleTarget(opts.bundle);
          if (opts.export) {
            await writeSupportExportFromCli({
              json: rpcOpts.json,
              output: opts.output,
              stabilityBundle: bundleTarget ?? "latest",
              rpc: rpcOpts,
            });
            return;
          }
          if (bundleTarget) {
            const result = await readStabilityBundleTarget(bundleTarget);
            if (result.status !== "found") {
              throw new Error(formatBundleError(result));
            }
            const snapshot = selectDiagnosticStabilitySnapshot(result.bundle.snapshot, query);
            if (rpcOpts.json) {
              defaultRuntime.writeJson({
                path: result.path,
                mtimeMs: result.mtimeMs,
                bundle: {
                  ...result.bundle,
                  snapshot,
                },
              });
              return;
            }
            const rich = isRich();
            for (const line of renderStabilityBundleSummary({
              bundle: result.bundle,
              path: result.path,
              rich,
              snapshot,
            })) {
              defaultRuntime.log(line);
            }
            return;
          }

          const result = await callGatewayCli("diagnostics.stability", rpcOpts, {
            limit: query.limit,
            ...(query.type ? { type: query.type } : {}),
            ...(query.sinceSeq !== undefined ? { sinceSeq: query.sinceSeq } : {}),
          });
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          for (const line of renderStabilitySummary(result as DiagnosticStabilitySnapshot, rich)) {
            defaultRuntime.log(line);
          }
        }, "Gateway stability failed");
      }),
  );

  const diagnostics = gateway
    .command("diagnostics")
    .description("Export local support diagnostics");
  diagnostics
    .command("export")
    .description("Write a shareable, payload-free diagnostics .zip")
    .option("--output <path>", "Output .zip path")
    .option("--log-lines <count>", "Maximum sanitized log lines to include", "5000")
    .option("--log-bytes <bytes>", "Maximum log bytes to inspect", "1000000")
    .option("--url <url>", "Gateway WebSocket URL for health snapshot")
    .option("--token <token>", "Gateway token for health snapshot")
    .option("--password <password>", "Gateway password for health snapshot")
    .option("--timeout <ms>", "Status/health snapshot timeout in ms", "3000")
    .option("--no-stability-bundle", "Skip persisted stability bundle lookup")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await runGatewayCommand(async () => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        await writeSupportExportFromCli({
          json: opts.json,
          output: opts.output,
          logLines: opts.logLines,
          logBytes: opts.logBytes,
          stabilityBundle: opts.stabilityBundle === false ? false : "latest",
          rpc: rpcOpts,
        });
      }, "Gateway diagnostics export failed");
    });

  gateway
    .command("probe")
    .description(
      "Show gateway reachability, auth capability, and read-probe summary (local + remote)",
    )
    .option("--url <url>", "Explicit Gateway WebSocket URL (still probes localhost)")
    .option("--ssh <target>", "SSH target for remote gateway tunnel (user@host or user@host:port)")
    .option("--ssh-identity <path>", "SSH identity file path")
    .option("--ssh-auto", "Try to derive an SSH target from Bonjour discovery", false)
    .option("--token <token>", "Gateway token (applies to all probes)")
    .option("--password <password>", "Gateway password (applies to all probes)")
    .option("--timeout <ms>", "Overall probe budget in ms", "3000")
    .option("--json", "Output JSON", false)
    .action(async (opts, command) => {
      await runGatewayCommand(async () => {
        const rpcOpts = resolveGatewayRpcOptions(opts, command);
        const { gatewayStatusCommand } = await loadGatewayStatusModule();
        await gatewayStatusCommand(rpcOpts, defaultRuntime);
      });
    });

  gateway
    .command("discover")
    .description("Discover gateways via Bonjour (local + wide-area if configured)")
    .option("--timeout <ms>", "Per-command timeout in ms", "2000")
    .option("--json", "Output JSON", false)
    .action(async (opts: GatewayDiscoverOpts) => {
      await runGatewayCommand(async () => {
        const [
          { readSourceConfigBestEffort },
          { discoverGatewayBeacons },
          { resolveWideAreaDiscoveryDomain },
        ] = await Promise.all([
          loadConfigModule(),
          loadBonjourDiscoveryModule(),
          loadWideAreaDnsModule(),
        ]);
        const cfg = await readSourceConfigBestEffort();
        const wideAreaDomain = resolveWideAreaDiscoveryDomain({
          configDomain: cfg.discovery?.wideArea?.domain,
        });
        const timeoutMs = parseDiscoverTimeoutMs(opts.timeout, 2000);
        const domains = ["local.", ...(wideAreaDomain ? [wideAreaDomain] : [])];
        const beacons = await withProgress(
          {
            label: "Scanning for gateways…",
            indeterminate: true,
            enabled: opts.json !== true,
            delayMs: 0,
          },
          async () => await discoverGatewayBeacons({ timeoutMs, wideAreaDomain }),
        );

        const deduped = dedupeBeacons(beacons).toSorted((a, b) =>
          (a.displayName || a.instanceName).localeCompare(b.displayName || b.instanceName),
        );

        if (opts.json) {
          const enriched = deduped.map((b) => {
            const host = pickBeaconHost(b);
            const port = pickGatewayPort(b);
            return { ...b, wsUrl: host ? `ws://${host}:${port}` : null };
          });
          defaultRuntime.writeJson({
            timeoutMs,
            domains,
            count: enriched.length,
            beacons: enriched,
          });
          return;
        }

        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Gateway Discovery"));
        defaultRuntime.log(
          colorize(
            rich,
            theme.muted,
            `Found ${deduped.length} gateway(s) · domains: ${domains.join(", ")}`,
          ),
        );
        if (deduped.length === 0) {
          return;
        }

        for (const beacon of deduped) {
          for (const line of renderBeaconLines(beacon, rich)) {
            defaultRuntime.log(line);
          }
        }
      }, "gateway discover failed");
    });
}

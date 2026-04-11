import type { Command } from "commander";
import { gatewayStatusCommand } from "../../commands/gateway-status.js";
import { formatHealthChannelLines, type HealthSummary } from "../../commands/health.js";
import { readBestEffortConfig } from "../../config/config.js";
import { discoverGatewayBeacons } from "../../infra/bonjour-discovery.js";
import type { CostUsageSummary } from "../../infra/session-cost-usage.js";
import { resolveWideAreaDiscoveryDomain } from "../../infra/widearea-dns.js";
import { defaultRuntime } from "../../runtime.js";
import { styleHealthChannelLine } from "../../terminal/health-style.js";
import { formatDocsLink } from "../../terminal/links.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import { formatTokenCount, formatUsd } from "../../utils/usage-format.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { inheritOptionFromParent } from "../command-options.js";
import { addGatewayServiceCommands } from "../daemon-cli.js";
import { formatHelpExamples } from "../help-format.js";
import { withProgress } from "../progress.js";
import { callGatewayCli, gatewayCallOpts } from "./call.js";
import type { GatewayDiscoverOpts } from "./discover.js";
import {
  dedupeBeacons,
  parseDiscoverTimeoutMs,
  pickBeaconHost,
  pickGatewayPort,
  renderBeaconLines,
} from "./discover.js";
import { addGatewayRunCommand } from "./run.js";

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

function renderCostUsageSummary(summary: CostUsageSummary, days: number, rich: boolean): string[] {
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
            ["openclaw gateway status", "Show service status and probe reachability."],
            ["openclaw gateway discover", "Find local and wide-area gateway beacons."],
            ["openclaw gateway call health", "Call a gateway RPC method directly."],
          ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`,
      ),
  );

  addGatewayRunCommand(
    gateway.command("run").description("Run the WebSocket Gateway (foreground)"),
  );

  addGatewayServiceCommands(gateway, {
    statusDescription: "Show gateway service status + probe the Gateway",
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
          const config = await readBestEffortConfig();
          const params = JSON.parse(String(opts.params ?? "{}"));
          const result = await callGatewayCli(method, { ...rpcOpts, config }, params);
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
          const config = await readBestEffortConfig();
          const result = await callGatewayCli("usage.cost", { ...rpcOpts, config }, { days });
          if (rpcOpts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const rich = isRich();
          const summary = result as CostUsageSummary;
          for (const line of renderCostUsageSummary(summary, days, rich)) {
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
          const config = await readBestEffortConfig();
          const result = await callGatewayCli("health", { ...rpcOpts, config });
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

  gateway
    .command("probe")
    .description("Show gateway reachability + discovery + health + status summary (local + remote)")
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
        const cfg = await readBestEffortConfig();
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

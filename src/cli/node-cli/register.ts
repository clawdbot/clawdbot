import type { Command } from "commander";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { runNodeHost } from "../../node-host/runner.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { parsePort } from "../daemon-cli/shared.js";
import { formatHelpExamples } from "../help-format.js";
import {
  runNodeDaemonInstall,
  runNodeDaemonRestart,
  runNodeDaemonStart,
  runNodeDaemonStatus,
  runNodeDaemonStop,
  runNodeDaemonUninstall,
} from "./daemon.js";

function parsePortWithFallback(value: unknown, fallback: number): number {
  const parsed = parsePort(value);
  return parsed ?? fallback;
}

export function registerNodeCli(program: Command) {
  const node = program
    .command("node")
    .description("Run and manage the headless node host service")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw node run --host 127.0.0.1 --port 18789",
            "Run the node host in the foreground.",
          ],
          ["openclaw node status", "Check node host service status."],
          ["openclaw node install", "Install the node host service."],
          ["openclaw node start", "Start the installed node host service."],
          ["openclaw node restart", "Restart the installed node host service."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/node", "docs.openclaw.ai/cli/node")}\n`,
    );

  node
    .command("run")
    .description("Run the headless node host (foreground)")
    .option("--host <host>", "Gateway host")
    .option("--port <port>", "Gateway port")
    .option("--tls", "Use TLS for the gateway connection", false)
    .option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)")
    .option("--node-id <id>", "Override node id (clears pairing token)")
    .option("--display-name <name>", "Override node display name")
    .action(async (opts) => {
      const existing = await loadNodeHostConfig();
      const host =
        normalizeOptionalString(opts.host as string | undefined) ||
        existing?.gateway?.host ||
        "127.0.0.1";
      const port = parsePortWithFallback(opts.port, existing?.gateway?.port ?? 18789);
      await runNodeHost({
        gatewayHost: host,
        gatewayPort: port,
        gatewayTls: Boolean(opts.tls) || Boolean(opts.tlsFingerprint),
        gatewayTlsFingerprint: opts.tlsFingerprint,
        nodeId: opts.nodeId,
        displayName: opts.displayName,
      });
    });

  node
    .command("status")
    .description("Show node host status")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonStatus(opts);
    });

  node
    .command("install")
    .description("Install the node host service (launchd/systemd/schtasks)")
    .option("--host <host>", "Gateway host")
    .option("--port <port>", "Gateway port")
    .option("--tls", "Use TLS for the gateway connection", false)
    .option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)")
    .option("--node-id <id>", "Override node id (clears pairing token)")
    .option("--display-name <name>", "Override node display name")
    .option("--runtime <runtime>", "Service runtime (node|bun). Default: node")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonInstall(opts);
    });

  node
    .command("uninstall")
    .description("Uninstall the node host service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonUninstall(opts);
    });

  node
    .command("stop")
    .description("Stop the node host service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonStop(opts);
    });

  node
    .command("start")
    .description("Start the node host service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonStart(opts);
    });

  node
    .command("restart")
    .description("Restart the node host service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonRestart(opts);
    });
}

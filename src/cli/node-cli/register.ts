import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { runNodeHost } from "../../node-host/runner.js";
import {
  runNodeDaemonInstall,
  runNodeDaemonRestart,
  runNodeDaemonStatus,
  runNodeDaemonStop,
  runNodeDaemonUninstall,
} from "./daemon.js";
import { parsePort } from "../daemon-cli/shared.js";

function parsePortWithFallback(value: unknown, fallback: number): number {
  const parsed = parsePort(value);
  return parsed ?? fallback;
}

export function registerNodeCli(program: Command) {
  const node = program
    .command("node")
    .description("Run a headless node host (system.run/system.which)")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/node", "docs.clawd.bot/cli/node")}\n`,
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
        (opts.host as string | undefined)?.trim() || existing?.gateway?.host || "127.0.0.1";
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
    .command("restart")
    .description("Restart the node host service (launchd/systemd/schtasks)")
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonRestart(opts);
    });
}

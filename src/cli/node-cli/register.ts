// Commander registration for foreground node host and node service lifecycle commands.
import { Option, type Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { loadNodeHostConfig } from "../../node-host/config.js";
import { runNodeHost } from "../../node-host/runner.js";
import { runNodeHostWorker } from "../../node-host/worker.js";
import { defaultRuntime } from "../../runtime.js";
import { formatInvalidPortOption } from "../error-format.js";
import { formatHelpExamples } from "../help-format.js";
import {
  runNodeDaemonInstall,
  runNodeDaemonRestart,
  runNodeDaemonStart,
  runNodeDaemonStatus,
  runNodeDaemonStop,
  runNodeDaemonUninstall,
} from "./daemon.js";
import { resolveNodeGatewayOptions, resolveNodePairGatewayOptions } from "./gateway-options.js";
import { runNodeIdentityShow } from "./identity.js";

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
    .command("worker", { hidden: true })
    .description("Run the private macOS app node-host worker")
    .action(async () => {
      await runNodeHostWorker();
    });

  node
    .command("run")
    .description("Run the headless node host (foreground)")
    .option(
      "--pair <code-or-url>",
      "Pair with a setup code or oc-pair URL; explicit gateway flags take precedence",
    )
    .option("--host <host>", "Gateway host")
    .option("--port <port>", "Gateway port")
    .option("--context-path <path>", "Gateway WebSocket context path (e.g. /openclaw-gw)")
    .option("--tls", "Use TLS for the gateway connection")
    .option("--no-tls", "Disable TLS for the gateway connection")
    .option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)")
    .option("--node-id <id>", "Override the generated node instance id")
    .option("--display-name <name>", "Override node display name")
    .addOption(new Option("--ephemeral").hideHelp())
    .option("--share-installed-apps", "Share installed macOS applications with the Gateway")
    .option("--no-share-installed-apps", "Disable installed application sharing")
    .action(async (opts) => {
      let pair;
      let gatewayOptions;
      try {
        pair = opts.pair ? resolveNodePairGatewayOptions(opts.pair) : undefined;
        const existing = await loadNodeHostConfig();
        gatewayOptions = resolveNodeGatewayOptions(opts, existing, pair);
      } catch (error) {
        defaultRuntime.error(error instanceof Error ? error.message : String(error));
        defaultRuntime.exit(1);
        return;
      }
      const { host, port, contextPath, tls, tlsFingerprint, cloudflareAccess, gatewayCandidates } =
        gatewayOptions;
      if (port === null) {
        defaultRuntime.error(formatInvalidPortOption("--port"));
        defaultRuntime.exit(1);
        return;
      }
      if (opts.tls === false && opts.tlsFingerprint !== undefined) {
        defaultRuntime.error("--no-tls cannot be combined with --tls-fingerprint");
        defaultRuntime.exit(1);
        return;
      }
      await runNodeHost({
        gatewayHost: host,
        gatewayPort: port,
        gatewayTls: tls,
        gatewayTlsFingerprint: tlsFingerprint,
        gatewayContextPath: contextPath,
        gatewayCloudflareAccess: cloudflareAccess,
        gatewayCandidates,
        gatewayBootstrapToken: pair?.bootstrapToken,
        preferGatewayBootstrapToken: pair !== undefined,
        ...(opts.ephemeral === true ? { forceWorkerRuns: true } : {}),
        nodeId: opts.nodeId,
        displayName: opts.displayName,
        installedAppsSharing: opts.shareInstalledApps,
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
    .command("identity")
    .description("Print the node host device identity (device id + public key)")
    .option("--json", "Output JSON", false)
    .action((opts) => {
      runNodeIdentityShow(opts);
    });

  node
    .command("install")
    .description("Install the node host service (launchd/systemd/schtasks)")
    .option("--host <host>", "Gateway host")
    .option("--port <port>", "Gateway port")
    .option("--context-path <path>", "Gateway WebSocket context path (e.g. /openclaw-gw)")
    .option("--tls", "Use TLS for the gateway connection")
    .option("--no-tls", "Disable TLS for the gateway connection")
    .option("--tls-fingerprint <sha256>", "Expected TLS certificate fingerprint (sha256)")
    .option("--node-id <id>", "Override the generated node instance id")
    .option("--display-name <name>", "Override node display name")
    .option("--share-installed-apps", "Share installed macOS applications with the Gateway")
    .option("--no-share-installed-apps", "Disable installed application sharing")
    .option("--runtime <runtime>", "Service runtime (node|bun). Default: node")
    .option("--force", "Reinstall/overwrite if already installed", false)
    .option("--json", "Output JSON", false)
    .action(async (opts) => {
      await runNodeDaemonInstall(opts);
    });

  for (const [name, action] of [
    ["uninstall", runNodeDaemonUninstall],
    ["stop", runNodeDaemonStop],
    ["start", runNodeDaemonStart],
    ["restart", runNodeDaemonRestart],
  ] as const) {
    node
      .command(name)
      .description(
        `${name.charAt(0).toUpperCase()}${name.slice(1)} the node host service (launchd/systemd/schtasks)`,
      )
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        await action(opts);
      });
  }
}

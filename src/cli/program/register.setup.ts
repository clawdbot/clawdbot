// Setup command registration: baseline setup by default, onboarding wizard when wizard flags appear.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { GatewayDaemonRuntime } from "../../commands/daemon-runtime.js";
import type {
  GatewayAuthChoice,
  GatewayBind,
  NodeManagerChoice,
  ResetScope,
  TailscaleMode,
} from "../../commands/onboard-types.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { parsePort } from "../shared/parse-port.js";
import { pickOnboardAuthOptionValues, registerOnboardAuthOptions } from "./register.onboard.js";

function resolveInstallDaemonFlag(
  command: unknown,
  opts: { installDaemon?: boolean },
): boolean | undefined {
  if (!command || typeof command !== "object") {
    return undefined;
  }
  const getOptionValueSource =
    "getOptionValueSource" in command ? command.getOptionValueSource : undefined;
  if (typeof getOptionValueSource !== "function") {
    return undefined;
  }

  if (getOptionValueSource.call(command, "skipDaemon") === "cli") {
    return false;
  }
  if (getOptionValueSource.call(command, "installDaemon") === "cli") {
    return Boolean(opts.installDaemon);
  }
  return undefined;
}

/** Register the `setup` command as an onboarding alias. */
export function registerSetupCommand(program: Command): void {
  const command = program
    .command("setup")
    .description("Alias for openclaw onboard")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n` +
        `  ${theme.command("openclaw setup")}\n` +
        `    ${theme.muted("Run full onboarding for auth, models, Gateway, and channels.")}\n\n` +
        `${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`,
    )
    .option(
      "--workspace <dir>",
      "Workspace proposal for guided setup; persisted by baseline/classic/non-interactive setup",
    )
    .option("--wizard", "Run interactive onboarding", false)
    .option(
      "--baseline",
      "Create baseline config/workspace/session folders without onboarding",
      false,
    )
    .option(
      "--reset",
      "Reset config + credentials + sessions before running onboarding (workspace only with --reset-scope full)",
    )
    .option("--reset-scope <scope>", "Reset scope: config|config+creds+sessions|full")
    .option("--non-interactive", "Run onboarding without prompts", false)
    .option("--classic", "Use the classic multi-step setup wizard", false)
    .option(
      "--accept-risk",
      "Acknowledge that agents are powerful and full system access is risky (required for --non-interactive)",
      false,
    )
    .option("--flow <flow>", "Onboard flow: quickstart|advanced|manual|import")
    .option("--mode <mode>", "Onboard mode: local|remote");

  registerOnboardAuthOptions(command);

  command
    .option("--gateway-port <port>", "Gateway port")
    .option("--gateway-bind <mode>", "Gateway bind: loopback|tailnet|lan|auto|custom")
    .option("--gateway-auth <mode>", "Gateway auth: token|password")
    .option("--gateway-token <token>", "Gateway token (token auth)")
    .option(
      "--gateway-token-ref-env <name>",
      "Gateway token SecretRef env var name (token auth; e.g. OPENCLAW_GATEWAY_TOKEN)",
    )
    .option("--gateway-password <password>", "Gateway password (password auth)")
    .option("--tailscale <mode>", "Tailscale: off|serve|funnel")
    .option("--tailscale-reset-on-exit", "Reset tailscale serve/funnel on exit")
    .option("--install-daemon", "Install gateway service")
    .option("--no-install-daemon", "Skip gateway service install")
    .option("--skip-daemon", "Skip gateway service install")
    .option("--daemon-runtime <runtime>", "Daemon runtime: node|bun")
    .option("--skip-channels", "Skip channel setup")
    .option("--skip-skills", "Skip skills setup")
    .option("--skip-bootstrap", "Skip creating default agent workspace files")
    .option("--skip-search", "Skip search provider setup")
    .option("--skip-health", "Skip health check")
    .option("--skip-ui", "Skip Control UI/TUI launch")
    .option("--suppress-gateway-token-output", "Suppress token-bearing Gateway/UI output")
    .option("--skip-hooks", "Accepted for onboard compatibility; hooks setup is skipped")
    .option("--node-manager <name>", "Node manager for skills: npm|pnpm|bun")
    .option("--import-from <provider>", "Migration provider to run during onboarding")
    .option("--import-source <path>", "Source agent home for --import-from")
    .option("--import-secrets", "Import supported secrets during onboarding migration", false)
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .option("--json", "Output JSON summary", false)
    .action(async (opts, commandRuntime) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        if (opts.baseline) {
          const { setupCommand } = await import("../../commands/setup.js");
          await setupCommand({ workspace: opts.workspace as string | undefined }, defaultRuntime);
          return;
        }
        const installDaemon = resolveInstallDaemonFlag(commandRuntime, {
          installDaemon: Boolean(opts.installDaemon),
        });
        const gatewayPort = parsePort(opts.gatewayPort);
        const { setupWizardCommand } = await import("../../commands/onboard.js");
        await setupWizardCommand(
          {
            workspace: opts.workspace as string | undefined,
            nonInteractive: Boolean(opts.nonInteractive),
            acceptRisk: Boolean(opts.acceptRisk),
            classic: Boolean(opts.classic),
            flow: opts.flow as "quickstart" | "advanced" | "manual" | "import" | undefined,
            mode: opts.mode as "local" | "remote" | undefined,
            ...pickOnboardAuthOptionValues(opts as Record<string, unknown>),
            reset: Boolean(opts.reset),
            resetScope: opts.resetScope as ResetScope | undefined,
            gatewayPort: gatewayPort ?? undefined,
            gatewayBind: opts.gatewayBind as GatewayBind | undefined,
            gatewayAuth: opts.gatewayAuth as GatewayAuthChoice | undefined,
            gatewayToken: opts.gatewayToken as string | undefined,
            gatewayTokenRefEnv: opts.gatewayTokenRefEnv as string | undefined,
            gatewayPassword: opts.gatewayPassword as string | undefined,
            tailscale: opts.tailscale as TailscaleMode | undefined,
            tailscaleResetOnExit: Boolean(opts.tailscaleResetOnExit),
            installDaemon,
            daemonRuntime: opts.daemonRuntime as GatewayDaemonRuntime | undefined,
            skipChannels: Boolean(opts.skipChannels),
            skipSkills: Boolean(opts.skipSkills),
            skipBootstrap: Boolean(opts.skipBootstrap),
            skipSearch: Boolean(opts.skipSearch),
            skipHealth: Boolean(opts.skipHealth),
            skipUi: Boolean(opts.skipUi),
            suppressGatewayTokenOutput: Boolean(opts.suppressGatewayTokenOutput),
            skipHooks: Boolean(opts.skipHooks),
            nodeManager: opts.nodeManager as NodeManagerChoice | undefined,
            importFrom: opts.importFrom as string | undefined,
            importSource: opts.importSource as string | undefined,
            importSecrets: Boolean(opts.importSecrets),
            remoteUrl: opts.remoteUrl as string | undefined,
            remoteToken: opts.remoteToken as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}

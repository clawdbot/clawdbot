// Setup command registration: system-agent chat for configured systems, onboarding otherwise.
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
import type { RuntimeEnv } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";
import { isUnconfiguredConfigSource } from "../fresh-install-config.js";
import { parsePort } from "../shared/parse-port.js";
import {
  pickOnboardAuthOptionValues,
  registerOnboardAuthOptions,
  resolveInstallDaemonFlag,
} from "./register.onboard.js";

const SYSTEM_AGENT_OPTION_NAMES = new Set(["message", "yes", "json"]);

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

type SetupRoute = "onboarding" | "system-agent";

export function resolveSetupCommandRoute(input: {
  hasOnboardingFlag: boolean;
  hasSystemAgentRequest: boolean;
  configured: boolean;
  interactive: boolean;
  json: boolean;
}): SetupRoute {
  if (input.hasOnboardingFlag) {
    return "onboarding";
  }
  if (input.hasSystemAgentRequest) {
    return "system-agent";
  }
  if (input.configured && (input.interactive || input.json)) {
    return "system-agent";
  }
  return "onboarding";
}

function hasExplicitOnboardingOption(command: Command): boolean {
  return command.options.some((option) => {
    const name = option.attributeName();
    return !SYSTEM_AGENT_OPTION_NAMES.has(name) && command.getOptionValueSource(name) === "cli";
  });
}

async function isConfiguredInstance(): Promise<boolean> {
  const { readConfigFileSnapshot } = await import("../../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists) {
    return false;
  }
  if (!snapshot.valid) {
    return true;
  }
  return !isUnconfiguredConfigSource(snapshot.sourceConfig);
}

async function runSystemAgentEntry(
  options: Record<string, unknown>,
  runtime: RuntimeEnv,
): Promise<void> {
  const { runSystemAgentWithInference } =
    await import("../../commands/system-agent-with-inference.js");
  await runSystemAgentWithInference(
    {
      message: optionalString(options.message),
      yes: Boolean(options.yes),
      json: Boolean(options.json),
    },
    runtime,
  );
}

async function runOnboardingEntry(
  options: Record<string, unknown>,
  commandRuntime: Command,
  runtime: RuntimeEnv,
): Promise<void> {
  if (options.baseline) {
    const { setupCommand } = await import("../../commands/setup.js");
    await setupCommand({ workspace: optionalString(options.workspace) }, runtime);
    return;
  }
  const installDaemon = resolveInstallDaemonFlag(commandRuntime);
  const gatewayPort = parsePort(options.gatewayPort);
  const { setupWizardCommand } = await import("../../commands/onboard.js");
  await setupWizardCommand(
    {
      workspace: optionalString(options.workspace),
      nonInteractive: Boolean(options.nonInteractive),
      acceptRisk: Boolean(options.acceptRisk),
      classic: Boolean(options.classic),
      flow: options.flow as "quickstart" | "advanced" | "manual" | "import" | undefined,
      mode: options.mode as "local" | "remote" | undefined,
      ...pickOnboardAuthOptionValues(options),
      reset: Boolean(options.reset),
      resetScope: options.resetScope as ResetScope | undefined,
      gatewayPort: gatewayPort ?? undefined,
      gatewayBind: options.gatewayBind as GatewayBind | undefined,
      gatewayAuth: options.gatewayAuth as GatewayAuthChoice | undefined,
      gatewayToken: optionalString(options.gatewayToken),
      gatewayTokenRefEnv: optionalString(options.gatewayTokenRefEnv),
      gatewayPassword: optionalString(options.gatewayPassword),
      tailscale: options.tailscale as TailscaleMode | undefined,
      tailscaleResetOnExit: Boolean(options.tailscaleResetOnExit),
      installDaemon,
      daemonRuntime: options.daemonRuntime as GatewayDaemonRuntime | undefined,
      skipChannels: Boolean(options.skipChannels),
      skipSkills: Boolean(options.skipSkills),
      skipBootstrap: Boolean(options.skipBootstrap),
      skipSearch: Boolean(options.skipSearch),
      skipHealth: Boolean(options.skipHealth),
      skipUi: Boolean(options.skipUi),
      suppressGatewayTokenOutput: Boolean(options.suppressGatewayTokenOutput),
      skipHooks: Boolean(options.skipHooks),
      nodeManager: options.nodeManager as NodeManagerChoice | undefined,
      importFrom: optionalString(options.importFrom),
      importSource: optionalString(options.importSource),
      importSecrets: Boolean(options.importSecrets),
      remoteUrl: optionalString(options.remoteUrl),
      remoteToken: optionalString(options.remoteToken),
      json: Boolean(options.json),
    },
    runtime,
  );
}

function addSystemAgentOptions(command: Command): Command {
  return command
    .option("-m, --message <text>", "Run one OpenClaw request")
    .option("--yes", "Approve persistent config writes for one --message request", false)
    .option("--json", "Output system overview or onboarding summary as JSON", false);
}

/** Register the canonical `setup` command and its hidden retired-name alias. */
export function registerSetupCommand(program: Command): void {
  const command = program
    .command("setup")
    .description("Chat with OpenClaw; onboard when setup is incomplete")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n` +
        `  ${theme.command("openclaw setup")}\n` +
        `    ${theme.muted("Chat with OpenClaw, or onboard when setup is incomplete.")}\n` +
        `  ${theme.command('openclaw setup -m "status"')}\n` +
        `    ${theme.muted("Run one system-agent request.")}\n` +
        `  ${theme.command("openclaw setup --wizard")}\n` +
        `    ${theme.muted("Run full onboarding.")}\n\n` +
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
    .option("--daemon-runtime <runtime>", "Daemon runtime: node")
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
    .option("--remote-token <token>", "Remote Gateway token (optional)");

  addSystemAgentOptions(command).action(async (rawOptions, commandRuntime: Command) => {
    const { defaultRuntime } = await import("../../runtime.js");
    await runCommandWithRuntime(defaultRuntime, async () => {
      const options = rawOptions as Record<string, unknown>;
      const hasOnboardingFlag = hasExplicitOnboardingOption(commandRuntime);
      const hasSystemAgentRequest = hasExplicitOptions(commandRuntime, ["message", "yes"]);
      const configured =
        hasOnboardingFlag || hasSystemAgentRequest ? false : await isConfiguredInstance();
      const route = resolveSetupCommandRoute({
        hasOnboardingFlag,
        hasSystemAgentRequest,
        configured,
        interactive: process.stdin.isTTY && process.stdout.isTTY,
        json: Boolean(options.json),
      });
      if (route === "system-agent") {
        await runSystemAgentEntry(options, defaultRuntime);
        return;
      }
      await runOnboardingEntry(options, commandRuntime, defaultRuntime);
    });
  });

  addSystemAgentOptions(
    program
      .command("crestodian", { hidden: true }) // hidden alias
      .description("Deprecated: use openclaw setup"),
  ).action(async (options) => {
    const { defaultRuntime } = await import("../../runtime.js");
    await runCommandWithRuntime(defaultRuntime, async () => {
      await runSystemAgentEntry(options as Record<string, unknown>, defaultRuntime);
    });
  });
}

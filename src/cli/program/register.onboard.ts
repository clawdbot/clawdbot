// Commander registration for onboard setup flags and lazy onboard runtime execution.
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { Option, type Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { formatAuthChoiceChoicesForCli } from "../../commands/auth-choice-options.js";
import type { GatewayDaemonRuntime } from "../../commands/daemon-runtime.js";
import type {
  AuthChoice,
  GatewayAuthChoice,
  GatewayBind,
  NodeManagerChoice,
  OnboardOptions,
  ResetScope,
  SecretInputMode,
  TailscaleMode,
} from "../../commands/onboard-types.js";
import { resolveProviderOnboardAuthFlags } from "../../plugins/provider-auth-choices.js";
import type { RuntimeEnv } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatCliCommand } from "../command-format.js";
import { listExplicitOptionFlagsExcept } from "../command-options.js";
import { parseGatewayPortOption } from "../gateway-port-option.js";

function resolveInstallDaemonFlag(command: Command): boolean | undefined {
  // Commander doesn't support option conflicts natively; keep original behavior.
  // If --skip-daemon is explicitly passed, it wins.
  if (command.getOptionValueSource("skipDaemon") === "cli") {
    return false;
  }
  if (command.getOptionValueSource("installDaemon") === "cli") {
    return Boolean(command.getOptionValue("installDaemon"));
  }
  return undefined;
}

const MODERN_ONBOARD_OPTION_KEYS = new Set([
  "modern",
  "workspace",
  "agentName",
  "acceptRisk",
  "nonInteractive",
  "json",
]);

async function validateRecommendationParentOptions(
  command: Command,
  runtime: RuntimeEnv,
  json = false,
): Promise<boolean> {
  const unsupported = listExplicitOptionFlagsExcept(
    command,
    json ? RECOMMENDATION_READ_PARENT_OPTIONS : NO_RECOMMENDATION_PARENT_OPTIONS,
  );
  if (unsupported.length === 0) {
    return true;
  }
  const { rejectOnboardingOption } = await import("../../commands/onboard-options.js");
  return rejectOnboardingOption(
    { json },
    runtime,
    `This recommendations command does not support parent option(s): ${unsupported.join(", ")}.`,
  );
}

const AUTH_CHOICE_HELP = formatAuthChoiceChoicesForCli({ includeSkip: true });
const RECOMMENDATION_READ_PARENT_OPTIONS = new Set(["json"]);
const NO_RECOMMENDATION_PARENT_OPTIONS = new Set<string>();

type OnboardAuthFlag = {
  readonly cliOption: string;
  readonly description: string;
  readonly optionKey: string;
};

function extractCliFlags(cliOption: string): string[] {
  return cliOption
    .split(/[ ,|]+/)
    .filter((part) => part.startsWith("-"))
    .map((part) => {
      const equalsIndex = part.indexOf("=");
      return equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    });
}

function resolveOnboardAuthFlags(): OnboardAuthFlag[] {
  // Provider manifests can add auth flags; keep duplicate CLI aliases out of Commander.
  const seenCliFlags = new Set<string>();
  const flags: OnboardAuthFlag[] = [];
  for (const flag of resolveProviderOnboardAuthFlags()) {
    const cliFlags = extractCliFlags(flag.cliOption);
    if (cliFlags.some((cliFlag) => seenCliFlags.has(cliFlag))) {
      continue;
    }
    for (const cliFlag of cliFlags) {
      seenCliFlags.add(cliFlag);
    }
    flags.push(flag);
  }
  return flags;
}

const ONBOARD_AUTH_FLAGS = resolveOnboardAuthFlags();

function pickOnboardProviderAuthOptionValues(
  opts: Record<string, unknown>,
): Partial<Record<string, string | undefined>> {
  return Object.fromEntries(
    ONBOARD_AUTH_FLAGS.map((flag) => [flag.optionKey, opts[flag.optionKey] as string | undefined]),
  );
}

export function registerOnboardAuthOptions(command: Command): Command {
  command
    .option("--auth-choice <choice>", `Auth: ${AUTH_CHOICE_HELP}`)
    .option(
      "--token-provider <id>",
      "Token provider id (non-interactive; used with --auth-choice token)",
    )
    .option("--token <token>", "Token value (non-interactive; used with --auth-choice token)")
    .option(
      "--token-profile-id <id>",
      "Auth profile id (non-interactive; default: <provider>:manual)",
    )
    .option("--token-expires-in <duration>", "Optional token expiry duration (e.g. 365d, 12h)")
    .option(
      "--secret-input-mode <mode>",
      "Credential persistence mode: plaintext|ref (default: plaintext)",
    )
    .option("--cloudflare-ai-gateway-account-id <id>", "Cloudflare Account ID")
    .option("--cloudflare-ai-gateway-gateway-id <id>", "Cloudflare AI Gateway ID");

  for (const providerFlag of ONBOARD_AUTH_FLAGS) {
    command.option(providerFlag.cliOption, providerFlag.description);
  }

  return command
    .option("--custom-base-url <url>", "Custom provider base URL")
    .option("--custom-api-key <key>", "Custom provider API key (optional)")
    .option("--custom-model-id <id>", "Custom provider model ID")
    .option("--custom-provider-id <id>", "Custom provider ID (optional; auto-derived by default)")
    .option(
      "--custom-compatibility <mode>",
      "Custom provider API compatibility: openai|openai-responses|anthropic (default: openai)",
    )
    .option("--custom-image-input", "Mark the custom provider model as image-capable")
    .option("--custom-text-input", "Mark the custom provider model as text-only");
}

export function registerOnboardGatewayOptions(command: Command): Command {
  return command
    .option("--gateway-port <port>", "Gateway port")
    .option("--gateway-bind <mode>", "Gateway bind: loopback|tailnet|lan|auto|custom")
    .option("--gateway-auth <mode>", "Gateway auth: token|password")
    .option("--gateway-token <token>", "Gateway token (token auth)")
    .option(
      "--gateway-token-ref-env <name>",
      "Gateway token SecretRef env var name (token auth; e.g. OPENCLAW_GATEWAY_TOKEN)",
    )
    .option("--gateway-password <password>", "Gateway password (password auth)");
}

export function registerOnboardRemoteOptions(command: Command): Command {
  return command
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .option("--remote-password <password>", "Remote Gateway password (optional)");
}

export function registerOnboardRuntimeOptions(
  command: Command,
  variant: "onboard" | "setup",
): Command {
  return command
    .option("--tailscale <mode>", "Tailscale: off|serve|funnel")
    .addOption(new Option("--tailscale-reset-on-exit").hideHelp())
    .addOption(new Option("--no-tailscale-reset-on-exit").hideHelp())
    .option("--install-daemon", "Install gateway service")
    .option("--no-install-daemon", "Skip gateway service install")
    .option("--skip-daemon", "Skip gateway service install")
    .option("--daemon-runtime <runtime>", "Daemon runtime: node|bun (default: node)")
    .option("--skip-channels", "Skip channel setup")
    .option("--skip-skills", "Skip skills setup")
    .option("--skip-bootstrap", "Skip creating default agent workspace files")
    .option("--skip-search", "Skip search provider setup")
    .option("--skip-health", "Skip health check")
    .option(
      "--skip-ui",
      variant === "setup" ? "Skip Control UI/TUI launch" : "Skip Control UI/TUI prompts",
    )
    .option("--suppress-gateway-token-output", "Disable the guided Control UI handoff")
    .option(
      "--skip-hooks",
      variant === "setup"
        ? "Accepted for onboard compatibility; hooks setup is skipped"
        : "Skip hook setup",
    )
    .option("--node-manager <name>", "Node manager for skills: npm|pnpm|bun")
    .option("--import-from <provider>", "Migration provider to run during onboarding")
    .option("--import-source <path>", "Source agent home for --import-from")
    .option("--import-secrets", "Import supported secrets during onboarding migration", false);
}

function pickOnboardAuthOptionValues(opts: Record<string, unknown>): Partial<OnboardOptions> {
  const customTextInput = opts.customTextInput === true;
  return {
    authChoice: opts.authChoice as AuthChoice | undefined,
    tokenProvider: opts.tokenProvider as string | undefined,
    token: opts.token as string | undefined,
    tokenProfileId: opts.tokenProfileId as string | undefined,
    tokenExpiresIn: opts.tokenExpiresIn as string | undefined,
    secretInputMode: opts.secretInputMode as SecretInputMode | undefined,
    ...pickOnboardProviderAuthOptionValues(opts),
    cloudflareAiGatewayAccountId: opts.cloudflareAiGatewayAccountId as string | undefined,
    cloudflareAiGatewayGatewayId: opts.cloudflareAiGatewayGatewayId as string | undefined,
    customBaseUrl: opts.customBaseUrl as string | undefined,
    customApiKey: opts.customApiKey as string | undefined,
    customModelId: opts.customModelId as string | undefined,
    customProviderId: opts.customProviderId as string | undefined,
    customCompatibility: opts.customCompatibility as
      | "openai"
      | "openai-responses"
      | "anthropic"
      | undefined,
    customImageInput: customTextInput ? false : opts.customImageInput === true ? true : undefined,
  };
}

export async function resolveOnboardCommandOptions(
  opts: Record<string, unknown>,
  command: Command,
  runtime: RuntimeEnv,
): Promise<OnboardOptions | false> {
  if (opts.customImageInput === true && opts.customTextInput === true) {
    const { rejectOnboardingOption } = await import("../../commands/onboard-options.js");
    const message = "Use either --custom-image-input or --custom-text-input, not both.";
    return rejectOnboardingOption({ json: opts.json === true }, runtime, message);
  }
  return {
    workspace: readStringValue(opts.workspace),
    agentName: readStringValue(opts.agentName),
    nonInteractive: Boolean(opts.nonInteractive),
    acceptRisk: Boolean(opts.acceptRisk),
    classic: Boolean(opts.classic),
    tui: Boolean(opts.tui),
    flow: opts.flow as "quickstart" | "advanced" | "manual" | "import" | undefined,
    mode: opts.mode as "local" | "remote" | undefined,
    ...pickOnboardAuthOptionValues(opts),
    gatewayPort: parseGatewayPortOption(opts.gatewayPort, "--gateway-port"),
    gatewayBind: opts.gatewayBind as GatewayBind | undefined,
    gatewayAuth: opts.gatewayAuth as GatewayAuthChoice | undefined,
    gatewayToken: readStringValue(opts.gatewayToken),
    gatewayTokenRefEnv: readStringValue(opts.gatewayTokenRefEnv),
    gatewayPassword: readStringValue(opts.gatewayPassword),
    remoteUrl: readStringValue(opts.remoteUrl),
    remoteToken: readStringValue(opts.remoteToken),
    remotePassword: readStringValue(opts.remotePassword),
    tailscale: opts.tailscale as TailscaleMode | undefined,
    reset: Boolean(opts.reset),
    resetScope: opts.resetScope as ResetScope | undefined,
    installDaemon: resolveInstallDaemonFlag(command),
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
    importFrom: readStringValue(opts.importFrom),
    importSource: readStringValue(opts.importSource),
    importSecrets: Boolean(opts.importSecrets),
    json: Boolean(opts.json),
  };
}

export function registerOnboardCommand(program: Command): void {
  const command = program
    .command("onboard")
    .description("Guided setup for auth, models, Gateway, workspace, channels, and skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/onboard", "docs.openclaw.ai/cli/onboard")}\n`,
    )
    .option(
      "--workspace <dir>",
      "Workspace proposal for guided setup; persisted by classic/non-interactive setup",
    )
    .option("--agent-name <name>", "Name for the first agent (default: main)")
    .option(
      "--reset",
      "Reset config + credentials + sessions before running onboard (workspace only with --reset-scope full)",
    )
    .option("--reset-scope <scope>", "Reset scope: config|config+creds+sessions|full")
    .option("--non-interactive", "Run without prompts", false)
    .option("--modern", "Open inference-gated OpenClaw (kept for compatibility)", false)
    .option("--classic", "Use the classic multi-step setup wizard", false)
    .option("--tui", "Use the terminal hatch instead of the browser handoff", false)
    .option(
      "--accept-risk",
      "Acknowledge that agents are powerful and full system access is risky (required for --non-interactive)",
      false,
    )
    .option("--flow <flow>", "Onboard flow: quickstart|advanced|manual|import")
    .option("--mode <mode>", "Onboard mode: local|remote");

  registerOnboardAuthOptions(command);
  registerOnboardGatewayOptions(command);
  registerOnboardRemoteOptions(command);
  registerOnboardRuntimeOptions(command, "onboard");
  command.option("--json", "Output JSON summary", false);

  const recommendations = command
    .command("recommendations")
    .description("Read the app recommendations stored during onboarding")
    .option("--json", "Output stored recommendation matches as JSON", false)
    .action(async (opts, recommendationsCommand: Command) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const json = Boolean(opts.json || recommendationsCommand.parent?.opts().json);
        if (!(await validateRecommendationParentOptions(command, defaultRuntime, json))) {
          return;
        }
        const { onboardRecommendationsCommand } =
          await import("../../commands/onboard-recommendations.js");
        onboardRecommendationsCommand({ json }, defaultRuntime);
      });
    });

  recommendations
    .command("acknowledge")
    .description("Mark the stored onboarding recommendation offer as answered")
    .option("--retry <id...>", "Leave failed recommendation IDs pending for a later run")
    .action(async (opts: { retry?: string[] }) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        if (
          !(await validateRecommendationParentOptions(command, defaultRuntime)) ||
          !(await validateRecommendationParentOptions(recommendations, defaultRuntime))
        ) {
          return;
        }
        const { acknowledgeOnboardRecommendationsCommand } =
          await import("../../commands/onboard-recommendations.js");
        acknowledgeOnboardRecommendationsCommand({ retry: opts.retry }, defaultRuntime);
      });
    });

  recommendations
    .command("refresh")
    .description("Clear stored app recommendations so the next onboarding run rescans")
    .action(async () => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        if (
          !(await validateRecommendationParentOptions(command, defaultRuntime)) ||
          !(await validateRecommendationParentOptions(recommendations, defaultRuntime))
        ) {
          return;
        }
        const { refreshOnboardRecommendationsCommand } =
          await import("../../commands/onboard-recommendations.js");
        refreshOnboardRecommendationsCommand(defaultRuntime);
      });
    });

  command.action(async (opts, commandRuntime: Command) => {
    const { defaultRuntime } = await import("../../runtime.js");
    await runCommandWithRuntime(defaultRuntime, async () => {
      const { rejectOnboardingOption } = await import("../../commands/onboard-options.js");
      const rejectOption = (message: string) =>
        rejectOnboardingOption({ json: Boolean(opts.json) }, defaultRuntime, message);
      if (opts.modern) {
        const unsupportedOptions = listExplicitOptionFlagsExcept(
          commandRuntime,
          MODERN_ONBOARD_OPTION_KEYS,
        );
        if (unsupportedOptions.length > 0) {
          rejectOption(
            [
              `--modern cannot be combined with: ${unsupportedOptions.join(", ")}.`,
              "Run those setup options without --modern, or remove them to open OpenClaw.",
            ].join("\n"),
          );
          return;
        }
        if (opts.nonInteractive && opts.acceptRisk !== true) {
          rejectOption(
            [
              "Non-interactive setup requires explicit risk acknowledgement.",
              "Read: https://docs.openclaw.ai/security",
              `Re-run with: ${formatCliCommand("openclaw onboard --modern --non-interactive --accept-risk ...")}`,
            ].join("\n"),
          );
          return;
        }
        const { runSystemAgentWithInference } =
          await import("../../commands/system-agent-with-inference.js");
        await runSystemAgentWithInference(
          {
            yes: false,
            json: Boolean(opts.json),
            interactive: !opts.nonInteractive,
            welcomeVariant: "onboarding",
            ...(opts.workspace ? { setupWorkspace: opts.workspace as string } : {}),
            ...(opts.agentName ? { setupAgentName: opts.agentName as string } : {}),
          },
          defaultRuntime,
          {
            ...(opts.workspace ? { workspace: opts.workspace as string } : {}),
            ...(opts.agentName ? { agentName: opts.agentName as string } : {}),
            ...(opts.acceptRisk ? { acceptRisk: true } : {}),
          },
        );
        return;
      }
      const onboardingOptions = await resolveOnboardCommandOptions(
        opts as Record<string, unknown>,
        commandRuntime,
        defaultRuntime,
      );
      if (!onboardingOptions) {
        return;
      }
      const { setupWizardCommand } = await import("../../commands/onboard.js");
      await setupWizardCommand(onboardingOptions, defaultRuntime);
    });
  });
}

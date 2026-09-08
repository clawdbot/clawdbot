import { readStringValue } from "@openclaw/normalization-core/string-coerce";
// Setup command registration: system-agent chat for configured systems, onboarding otherwise.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { RuntimeEnv } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions, listExplicitOptionFlagsExcept } from "../command-options.js";
import { shouldStartLocalOnboarding } from "../fresh-install-config.js";
import {
  registerOnboardAuthOptions,
  registerOnboardGatewayOptions,
  registerOnboardRemoteOptions,
  registerOnboardRuntimeOptions,
  resolveOnboardCommandOptions,
} from "./register.onboard.js";

const SYSTEM_AGENT_OPTION_NAMES = new Set(["message", "yes", "json"]);
const BASELINE_OPTION_NAMES = new Set(["baseline", "workspace", "json"]);

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

async function runSystemAgentEntry(
  options: Record<string, unknown>,
  runtime: RuntimeEnv,
): Promise<void> {
  const { runSystemAgentWithInference } =
    await import("../../commands/system-agent-with-inference.js");
  await runSystemAgentWithInference(
    {
      message: readStringValue(options.message),
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
    const unsupportedOptions = listExplicitOptionFlagsExcept(commandRuntime, BASELINE_OPTION_NAMES);
    if (unsupportedOptions.length > 0) {
      const { rejectOnboardingOption } = await import("../../commands/onboard-options.js");
      const message = `--baseline cannot be combined with: ${unsupportedOptions.join(", ")}.`;
      rejectOnboardingOption({ json: options.json === true }, runtime, message);
      return;
    }
    const { setupCommand } = await import("../../commands/setup.js");
    await setupCommand(
      { workspace: readStringValue(options.workspace), json: Boolean(options.json) },
      runtime,
    );
    return;
  }
  const onboardingOptions = await resolveOnboardCommandOptions(options, commandRuntime, runtime);
  if (!onboardingOptions) {
    return;
  }
  const { setupWizardCommand } = await import("../../commands/onboard.js");
  await setupWizardCommand(onboardingOptions, runtime);
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
    .option("--agent-name <name>", "Name for the first agent (default: main)")
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
  registerOnboardRuntimeOptions(command, "setup");
  registerOnboardRemoteOptions(command);

  addSystemAgentOptions(command).action(async (rawOptions, commandRuntime: Command) => {
    const { defaultRuntime } = await import("../../runtime.js");
    await runCommandWithRuntime(defaultRuntime, async () => {
      const options = rawOptions as Record<string, unknown>;
      const hasOnboardingFlag = hasExplicitOnboardingOption(commandRuntime);
      const hasSystemAgentRequest = hasExplicitOptions(commandRuntime, ["message", "yes"]);
      let configured = false;
      if (!hasOnboardingFlag && !hasSystemAgentRequest) {
        const { readConfigFileSnapshot } = await import("../../config/config.js");
        configured = !(await shouldStartLocalOnboarding(await readConfigFileSnapshot()));
      }
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

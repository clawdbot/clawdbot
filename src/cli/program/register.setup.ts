import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { hasExplicitOptions } from "../command-options.js";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Create baseline config/workspace files; use --wizard for full onboarding")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n` +
        `  ${theme.command("openclaw setup")}\n` +
        `    ${theme.muted("Create config, workspace, and session folders.")}\n` +
        `  ${theme.command("openclaw setup --wizard")}\n` +
        `    ${theme.muted("Run full onboarding for auth, models, Gateway, and channels.")}\n\n` +
        `${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`,
    )
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)",
    )
    .option("--wizard", "Run interactive onboarding", false)
    .option("--non-interactive", "Run onboarding without prompts", false)
    .option(
      "--accept-risk",
      "Acknowledge that agents are powerful and full system access is risky (required for --non-interactive)",
      false,
    )
    .option("--mode <mode>", "Onboard mode: local|remote")
    .option("--import-from <provider>", "Migration provider to run during onboarding")
    .option("--import-source <path>", "Source agent home for --import-from")
    .option("--import-secrets", "Import supported secrets during onboarding migration", false)
    .option("--remote-url <url>", "Remote Gateway WebSocket URL")
    .option("--remote-token <token>", "Remote Gateway token (optional)")
    .action(async (opts, command) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const hasWizardFlags = hasExplicitOptions(command, [
          "wizard",
          "nonInteractive",
          "acceptRisk",
          "mode",
          "importFrom",
          "importSource",
          "importSecrets",
          "remoteUrl",
          "remoteToken",
        ]);
        if (opts.wizard || hasWizardFlags) {
          const { setupWizardCommand } = await import("../../commands/onboard.js");
          await setupWizardCommand(
            {
              workspace: opts.workspace as string | undefined,
              nonInteractive: Boolean(opts.nonInteractive),
              acceptRisk: Boolean(opts.acceptRisk),
              mode: opts.mode as "local" | "remote" | undefined,
              importFrom: opts.importFrom as string | undefined,
              importSource: opts.importSource as string | undefined,
              importSecrets: Boolean(opts.importSecrets),
              remoteUrl: opts.remoteUrl as string | undefined,
              remoteToken: opts.remoteToken as string | undefined,
            },
            defaultRuntime,
          );
          return;
        }
        const { setupCommand } = await import("../../commands/setup.js");
        await setupCommand({ workspace: opts.workspace as string | undefined }, defaultRuntime);
      });
    });
}

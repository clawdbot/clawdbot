import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { inheritOptionFromParent } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";
import {
  type UpdateCommandOptions,
  type UpdateStatusOptions,
  type UpdateWizardOptions,
} from "./update-cli/shared.js";
import { updateStatusCommand } from "./update-cli/status.js";
import { updateCommand } from "./update-cli/update-command.js";
import { updateWizardCommand } from "./update-cli/wizard.js";

export { updateCommand, updateStatusCommand, updateWizardCommand };
export type { UpdateCommandOptions, UpdateStatusOptions, UpdateWizardOptions };

function inheritedUpdateJson(command?: Command): boolean {
  return Boolean(inheritOptionFromParent<boolean>(command, "json"));
}

function inheritedUpdateTimeout(
  opts: { timeout?: unknown },
  command?: Command,
): string | undefined {
  const timeout = opts.timeout as string | undefined;
  if (timeout) {
    return timeout;
  }
  return inheritOptionFromParent<string>(command, "timeout");
}

export function registerUpdateCli(program: Command) {
  program.enablePositionalOptions();
  const update = program
    .command("update")
    .description("Update OpenClaw and inspect update channel status")
    .option("--json", "Output result as JSON", false)
    .option("--no-restart", "Skip restarting the gateway service after a successful update")
    .option("--dry-run", "Preview update actions without making changes", false)
    .option("--channel <stable|beta|dev>", "Persist update channel (git + npm)")
    .option(
      "--tag <dist-tag|version|spec>",
      "Override the package target for this update (dist-tag, version, or package spec)",
    )
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1800)")
    .option("--yes", "Skip confirmation prompts (non-interactive)", false)
    .addHelpText("after", () => {
      const examples = [
        ["openclaw update", "Update a source checkout (git)"],
        ["openclaw update --channel beta", "Switch to beta channel (git + npm)"],
        ["openclaw update --channel dev", "Switch to dev channel (git + npm)"],
        ["openclaw update --tag beta", "One-off update to a dist-tag or version"],
        ["openclaw update --tag main", "One-off package install from GitHub main"],
        ["openclaw update --dry-run", "Preview actions without changing anything"],
        ["openclaw update --no-restart", "Update without restarting the service"],
        ["openclaw update --json", "Output result as JSON"],
        ["openclaw update --yes", "Non-interactive (accept downgrade prompts)"],
        ["openclaw update wizard", "Interactive update wizard"],
        ["openclaw --update", "Shorthand for openclaw update"],
      ] as const;
      const fmtExamples = examples
        .map(([cmd, desc]) => `  ${theme.command(cmd)} ${theme.muted(`# ${desc}`)}`)
        .join("\n");
      return `
${theme.heading("What this does:")}
  - Git checkouts: fetches, rebases, installs deps, builds, and runs doctor
  - npm installs: updates via detected package manager

${theme.heading("Switch channels:")}
  - Use --channel stable|beta|dev to persist the update channel in config
  - Run openclaw update status to see the active channel and source
  - Use --tag <dist-tag|version|spec> for a one-off package update without persisting

${theme.heading("Non-interactive:")}
  - Use --yes to accept downgrade prompts
  - Combine with --channel/--tag/--no-restart/--json/--timeout as needed
  - Use --dry-run to preview actions without writing config/installing/restarting

${theme.heading("Examples:")}
${fmtExamples}

${theme.heading("Notes:")}
  - Switch channels with --channel stable|beta|dev
  - For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)
  - Downgrades require confirmation (can break configuration)
  - Skips update if the working directory has uncommitted changes

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`;
    })
    .action(async (opts) => {
      try {
        await updateCommand({
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          dryRun: Boolean(opts.dryRun),
          channel: opts.channel as string | undefined,
          tag: opts.tag as string | undefined,
          timeout: opts.timeout as string | undefined,
          yes: Boolean(opts.yes),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("wizard")
    .description("Interactive update wizard")
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1800)")
    .addHelpText(
      "after",
      `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}\n`,
    )
    .action(async (opts, command) => {
      try {
        await updateWizardCommand({
          timeout: inheritedUpdateTimeout(opts, command),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  update
    .command("status")
    .description("Show update channel and version status")
    .option("--json", "Output result as JSON", false)
    .option("--timeout <seconds>", "Timeout for update checks in seconds (default: 3)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw update status", "Show channel + version status."],
          ["openclaw update status --json", "JSON output."],
          ["openclaw update status --timeout 10", "Custom timeout."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- Shows current update channel (stable/beta/dev) and source",
        )}\n${theme.muted("- Includes git tag/branch/SHA for source checkouts")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    )
    .action(async (opts, command) => {
      try {
        await updateStatusCommand({
          json: Boolean(opts.json) || inheritedUpdateJson(command),
          timeout: inheritedUpdateTimeout(opts, command),
        });
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}

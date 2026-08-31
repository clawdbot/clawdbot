// Commander wiring for `openclaw update`, its status/finalize subcommands, and help text.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../infra/errors.js";
import { POST_CORE_UPDATE_ENV } from "../infra/update-post-core-context.js";
import { defaultRuntime } from "../runtime.js";
import { inheritOptionFromParent } from "./command-options.js";
import { formatHelpExamples } from "./help-format.js";
import { isJsonOutputModeActive } from "./json-output-mode.js";
import type {
  UpdateCommandOptions,
  UpdateFinalizeOptions,
  UpdateStatusOptions,
  UpdateWizardOptions,
} from "./update-cli/shared.js";
export type {
  UpdateCommandOptions,
  UpdateFinalizeOptions,
  UpdateStatusOptions,
  UpdateWizardOptions,
};

function inheritedUpdateJson(command?: Command): boolean {
  return Boolean(inheritOptionFromParent<boolean>(command, "json"));
}

function handleUpdateCommandError(error: unknown): void {
  if (isJsonOutputModeActive(process.argv)) {
    throw error;
  }
  defaultRuntime.error(formatErrorMessage(error));
  defaultRuntime.exit(1);
}

function inheritedUpdateTimeout(
  opts: { timeout?: unknown },
  command?: Command,
): string | undefined {
  const timeout = opts.timeout as string | undefined;
  if (timeout !== undefined) {
    return timeout;
  }
  return inheritOptionFromParent<string>(command, "timeout");
}

type CommanderUpdateOptions = Record<string, unknown> & {
  acceptCapabilities?: boolean;
  channel?: string;
  dryRun?: boolean;
  json?: boolean;
  restart?: boolean;
  tag?: string;
  timeout?: string;
  yes?: boolean;
};

// Every update leaf must reject the parent-only dry-run flag before owner work starts.
// Keeping that policy in the shared action wrapper prevents a new leaf from silently ignoring it.
function createUpdateLeafAction(
  action: (opts: Record<string, unknown>, command: Command) => Promise<void>,
) {
  return async (opts: Record<string, unknown>, command: Command) => {
    try {
      if (inheritOptionFromParent<boolean>(command, "dryRun")) {
        throw new Error(
          `--dry-run is not supported for \`openclaw update ${command.name()}\`. Run \`openclaw update --dry-run\` instead.`,
        );
      }
      await action(opts, command);
    } catch (err) {
      handleUpdateCommandError(err);
    }
  };
}

function registerUpdateFinalizationCommand(update: Command, name: string, hidden: boolean) {
  const command = update.command(name, { hidden });
  command
    .description("Repair post-update doctor and plugin convergence")
    .option("--json", "Output result as JSON", false)
    .option("--channel <stable|extended-stable|beta|dev>", "Persist update channel before repair")
    .option("--timeout <seconds>", "Timeout for update repair steps in seconds (default: 1800)")
    .option("--yes", "Skip confirmation prompts (non-interactive)", false)
    .option("--accept-capabilities", "Accept widened plugin capabilities", false)
    .option("--no-restart", "Accepted for update command parity; repair never restarts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw update repair", "Rerun post-update doctor and plugin convergence."],
          [
            "openclaw update repair --accept-capabilities",
            "Accept reviewed plugin capability changes during repair.",
          ],
          ["openclaw update repair --channel beta", "Repair against the beta update channel."],
          ["openclaw update repair --json", "JSON output for automation."],
        ])}\n\n${theme.heading("Notes:")}\n${theme.muted(
          "- Repairs post-update plugin state after the core package already changed",
        )}\n${theme.muted("- Runs doctor repair and plugin convergence, but never restarts the Gateway")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    )
    .action(
      createUpdateLeafAction(async (opts, actionCommand) => {
        const { updateFinalizeCommand } = await import("./update-cli/update-command-finalize.js");
        await updateFinalizeCommand({
          json: Boolean(opts.json) || inheritedUpdateJson(actionCommand),
          channel:
            (opts.channel as string | undefined) ??
            inheritOptionFromParent<string>(actionCommand, "channel"),
          timeout: inheritedUpdateTimeout(opts, actionCommand),
          yes: Boolean(opts.yes) || Boolean(inheritOptionFromParent<boolean>(actionCommand, "yes")),
          acceptCapabilities:
            Boolean(opts.acceptCapabilities) ||
            Boolean(inheritOptionFromParent<boolean>(actionCommand, "acceptCapabilities")),
          restart: false,
          deferCompletionCache: hidden && process.env[POST_CORE_UPDATE_ENV]?.trim() === "1",
        });
      }),
    );
}

/** Attach the update command group to the root CLI. */
export function registerUpdateCli(program: Command) {
  program.enablePositionalOptions();
  const update = program
    .command("update")
    .description("Update OpenClaw and inspect update channel status")
    .option("--json", "Output result as JSON", false)
    .option("--no-restart", "Skip restarting the gateway service after a successful update")
    .option("--dry-run", "Preview update actions without making changes", false)
    .option("--channel <stable|extended-stable|beta|dev>", "Persist update channel (git + npm)")
    .option(
      "--tag <dist-tag|version|spec>",
      "Override the package target for this update (dist-tag, version, or package spec)",
    )
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1800)")
    .option("--yes", "Skip confirmation prompts (non-interactive)", false)
    .option("--accept-capabilities", "Accept widened plugin capabilities", false)
    .addHelpText("after", () => {
      const examples = [
        ["openclaw update", "Update a source checkout (git)"],
        [
          "openclaw update --channel extended-stable",
          "Switch to the monthly supported npm channel",
        ],
        ["openclaw update --channel beta", "Switch to beta channel (git + npm)"],
        ["openclaw update --channel dev", "Switch to dev channel (git + npm)"],
        ["openclaw update --tag beta", "One-off update to a dist-tag or version"],
        ["openclaw update --dry-run", "Preview actions without changing anything"],
        ["openclaw update --no-restart", "Update without restarting the service"],
        ["openclaw update --json", "Output result as JSON"],
        ["openclaw update --yes", "Non-interactive (accept downgrade prompts)"],
        ["openclaw update --accept-capabilities", "Accept reviewed plugin capability changes"],
        ["openclaw update repair", "Repair stranded post-update plugin state"],
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
  - Use --channel stable|extended-stable|beta|dev to persist the update channel in config
  - Run openclaw update status to see the active channel and source
  - Use --tag <dist-tag|version|spec> for a one-off package update without persisting
  - Use --channel dev for the moving GitHub main checkout; package installs reject --tag main

${theme.heading("Non-interactive:")}
  - Use --yes to accept downgrade prompts
  - Use --accept-capabilities to accept each plugin's reviewed capability changes
  - Combine with --channel/--tag/--no-restart/--json/--timeout as needed
  - Use --dry-run to preview actions without writing config/installing/restarting

${theme.heading("Examples:")}
${fmtExamples}

${theme.heading("Notes:")}
  - Switch channels with --channel stable|extended-stable|beta|dev
  - For global installs: auto-updates via detected package manager when possible (see docs/install/updating.md)
  - Downgrades require confirmation (can break configuration)
  - Skips update if the working directory has uncommitted changes

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`;
    })
    .action(async (opts: CommanderUpdateOptions) => {
      try {
        const { updateCommand } = await import("./update-cli/update-command.js");
        await updateCommand({
          json: Boolean(opts.json),
          restart: Boolean(opts.restart),
          dryRun: Boolean(opts.dryRun),
          channel: opts.channel,
          tag: opts.tag,
          timeout: opts.timeout,
          yes: Boolean(opts.yes),
          acceptCapabilities: Boolean(opts.acceptCapabilities),
        });
      } catch (err) {
        handleUpdateCommandError(err);
      }
    });

  registerUpdateFinalizationCommand(update, "repair", false);
  registerUpdateFinalizationCommand(update, "finalize", true);

  update
    .command("wizard")
    .description("Interactive update wizard")
    .option("--accept-capabilities", "Accept widened plugin capabilities", false)
    .option("--timeout <seconds>", "Timeout for each update step in seconds (default: 1800)")
    .addHelpText(
      "after",
      `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}\n`,
    )
    .action(
      createUpdateLeafAction(async (opts, command) => {
        const { updateWizardCommand } = await import("./update-cli/wizard.js");
        await updateWizardCommand({
          timeout: inheritedUpdateTimeout(opts, command),
          acceptCapabilities:
            Boolean(opts.acceptCapabilities) ||
            Boolean(inheritOptionFromParent<boolean>(command, "acceptCapabilities")),
        });
      }),
    );

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
          "- Shows current update channel (stable/extended-stable/beta/dev) and source",
        )}\n${theme.muted("- Includes git tag/branch/SHA for source checkouts")}\n\n${theme.muted(
          "Docs:",
        )} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    )
    .action(
      createUpdateLeafAction(async (opts, command) => {
        const { updateStatusCommand } = await import("./update-cli/status.js");
        await updateStatusCommand({
          json: Boolean(opts.json) || inheritedUpdateJson(command),
          timeout: inheritedUpdateTimeout(opts, command),
        });
      }),
    );
}

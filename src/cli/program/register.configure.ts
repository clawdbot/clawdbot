// Configure command registration: lazy-loads the interactive configuration wizard.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { CONFIGURE_WIZARD_SECTIONS } from "../../commands/configure.shared.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the interactive `configure` command and section filter flag. */
export function registerConfigureCommand(program: Command): void {
  program
    .command("configure")
    .description("Interactive configuration for credentials, channels, gateway, and agent defaults")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/configure", "docs.openclaw.ai/cli/configure")}\n`,
    )
    .option(
      "--section <section>",
      `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`,
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--agent <id>",
      "Agent that owns this configuration (required when agents.ownership is explicit and no System Agent is set)",
    )
    .action(async (opts) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { configureCommandFromSectionsArg } =
          await import("../../commands/configure.commands.js");
        // Presence, not truthiness: `--agent ""` must reach validation instead of being
        // dropped and silently resolving to the default owner.
        await configureCommandFromSectionsArg(
          opts.section,
          defaultRuntime,
          opts.agent === undefined ? {} : { agentId: String(opts.agent) },
        );
      });
    });
}

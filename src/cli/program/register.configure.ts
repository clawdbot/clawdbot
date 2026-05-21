import type { Command } from "commander";
import { CONFIGURE_WIZARD_SECTIONS } from "../../commands/configure.shared.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";

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
    .action(async (opts) => {
      const { defaultRuntime } = await import("../../runtime.js");
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { configureCommandFromSectionsArg } =
          await import("../../commands/configure.commands.js");
        await configureCommandFromSectionsArg(opts.section, defaultRuntime);
      });
    });
}

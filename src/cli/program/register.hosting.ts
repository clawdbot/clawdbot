import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

/** Register read-only hosting contract discovery commands. */
export function registerHostingCommands(program: Command): void {
  const hosting = program
    .command("hosting")
    .description("Inspect OpenClaw hosting contracts")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/gateway/hosting-profiles", "docs.openclaw.ai/gateway/hosting-profiles")}\n`,
    );
  const profiles = hosting
    .command("profiles")
    .description("Inspect standard hosting profile definitions");

  profiles
    .command("list")
    .description("List standard hosting profiles")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw hosting profiles list", "List supported runtime postures."],
          ["openclaw hosting profiles list --json", "Output the versioned profile catalog."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { hostingProfilesListCommand } = await import("../../commands/hosting-profiles.js");
        hostingProfilesListCommand({ json: Boolean(opts.json) }, defaultRuntime);
      });
    });

  profiles
    .command("inspect <id>")
    .description("Inspect one standard hosting profile")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw hosting profiles inspect container", "Show container profile requirements."],
          [
            "openclaw hosting profiles inspect node-mode --json",
            "Output one versioned profile descriptor.",
          ],
        ])}`,
    )
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { hostingProfilesInspectCommand } =
          await import("../../commands/hosting-profiles.js");
        hostingProfilesInspectCommand(String(id), { json: Boolean(opts.json) }, defaultRuntime);
      });
    });
}

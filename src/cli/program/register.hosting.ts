import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { parseTimeoutMsWithFallback } from "../parse-timeout.js";

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

  profiles
    .command("validate [id]")
    .description("Validate the active profile through canonical Gateway readiness")
    .option("--json", "Output JSON", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw hosting profiles validate", "Validate the active profile."],
          [
            "openclaw hosting profiles validate container --json",
            "Require container profile and output conformance evidence.",
          ],
        ])}`,
    )
    .action(async (id, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const { hostingProfilesValidateCommand } =
          await import("../../commands/hosting-profiles.js");
        await hostingProfilesValidateCommand(
          id === undefined ? undefined : String(id),
          {
            json: Boolean(opts.json),
            timeoutMs: parseTimeoutMsWithFallback(opts.timeout, 10_000, {
              invalidType: "error",
            }),
          },
          defaultRuntime,
        );
      });
    });
}

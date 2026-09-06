// Registers the recent-session resume verb while keeping its TUI runtime lazy.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { addTuiOptions } from "./tui-cli-options.js";

export type ResumeCliOptions = {
  handoff?: string;
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
};

/** Register the Gateway-backed session resume command. */
export function registerResumeCli(program: Command) {
  const command = program
    .command("resume")
    .description("Resume a recent Gateway session in the TUI")
    .argument("[query]", "Session key, display name, or label")
    .option("--handoff <payload>", "Opaque session handoff copied from the Control UI");
  addTuiOptions(command)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/resume", "docs.openclaw.ai/cli/resume")}\n`,
    )
    .action(async (query: string | undefined, opts: ResumeCliOptions) => {
      try {
        const { runResumeCommand } = await import("./resume-cli.runtime.js");
        await runResumeCommand(query, opts);
      } catch (error) {
        defaultRuntime.error(formatErrorMessage(error));
        defaultRuntime.exit(1);
      }
    });
}

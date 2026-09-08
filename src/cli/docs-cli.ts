// Commander registration for live OpenClaw docs search.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { docsSearchCommand } from "../commands/docs.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";

export function registerDocsCli(program: Command) {
  program
    .command("docs")
    .description("Search the live OpenClaw docs")
    .argument("[query...]", "Search query")
    .option("--json", "Output JSON", false)
    .option("--limit <count>", "Maximum results to return", (value: string) =>
      parseStrictPositiveIntOption(value, "--limit"),
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/docs", "docs.openclaw.ai/cli/docs")}\n`,
    )
    .action(async (queryParts: string[], opts: { json?: boolean; limit?: number }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await docsSearchCommand(queryParts, defaultRuntime, {
          json: Boolean(opts.json),
          limit: opts.limit,
        });
      });
    });
}

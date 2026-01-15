import type { Command } from "commander";

import { docsSearchCommand } from "../commands/docs.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerDocsCli(program: Command) {
  program
    .command("docs")
    .description("Search the live Clawdbot docs")
    .argument("[query...]", "Search query")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/docs", "docs.clawd.bot/cli/docs")}\n`,
    )
    .action(async (queryParts: string[]) => {
      try {
        await docsSearchCommand(queryParts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}

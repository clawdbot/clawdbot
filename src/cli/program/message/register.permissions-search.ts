import type { Command } from "commander";
import { collectOption } from "../helpers.js";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessagePermissionsCommand(
  message: Command,
  helpers: MessageCliHelpers,
) {
  helpers
    .withMessageBase(
      helpers.withMessageTarget(
        message.command("permissions").description("Fetch channel permissions"),
      ),
    )
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await helpers.runMessageAction("permissions", opts);
    });
}

export function registerMessageSearchCommand(
  message: Command,
  helpers: MessageCliHelpers,
) {
  helpers
    .withMessageBase(
      message.command("search").description("Search Discord messages"),
    )
    .requiredOption("--guild-id <id>", "Guild id")
    .requiredOption("--query <text>", "Search query")
    .option("--channel-id <id>", "Channel id")
    .option(
      "--channel-ids <id>",
      "Channel id (repeat)",
      collectOption,
      [] as string[],
    )
    .option("--author-id <id>", "Author id")
    .option(
      "--author-ids <id>",
      "Author id (repeat)",
      collectOption,
      [] as string[],
    )
    .option("--limit <n>", "Result limit")
    .action(async (opts) => {
      await helpers.runMessageAction("search", opts);
    });
}

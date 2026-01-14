import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageReadEditDeleteCommands(
  message: Command,
  helpers: MessageCliHelpers,
) {
  helpers
    .withMessageBase(
      helpers.withMessageTarget(
        message.command("read").description("Read recent messages"),
      ),
    )
    .option("--limit <n>", "Result limit")
    .option("--before <id>", "Read/search before id")
    .option("--after <id>", "Read/search after id")
    .option("--around <id>", "Read around id")
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .option("--include-thread", "Include thread replies (Discord)", false)
    .action(async (opts) => {
      await helpers.runMessageAction("read", opts);
    });

  helpers
    .withMessageBase(
      helpers.withMessageTarget(
        message
          .command("edit")
          .description("Edit a message")
          .requiredOption("--message-id <id>", "Message id")
          .requiredOption("-m, --message <text>", "Message body"),
      ),
    )
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .option("--thread-id <id>", "Thread id (Telegram forum thread)")
    .action(async (opts) => {
      await helpers.runMessageAction("edit", opts);
    });

  helpers
    .withMessageBase(
      helpers.withMessageTarget(
        message
          .command("delete")
          .description("Delete a message")
          .requiredOption("--message-id <id>", "Message id"),
      ),
    )
    .option("--channel-id <id>", "Channel id (defaults to --to)")
    .action(async (opts) => {
      await helpers.runMessageAction("delete", opts);
    });
}

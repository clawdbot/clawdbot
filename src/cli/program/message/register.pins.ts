import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessagePinCommands(
  message: Command,
  helpers: MessageCliHelpers,
) {
  const withPinsTarget = (command: Command) =>
    command.option(
      "--channel-id <id>",
      "Channel id (defaults to --to; required for WhatsApp)",
    );

  const pins = [
    helpers
      .withMessageBase(
        withPinsTarget(
          helpers.withMessageTarget(
            message.command("pin").description("Pin a message"),
          ),
        ),
      )
      .requiredOption("--message-id <id>", "Message id")
      .action(async (opts) => {
        await helpers.runMessageAction("pin", opts);
      }),
    helpers
      .withMessageBase(
        withPinsTarget(
          helpers.withMessageTarget(
            message.command("unpin").description("Unpin a message"),
          ),
        ),
      )
      .requiredOption("--message-id <id>", "Message id")
      .action(async (opts) => {
        await helpers.runMessageAction("unpin", opts);
      }),
    helpers
      .withMessageBase(
        helpers.withMessageTarget(
          message.command("pins").description("List pinned messages"),
        ),
      )
      .option("--channel-id <id>", "Channel id (defaults to --to)")
      .option("--limit <n>", "Result limit")
      .action(async (opts) => {
        await helpers.runMessageAction("list-pins", opts);
      }),
  ] as const;

  void pins;
}

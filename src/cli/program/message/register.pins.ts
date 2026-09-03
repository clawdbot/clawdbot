// Pin command registration for pin, unpin, and list-pins actions.
import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

/** Register message pin management commands. */
export function registerMessagePinCommands(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(message.command("pin").description("Pin a message")),
    )
    .requiredOption("--message-id <id>", "Message id")
    .action((opts) => helpers.runMessageAction("pin", opts));

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(message.command("unpin").description("Unpin a message")),
    )
    .requiredOption("--message-id <id>", "Message id (or pinned message resource id for MSTeams)")
    .option(
      "--pinned-message-id <id>",
      "Pinned message resource id (MSTeams: from pin or list-pins, not the chat message id)",
    )
    .action((opts) => helpers.runMessageAction("unpin", opts));

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(
        message.command("pins").description("List pinned messages"),
      ),
    )
    .option("--limit <n>", "Result limit")
    .action((opts) => helpers.runMessageAction("list-pins", opts));
}

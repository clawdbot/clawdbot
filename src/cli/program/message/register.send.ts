import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

export function registerMessageSendCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers
        .withRequiredMessageTarget(
          message
            .command("send")
            .description("Send a message")
            .option("-m, --message <text>", "Message body (required unless --media is set)"),
        )
        .option(
          "--media <path-or-url>",
          "Attach media (image/audio/video/document). Accepts local paths or URLs.",
        )
        .option(
          "--presentation <json>",
          "Shared presentation payload as JSON (text, context, dividers, buttons, selects)",
        )
        .option("--delivery <json>", "Shared delivery preferences as JSON")
        .option("--pin", "Request that the delivered message be pinned when supported", false)
        .option("--reply-to <id>", "Reply-to message id")
        .option("--thread-id <id>", "Thread id (Telegram forum thread)")
        .option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false)
        .option(
          "--force-document",
          "Send media as document to avoid Telegram compression (Telegram only). Applies to images and GIFs.",
          false,
        )
        .option(
          "--silent",
          "Send message silently without notification (Telegram + Discord)",
          false,
        ),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("send", opts);
    });
}

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
          "--buttons <json>",
          "Telegram inline keyboard buttons as JSON (array of button rows)",
        )
        .option("--card <json>", "Adaptive Card JSON object (when supported by the channel)")
        .option("--reply-to <id>", "Reply-to message id")
        .option("--thread-id <id>", "Thread id (Telegram forum thread)")
        .option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false)
        .option("--silent", "Send message silently without notification (Telegram only)", false),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("send", opts);
    });
}

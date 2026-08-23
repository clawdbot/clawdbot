// Poll command registration for channel-backed poll creation.
import type { Command } from "commander";
import { collectOption } from "../helpers.js";
import type { MessageCliHelpers } from "./helpers.js";

/** Register `message poll` and validate poll-specific flags through the shared action path. */
export function registerMessagePollCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(message.command("poll").description("Send a poll")),
    )
    .requiredOption("--poll-question <text>", "Poll question")
    .option(
      "--poll-option <choice>",
      "Poll option (repeat 2-12 times)",
      collectOption,
      [] as string[],
    )
    .option("--poll-multi", "Allow multiple selections", false)
    .option("--poll-duration-hours <n>", "Poll duration in hours (Discord)")
    .option("--poll-duration-seconds <n>", "Poll duration in seconds (Telegram; 5-600)")
    .option("--poll-anonymous", "Send an anonymous poll (Telegram)", false)
    .option("--poll-public", "Send a non-anonymous poll (Telegram)", false)
    .option("-m, --message <text>", "Optional message body")
    .option(
      "--silent",
      "Send poll silently without notification (Telegram + Discord where supported)",
      false,
    )
    .option("--thread-id <id>", "Thread id (Telegram forum topic / Slack thread ts)")
    .action(async (opts) => {
      await helpers.runMessageAction("poll", opts);
    });
}

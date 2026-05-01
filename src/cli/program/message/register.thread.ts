import type { Command } from "commander";
import { getChannelPlugin } from "../../../channels/plugins/index.js";
import type { ChannelMessageActionName } from "../../../channels/plugins/types.public.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
import type { MessageCliHelpers } from "./helpers.js";

function resolveThreadCreateRequest(opts: Record<string, unknown>) {
  const channel = normalizeLowercaseStringOrEmpty(opts.channel);
  if (channel) {
    const request = getChannelPlugin(channel)?.actions?.resolveCliActionRequest?.({
      action: "thread-create",
      args: opts,
    });
    if (request) {
      return {
        action: request.action,
        params: request.args,
      };
    }
  }
  return {
    action: "thread-create" as ChannelMessageActionName,
    params: opts,
  };
}

export function registerMessageThreadCommands(message: Command, helpers: MessageCliHelpers) {
  const thread = message.command("thread").description("Thread actions");

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(
        thread
          .command("create")
          .description("Create a thread")
          .requiredOption("--thread-name <name>", "Thread name"),
      ),
    )
    .option("--message-id <id>", "Message id (optional)")
    .option("-m, --message <text>", "Initial thread message text")
    .option("--auto-archive-min <n>", "Thread auto-archive minutes")
    .action(async (opts) => {
      const request = resolveThreadCreateRequest(opts);
      await helpers.runMessageAction(request.action, request.params);
    });

  helpers
    .withMessageBase(
      thread
        .command("list")
        .description("List threads")
        .requiredOption("--guild-id <id>", "Guild id"),
    )
    .option("--channel-id <id>", "Channel id")
    .option("--include-archived", "Include archived threads", false)
    .option("--before <id>", "Read/search before id")
    .option("--limit <n>", "Result limit")
    .action(async (opts) => {
      await helpers.runMessageAction("thread-list", opts);
    });

  helpers
    .withMessageBase(
      helpers.withRequiredMessageTarget(
        thread
          .command("reply")
          .description("Reply in a thread")
          .requiredOption("-m, --message <text>", "Message body"),
      ),
    )
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option("--reply-to <id>", "Reply-to message id")
    .action(async (opts) => {
      await helpers.runMessageAction("thread-reply", opts);
    });
}

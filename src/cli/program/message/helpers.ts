import type { Command } from "commander";
import { messageCommand } from "../../../commands/message.js";
import { danger, setVerbose } from "../../../globals.js";
import { defaultRuntime } from "../../../runtime.js";
import { createDefaultDeps } from "../../deps.js";

export type MessageCliHelpers = {
  withMessageBase: (command: Command) => Command;
  withMessageTarget: (command: Command) => Command;
  withRequiredMessageTarget: (command: Command) => Command;
  runMessageAction: (
    action: string,
    opts: Record<string, unknown>,
  ) => Promise<void>;
};

export function createMessageCliHelpers(
  message: Command,
  messageChannelOptions: string,
): MessageCliHelpers {
  const withMessageBase = (command: Command) =>
    command
      .option("--channel <channel>", `Channel: ${messageChannelOptions}`)
      .option("--account <id>", "Channel account id (accountId)")
      .option("--json", "Output result as JSON", false)
      .option("--dry-run", "Print payload and skip sending", false)
      .option("--verbose", "Verbose logging", false);

  const withMessageTarget = (command: Command) =>
    command.option(
      "-t, --to <dest>",
      "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id",
    );
  const withRequiredMessageTarget = (command: Command) =>
    command.requiredOption(
      "-t, --to <dest>",
      "Recipient/channel: E.164 for WhatsApp/Signal, Telegram chat id/@username, Discord/Slack channel/user, or iMessage handle/chat_id",
    );

  const runMessageAction = async (
    action: string,
    opts: Record<string, unknown>,
  ) => {
    setVerbose(Boolean(opts.verbose));
    const deps = createDefaultDeps();
    try {
      await messageCommand(
        {
          ...(() => {
            const { account, ...rest } = opts;
            return {
              ...rest,
              accountId: typeof account === "string" ? account : undefined,
            };
          })(),
          action,
        },
        deps,
        defaultRuntime,
      );
    } catch (err) {
      defaultRuntime.error(danger(String(err)));
      defaultRuntime.exit(1);
    }
  };

  // `message` is only used for `message.help({ error: true })`, keep the
  // command-specific helpers grouped here.
  void message;

  return {
    withMessageBase,
    withMessageTarget,
    withRequiredMessageTarget,
    runMessageAction,
  };
}

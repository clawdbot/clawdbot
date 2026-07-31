// Doctor visibility for channel ingress events retained after terminal failure.
import { note } from "../../packages/terminal-core/src/note.js";
import { countFailedChannelIngressQueueEntries } from "../channels/message/ingress-queue.js";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";

type NoteChannelIngressDeadLettersOptions = {
  stateDir?: string;
  noteFn?: typeof note;
};

/** Mention channel accounts with retained ingress failures and their recovery command. */
export function noteChannelIngressDeadLetters(
  options: NoteChannelIngressDeadLettersOptions = {},
): void {
  const failed = countFailedChannelIngressQueueEntries(options.stateDir);
  if (failed.length === 0) {
    return;
  }
  const lines = failed.map(
    (entry) =>
      `- ${entry.channelId}/${entry.accountId}: ${entry.count} dead-lettered ingress event${entry.count === 1 ? "" : "s"}.`,
  );
  const first = failed[0];
  if (first) {
    lines.push(
      `- Inspect with ${formatCliCommand(
        [
          "openclaw",
          "channels",
          "dead-letters",
          "list",
          "--channel",
          first.channelId,
          "--account",
          first.accountId,
        ]
          .map(quoteCliArg)
          .join(" "),
      )}.`,
    );
  }
  (options.noteFn ?? note)(lines.join("\n"), "Channel ingress");
}

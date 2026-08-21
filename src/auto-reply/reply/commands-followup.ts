// Implements a one-message followup queue override without changing session settings.
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const FOLLOWUP_USAGE = "Usage: /followup <message>";

function parseFollowupMessage(raw: string): string | null {
  const match = raw.trim().match(/^\/followup(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  return (match[1] ?? "").trim();
}

export const handleFollowupCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/followup", match: parseFollowupMessage },
  (params, message) => {
    if (!message) {
      return commandReply(FOLLOWUP_USAGE);
    }

    applyCommandTextToParams(params, message);
    params.directives.hasQueueDirective = true;
    params.directives.queueReset = false;
    params.directives.queueMode = "followup";
    return { shouldContinue: true };
  },
);

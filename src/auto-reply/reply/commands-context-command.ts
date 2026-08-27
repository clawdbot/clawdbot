// Implements context inspection commands for the active reply session.
import { defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import { buildContextReply } from "./commands-context-report.js";
import type { CommandHandler } from "./commands-types.js";

export const handleContextCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/context",
    match: (body) => matchCommandPrefix(body, "/context"),
    silentUnauthorized: true,
  },
  async (params) => ({ shouldContinue: false, reply: await buildContextReply(params) }),
);

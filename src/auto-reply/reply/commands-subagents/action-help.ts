import { commandReply } from "../command-gates.js";
// Formats subagent command help text and usage summaries.
import type { CommandHandlerResult } from "../commands-types.js";
import { buildSubagentsHelp } from "./shared.js";

export function handleSubagentsHelpAction(): CommandHandlerResult {
  return commandReply(buildSubagentsHelp());
}

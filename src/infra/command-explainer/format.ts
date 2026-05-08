import type { ExecApprovalCommandSpan } from "../exec-approvals.js";
import type { CommandExplanation } from "./types.js";

function spanToCommandSpan(span: {
  startIndex: number;
  endIndex: number;
}): ExecApprovalCommandSpan | null {
  if (!Number.isSafeInteger(span.startIndex) || !Number.isSafeInteger(span.endIndex)) {
    return null;
  }
  if (span.startIndex < 0 || span.endIndex <= span.startIndex) {
    return null;
  }
  return { startIndex: span.startIndex, endIndex: span.endIndex };
}

export function formatCommandSpans(explanation: CommandExplanation): ExecApprovalCommandSpan[] {
  const commandSpans: ExecApprovalCommandSpan[] = [];

  for (const command of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
    const commandSpan = spanToCommandSpan(command.executableSpan);
    if (commandSpan) {
      commandSpans.push(commandSpan);
    }
  }
  return commandSpans;
}

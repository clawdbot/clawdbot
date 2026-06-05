// Command-explainer formatting converts parsed executable spans into approval
// UI highlight ranges, omitting shells whose parsing semantics differ.
import type { ExecApprovalCommandSpan } from "../exec-approvals.js";
import { normalizeExecutableToken } from "../exec-wrapper-tokens.js";
import {
  isShellWrapperExecutable,
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../shell-wrapper-resolution.js";
import type { CommandExplanation } from "./types.js";

const POSIX_COMMAND_HIGHLIGHT_SHELLS: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;

// Approval spans must be strict positive source ranges to avoid broken highlighting.
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

function isUnsupportedShellWrapperArgv(argv: readonly string[]): boolean {
  const shellWrapperArgv = resolveShellWrapperTransportArgv([...argv]) ?? argv;
  const executable = shellWrapperArgv[0];
  if (!executable) {
    return false;
  }
  const normalizedExecutable = normalizeExecutableToken(executable);
  return (
    isShellWrapperExecutable(normalizedExecutable) &&
    !POSIX_COMMAND_HIGHLIGHT_SHELLS.has(normalizedExecutable)
  );
}

function hasUnsupportedShellWrapper(explanation: CommandExplanation): boolean {
  return explanation.topLevelCommands.some((command) =>
    isUnsupportedShellWrapperArgv(command.argv),
  );
}

/** Converts a parsed command explanation into source spans suitable for approval UI. */
export function formatCommandSpans(explanation: CommandExplanation): ExecApprovalCommandSpan[] {
  if (hasUnsupportedShellWrapper(explanation)) {
    return [];
  }
  const commandSpans: ExecApprovalCommandSpan[] = [];

  for (const command of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
    const commandSpan = spanToCommandSpan(command.executableSpan);
    if (commandSpan) {
      commandSpans.push(commandSpan);
    }
  }
  return commandSpans;
}

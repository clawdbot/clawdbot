import type { ToolCallRecord } from "../logging/diagnostic-session-state.js";

export function getNoProgressStreak(
  history: readonly ToolCallRecord[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  const repeatedArguments = countNoProgressStreak(history, toolName, argsHash, false);
  if (toolName !== "exec") {
    return repeatedArguments;
  }
  // Real terminal failures may repeat across fresh args; only a contiguous typed tail qualifies.
  const terminalFailures = countNoProgressStreak(history, toolName, argsHash, true);
  return terminalFailures.count > repeatedArguments.count ? terminalFailures : repeatedArguments;
}

function countNoProgressStreak(
  history: readonly ToolCallRecord[],
  toolName: string,
  argsHash: string,
  terminalExecFailuresOnly: boolean,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestOutcome: ToolCallRecord | undefined;
  let crossedArgumentBoundary = false;
  // Vetoes are provisional until an older concrete outcome anchors them; a newer
  // changed outcome must reset vetoes from the previous no-progress streak.
  let pendingLoopVetoes = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record) {
      continue;
    }
    if (record.toolName !== toolName) {
      if (terminalExecFailuresOnly) {
        break;
      }
      continue;
    }
    if (!terminalExecFailuresOnly && record.argsHash !== argsHash) {
      continue;
    }
    if (record.outcomeKind === "tool-loop-veto") {
      pendingLoopVetoes += 1;
      continue;
    }
    if (typeof record.resultHash !== "string" || !record.resultHash) {
      continue;
    }
    if (terminalExecFailuresOnly && record.outcomeKind !== "terminal-exec-failure") {
      break;
    }
    if (!latestOutcome) {
      latestOutcome = record;
      crossedArgumentBoundary = record.argsHash !== argsHash;
      streak = pendingLoopVetoes + 1;
      pendingLoopVetoes = 0;
      continue;
    }
    if (terminalExecFailuresOnly) {
      // Once the scan crosses away from the requested command, finding it again
      // belongs to an older tail. Unique changing arguments can still count together.
      if (crossedArgumentBoundary && record.argsHash === argsHash) {
        break;
      }
      if (record.argsHash !== argsHash) {
        crossedArgumentBoundary = true;
      }
    }
    const repeatsSameFailure =
      terminalExecFailuresOnly &&
      record.failureIdentityHash !== undefined &&
      record.failureIdentityHash === latestOutcome.failureIdentityHash;
    if (record.resultHash !== latestOutcome.resultHash && !repeatsSameFailure) {
      break;
    }
    streak += pendingLoopVetoes + 1;
    pendingLoopVetoes = 0;
  }

  return {
    count: latestOutcome ? streak : terminalExecFailuresOnly ? 0 : pendingLoopVetoes,
    latestResultHash: latestOutcome?.resultHash,
  };
}

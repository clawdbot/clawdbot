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
  let latestResultHash: string | undefined;
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
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = pendingLoopVetoes + 1;
      pendingLoopVetoes = 0;
      continue;
    }
    if (record.resultHash !== latestResultHash) {
      break;
    }
    streak += pendingLoopVetoes + 1;
    pendingLoopVetoes = 0;
  }

  return {
    count: latestResultHash ? streak : terminalExecFailuresOnly ? 0 : pendingLoopVetoes,
    latestResultHash,
  };
}

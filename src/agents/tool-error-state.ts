import type { ToolErrorSummary, ToolRecoverySummary } from "./tool-error-summary.js";
import { isSameToolMutationAction } from "./tool-mutation.js";

type ToolAction = Pick<ToolErrorSummary, "toolName" | "meta" | "actionFingerprint" | "fileTarget">;

type ToolTerminalState = {
  lastToolError?: ToolErrorSummary;
  lastToolRecovery?: ToolRecoverySummary;
};

type ToolRecoveryState = {
  actions: ToolAction[];
  summary: ToolRecoverySummary;
};

type ToolErrorState = {
  recordFailure: (failure: ToolErrorSummary) => ToolTerminalState;
  recordSuccess: (
    success: ToolAction,
    fileTargets?: readonly NonNullable<ToolAction["fileTarget"]>[],
  ) => ToolTerminalState;
};

/** Keep attempt-local mutation recovery state outside the public error summary. */
export function createToolErrorState(): ToolErrorState {
  let nonMutatingFailure: ToolErrorSummary | undefined;
  let unresolvedMutations: ToolErrorSummary[] = [];
  // Keep the recovered action identity until terminal delivery. Only another
  // failure of that action invalidates its receipt; unrelated failures do not.
  let recovery: ToolRecoveryState | undefined;

  const current = () => unresolvedMutations.at(-1) ?? nonMutatingFailure;
  const terminalState = (): ToolTerminalState => {
    const lastToolError = current();
    return {
      ...(lastToolError ? { lastToolError } : {}),
      ...(recovery ? { lastToolRecovery: recovery.summary } : {}),
    };
  };

  return {
    recordFailure(failure) {
      if (recovery) {
        const recoveredIndex = recovery.actions.findIndex((action) =>
          isSameToolMutationAction(action, failure),
        );
        if (recoveredIndex >= 0) {
          recovery.actions.splice(recoveredIndex, 1);
          if (recovery.actions.length === 0) {
            recovery = undefined;
          }
        }
      }
      if (failure.mutatingAction !== true) {
        if (unresolvedMutations.length === 0) {
          nonMutatingFailure = failure;
        }
        return terminalState();
      }
      nonMutatingFailure = undefined;
      const sameIndex = unresolvedMutations.findIndex((entry) =>
        isSameToolMutationAction(entry, failure),
      );
      if (sameIndex >= 0) {
        unresolvedMutations.splice(sameIndex, 1);
      }
      unresolvedMutations.push(failure);
      return terminalState();
    },
    recordSuccess(success, fileTargets) {
      if (unresolvedMutations.length === 0) {
        nonMutatingFailure = undefined;
        return terminalState();
      }
      const successes = fileTargets?.map((fileTarget) => ({ ...success, fileTarget })) ?? [success];
      const recoveredActions: ToolAction[] = [];
      const remainingMutations: ToolErrorSummary[] = [];
      for (const entry of unresolvedMutations) {
        const matchingSuccess = successes.find((candidate) =>
          isSameToolMutationAction(entry, candidate),
        );
        if (matchingSuccess) {
          if (!recoveredActions.includes(matchingSuccess)) {
            recoveredActions.push(matchingSuccess);
          }
        } else {
          remainingMutations.push(entry);
        }
      }
      unresolvedMutations = remainingMutations;
      const recoveredToolName = recoveredActions.at(-1)?.toolName;
      if (recoveredToolName) {
        recovery = {
          actions: recoveredActions,
          summary: { toolName: recoveredToolName },
        };
      }
      return terminalState();
    },
  };
}

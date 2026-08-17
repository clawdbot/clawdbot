import type { ToolErrorSummary, ToolRecoverySummary } from "./tool-error-summary.js";
import { isSameToolMutationAction } from "./tool-mutation.js";

type ToolSuccessState =
  | { kind: "clear" }
  | { kind: "recovered"; lastToolRecovery: ToolRecoverySummary }
  | { kind: "unresolved"; lastToolError: ToolErrorSummary };

type ToolErrorState = {
  recordFailure: (failure: ToolErrorSummary) => ToolErrorSummary;
  recordSuccess: (
    success: Pick<ToolErrorSummary, "toolName" | "meta" | "actionFingerprint" | "fileTarget">,
  ) => ToolSuccessState;
};

/** Keep attempt-local mutation recovery state outside the public error summary. */
export function createToolErrorState(): ToolErrorState {
  let nonMutatingFailure: ToolErrorSummary | undefined;
  let unresolvedMutations: ToolErrorSummary[] = [];
  // Latch recovery through later successes until terminal payload assembly.
  // A later failure supersedes it; clearing on reads would lose the retry receipt.
  let lastToolRecovery: ToolRecoverySummary | undefined;

  const current = () => unresolvedMutations.at(-1) ?? nonMutatingFailure;

  return {
    recordFailure(failure) {
      lastToolRecovery = undefined;
      if (failure.mutatingAction !== true) {
        if (unresolvedMutations.length === 0) {
          nonMutatingFailure = failure;
        }
        return current() ?? failure;
      }
      nonMutatingFailure = undefined;
      const sameIndex = unresolvedMutations.findIndex((entry) =>
        isSameToolMutationAction(entry, failure),
      );
      if (sameIndex >= 0) {
        unresolvedMutations.splice(sameIndex, 1);
      }
      unresolvedMutations.push(failure);
      return failure;
    },
    recordSuccess(success) {
      if (unresolvedMutations.length === 0) {
        nonMutatingFailure = undefined;
        return lastToolRecovery ? { kind: "recovered", lastToolRecovery } : { kind: "clear" };
      }
      const unresolvedCount = unresolvedMutations.length;
      unresolvedMutations = unresolvedMutations.filter(
        (entry) => !isSameToolMutationAction(entry, success),
      );
      const unresolved = current();
      if (unresolved) {
        return { kind: "unresolved", lastToolError: unresolved };
      }
      if (unresolvedMutations.length < unresolvedCount) {
        lastToolRecovery = { toolName: success.toolName };
        return { kind: "recovered", lastToolRecovery };
      }
      return { kind: "clear" };
    },
  };
}

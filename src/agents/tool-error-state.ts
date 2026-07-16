import type { ToolErrorSummary } from "./tool-error-summary.js";
import { isSameToolMutationAction } from "./tool-mutation.js";

type ToolErrorState = {
  recordFailure: (failure: ToolErrorSummary) => ToolErrorSummary;
  recordSuccess: (
    success: Pick<ToolErrorSummary, "toolName" | "meta" | "actionFingerprint" | "fileTarget">,
  ) => ToolErrorSummary | undefined;
};

/** Keep attempt-local mutation recovery state outside the public error summary. */
export function createToolErrorState(): ToolErrorState {
  let nonMutatingFailure: ToolErrorSummary | undefined;
  let unresolvedMutations: ToolErrorSummary[] = [];

  const current = () => unresolvedMutations.at(-1) ?? nonMutatingFailure;

  return {
    recordFailure(failure) {
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
        return undefined;
      }
      unresolvedMutations = unresolvedMutations.filter(
        (entry) => !isSameToolMutationAction(entry, success),
      );
      return current();
    },
  };
}

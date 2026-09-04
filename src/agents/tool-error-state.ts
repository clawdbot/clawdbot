import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ToolErrorSummary } from "./tool-error-summary.js";

type ToolTerminalState = {
  lastToolError?: ToolErrorSummary;
};

type ToolErrorState = {
  recordFailure: (failure: ToolErrorSummary) => ToolTerminalState;
  recordSuccess: (toolName: string) => ToolTerminalState;
};

/** Track the run's last tool failure until the same tool succeeds. */
export function createToolErrorState(): ToolErrorState {
  let lastToolError: ToolErrorSummary | undefined;
  const terminalState = (): ToolTerminalState => (lastToolError ? { lastToolError } : {});

  return {
    recordFailure(failure) {
      lastToolError = failure;
      return terminalState();
    },
    recordSuccess(toolName) {
      if (
        lastToolError &&
        normalizeLowercaseStringOrEmpty(lastToolError.toolName) ===
          normalizeLowercaseStringOrEmpty(toolName)
      ) {
        lastToolError = undefined;
      }
      return terminalState();
    },
  };
}

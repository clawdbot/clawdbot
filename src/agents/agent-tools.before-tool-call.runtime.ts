import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

// Runtime seam for before-tool-call handling. Tests can replace this object while
// production code gets diagnostics and loop-detection dependencies from one place.
export const beforeToolCallRuntime = {
  getDiagnosticSessionState,
  logToolLoopAction,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
};

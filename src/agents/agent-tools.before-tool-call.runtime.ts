/**
 * Lazy runtime dependencies for before_tool_call handling.
 * Keeps diagnostics and loop-detection imports behind a seam that tests can
 * replace without loading the full runtime graph.
 */
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { logToolLoopAction } from "../logging/diagnostic.js";
import {
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
} from "./tool-loop-detection.js";

/** Runtime seam for before_tool_call diagnostics and loop detection. */
export const beforeToolCallRuntime = {
  getDiagnosticSessionState,
  logToolLoopAction,
  detectToolCallLoop,
  recordToolCall,
  recordToolCallOutcome,
};

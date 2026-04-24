import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunTrigger } from "./params.js";

export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  memoryFlushWritePath?: string;
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  memoryFlushWritePath?: string;
  trace?: DiagnosticTraceContext;
} {
  return {
    trigger: params.trigger,
    memoryFlushWritePath: params.memoryFlushWritePath,
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}

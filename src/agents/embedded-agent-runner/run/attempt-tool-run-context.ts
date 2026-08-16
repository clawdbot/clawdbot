import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
/**
 * Builds tool run context passed to embedded-agent tool handlers.
 */
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import type { MemoryFlushAppendBudget } from "../../memory-flush-append.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Builds the stable tool-run context forwarded into an embedded-attempt execution.
 */
export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  memoryFlushAppendBudget?: MemoryFlushAppendBudget;
  toolsAllow?: string[];
  conversationToolPolicy?: GroupToolPolicyConfig;
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  memoryFlushAppendBudget?: MemoryFlushAppendBudget;
  runtimeToolAllowlist?: string[];
  conversationToolPolicy?: GroupToolPolicyConfig;
  trace?: DiagnosticTraceContext;
} {
  return {
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    memoryFlushAppendBudget: params.memoryFlushAppendBudget,
    ...(params.toolsAllow ? { runtimeToolAllowlist: params.toolsAllow } : {}),
    ...(params.conversationToolPolicy
      ? { conversationToolPolicy: params.conversationToolPolicy }
      : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}

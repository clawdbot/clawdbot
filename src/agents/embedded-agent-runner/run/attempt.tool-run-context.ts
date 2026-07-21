/**
 * Builds tool run context passed to embedded-agent tool handlers.
 */
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  type InputProvenance,
  isAgentToAgentSendInputProvenance,
} from "../../../sessions/input-provenance.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Builds the stable tool-run context forwarded into an embedded-attempt execution.
 */
export function buildEmbeddedAttemptToolRunContext(params: {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  toolsAllow?: string[];
  inputProvenance?: InputProvenance;
  trace?: DiagnosticTraceContext;
}): {
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  runtimeToolAllowlist?: string[];
  interAgentSendTurn?: boolean;
  trace?: DiagnosticTraceContext;
} {
  return {
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    ...(params.toolsAllow ? { runtimeToolAllowlist: params.toolsAllow } : {}),
    // A sessions_send A2A turn already returns its reply through the tool result.
    // Flag it so tool construction drops sessions_send and the target cannot
    // reverse-call the requester (issue #39476).
    ...(isAgentToAgentSendInputProvenance(params.inputProvenance)
      ? { interAgentSendTurn: true }
      : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}

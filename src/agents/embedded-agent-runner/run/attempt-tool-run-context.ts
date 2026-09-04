import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { GroupToolPolicyConfig } from "../../../config/types.tools.js";
import {
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { mergeForcedEmbeddedAttemptToolsAllow } from "./attempt-tool-construction-plan.js";
import type { EmbeddedRunTrigger } from "./params.js";

/**
 * Builds the shared tool-run context for embedded and plugin harness attempts.
 */
export function buildEmbeddedAttemptToolRunContext(params: {
  thinkLevel?: ThinkLevel;
  trigger?: EmbeddedRunTrigger;
  jobId?: string;
  memoryFlushWritePath?: string;
  toolsAllow?: string[];
  forceMessageTool?: boolean;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
  conversationToolPolicy?: GroupToolPolicyConfig;
  trace?: DiagnosticTraceContext;
  currentInboundAudio?: boolean;
  replyOperation?: { readonly acceptedSteeredInboundAudio: boolean };
}) {
  const { currentInboundAudio, replyOperation } = params;
  // Collector output is mandatory result transport, even on a narrowed tool surface.
  const runtimeToolAllowlist = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
    forceToolNames:
      params.swarmCollector && params.swarmOutputSchema ? ["structured_output"] : undefined,
  });
  return {
    requesterThinkingLevel: params.thinkLevel,
    trigger: params.trigger,
    jobId: params.jobId,
    memoryFlushWritePath: params.memoryFlushWritePath,
    swarmCollector: params.swarmCollector,
    swarmOutputSchema: params.swarmOutputSchema,
    currentInboundAudio,
    // Read accepted steering from the captured owner when the tool executes.
    hasCurrentInboundAudio: () =>
      currentInboundAudio === true || replyOperation?.acceptedSteeredInboundAudio === true,
    ...(runtimeToolAllowlist ? { runtimeToolAllowlist } : {}),
    ...(params.conversationToolPolicy
      ? { conversationToolPolicy: params.conversationToolPolicy }
      : {}),
    // Freeze trace metadata at the attempt boundary so later mutable diagnostic updates do not
    // rewrite the facts attached to tool calls already in flight.
    ...(params.trace ? { trace: freezeDiagnosticTraceContext(params.trace) } : {}),
  };
}

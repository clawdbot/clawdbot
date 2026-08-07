import type { AgentExecutionAttribution } from "./agent-execution-attribution.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";

type ToolExecutionCorrelation = Readonly<{
  agentId?: string;
  contextId?: string;
  executionId?: string;
  lifecycleGeneration?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
}>;

const attributionByHookContext = new WeakMap<HookContext, AgentExecutionAttribution>();

/**
 * Bind admission attribution to a core-owned hook context without exposing a
 * forgeable property at the public SDK boundary.
 */
export function bindToolExecutionAttribution(
  ctx: HookContext,
  attribution: AgentExecutionAttribution | undefined,
): HookContext {
  if (attribution) {
    attributionByHookContext.set(ctx, attribution);
  }
  return ctx;
}

/** Preserve a private binding when a core owner must clone a hook context. */
export function inheritToolExecutionAttribution(
  source: HookContext | undefined,
  target: HookContext,
): HookContext {
  const attribution = source ? attributionByHookContext.get(source) : undefined;
  return bindToolExecutionAttribution(target, attribution);
}

/** Bound admission attribution is the only source of exact execution identity. */
export function resolveToolExecutionCorrelation(ctx?: HookContext): ToolExecutionCorrelation {
  const attribution = ctx ? attributionByHookContext.get(ctx) : undefined;
  if (!attribution) {
    return {
      ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.runId ? { runId: ctx.runId } : {}),
    };
  }
  return {
    ...(attribution.agentId ? { agentId: attribution.agentId } : {}),
    ...(attribution.contextId ? { contextId: attribution.contextId } : {}),
    ...(attribution.executionId ? { executionId: attribution.executionId } : {}),
    ...(attribution.lifecycleGeneration
      ? { lifecycleGeneration: attribution.lifecycleGeneration }
      : {}),
    ...(attribution.sessionKey ? { sessionKey: attribution.sessionKey } : {}),
    ...(attribution.sessionId ? { sessionId: attribution.sessionId } : {}),
    ...(attribution.runId ? { runId: attribution.runId } : {}),
  };
}

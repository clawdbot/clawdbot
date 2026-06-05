// Agent Core module implements runtime deps behavior.
import type { CompleteSimpleFn, StreamFn } from "../../llm-core/src/index.js";

/** Runtime functions injected by host packages so agent-core stays provider-agnostic. */
export interface AgentCoreRuntimeDeps {
  /** Streaming completion implementation used for normal agent turns. */
  streamSimple: StreamFn;
  /** Non-streaming completion implementation used by summarization helpers. */
  completeSimple: CompleteSimpleFn;
}

/** Runtime dependency subset required by streaming agent loops. */
export type AgentCoreStreamRuntimeDeps = Pick<AgentCoreRuntimeDeps, "streamSimple">;
/** Runtime dependency subset required by summarization helpers. */
export type AgentCoreCompletionRuntimeDeps = Pick<AgentCoreRuntimeDeps, "completeSimple">;

function missingRuntimeDep(name: keyof AgentCoreRuntimeDeps): Error {
  return new Error(
    `@openclaw/agent-core runtime dependency "${name}" is not configured. Pass an AgentCoreRuntimeDeps instance or a streamFn explicitly.`,
  );
}

/** Resolve the stream function, preferring an explicit override over injected runtime deps. */
export function resolveAgentCoreStreamFn(
  runtime: AgentCoreStreamRuntimeDeps | undefined,
  streamFn?: StreamFn,
): StreamFn {
  if (streamFn) {
    return streamFn;
  }
  if (runtime?.streamSimple) {
    return runtime.streamSimple;
  }
  throw missingRuntimeDep("streamSimple");
}

/** Resolve the completion function used by non-streaming helper flows. */
export function resolveAgentCoreCompleteFn(
  runtime: AgentCoreCompletionRuntimeDeps | undefined,
): CompleteSimpleFn {
  if (runtime?.completeSimple) {
    return runtime.completeSimple;
  }
  throw missingRuntimeDep("completeSimple");
}

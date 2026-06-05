// Agent core contracts define the minimal plugin-facing agent request and response shapes.
import {
  Agent as CoreAgent,
  type AgentOptions as CoreAgentOptions,
} from "../../packages/agent-core/src/agent.js";
import type { AgentCoreRuntimeDeps } from "../../packages/agent-core/src/runtime-deps.js";
import type { CompleteSimpleFn, StreamFn } from "../../packages/llm-core/src/index.js";
import { completeSimple, streamSimple } from "./llm.js";

/** Runtime adapter that lets the package agent-core use OpenClaw LLM helpers. */
export const openClawAgentCoreRuntime = {
  completeSimple: completeSimple as unknown as CompleteSimpleFn,
  streamSimple: streamSimple as unknown as StreamFn,
} satisfies AgentCoreRuntimeDeps;

/** Agent-core class preconfigured with OpenClaw runtime dependencies. */
export class Agent extends CoreAgent {
  constructor(options: CoreAgentOptions = {}) {
    super({ runtime: openClawAgentCoreRuntime, ...options });
  }
}

// OpenClaw-owned reusable agent core
export * from "../../packages/agent-core/src/index.js";
// Proxy utilities
export * from "../agents/runtime/proxy.js";

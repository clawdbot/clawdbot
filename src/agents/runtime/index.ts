/**
 * OpenClaw-owned agent runtime facade.
 *
 * Wires agent-core to the plugin SDK LLM runtime and re-exports reusable runtime helpers.
 */
import {
  Agent as CoreAgent,
  type AgentOptions as CoreAgentOptions,
} from "../../../packages/agent-core/src/agent.js";
import type { AgentCoreRuntimeDeps } from "../../../packages/agent-core/src/runtime-deps.js";
import type { CompleteSimpleFn, StreamFn } from "../../../packages/llm-core/src/index.js";
import { completeSimple, streamSimple } from "../../plugin-sdk/llm.js";

export const openClawAgentCoreRuntime = {
  completeSimple: completeSimple as unknown as CompleteSimpleFn,
  streamSimple: streamSimple as unknown as StreamFn,
} satisfies AgentCoreRuntimeDeps;

export class Agent extends CoreAgent {
  constructor(options: CoreAgentOptions = {}) {
    super({ runtime: openClawAgentCoreRuntime, ...options });
  }
}

// OpenClaw-owned reusable agent core
export * from "../../../packages/agent-core/src/index.js";
// Proxy utilities
export * from "./proxy.js";

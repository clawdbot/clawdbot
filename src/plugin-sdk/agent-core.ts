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
export { runAgentLoop } from "../../packages/agent-core/src/index.js";
// Documented proxy stream API stays until this entrypoint's announced
// public demotion window (registry: plugin-sdk-agent-core-public-demotion).
export { streamProxy } from "../agents/runtime/proxy.js";
export type { ProxyAssistantMessageEvent, ProxyStreamOptions } from "../agents/runtime/proxy.js";
export {
  bashExecutionToText,
  buildSessionContext,
  calculateContextTokens,
  collectEntriesForBranchSummaryFromBranches,
  compact,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateBranchSummary,
  generateSummary,
  getLastAssistantUsage,
  prepareBranchEntries,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
  uuidv7,
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  DEFAULT_COMPACTION_SETTINGS,
} from "../../packages/agent-core/src/index.js";
export type {
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AfterToolCallContext,
  AgentOptions,
  AgentState,
  AgentTool,
  AgentToolProgress,
  AgentToolResult,
  AgentToolUpdateCallback,
  BashExecutionMessage,
  BranchPreparation,
  BranchSummaryDetails,
  BranchSummaryResult,
  CompactionDetails,
  CompactionPreparation,
  CompactionResult,
  CompactionSettings,
  ContextUsageEstimate,
  FileOperations,
  Result,
  SessionTreeEntry,
  StreamFn,
  ThinkingLevel,
  ToolExecutionMode,
} from "../../packages/agent-core/src/index.js";
// Proxy utilities

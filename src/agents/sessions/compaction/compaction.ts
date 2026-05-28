import type { StreamFn as CoreStreamFn } from "../../../../packages/agent-core/src/llm.js";
import type { Model } from "../../../llm/types.js";
import {
  calculateContextTokens,
  compact as compactCore,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummary as generateSummaryCore,
  getLastAssistantUsage,
  prepareCompaction as prepareCompactionCore,
  serializeConversation,
  shouldCompact,
  openClawAgentCoreRuntime,
  type CompactionDetails,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionSettings,
  type ContextUsageEstimate,
  type Result,
} from "../../runtime/index.js";
import type { AgentMessage, StreamFn, ThinkingLevel } from "../../runtime/index.js";
import type { SessionEntry } from "../session-manager.js";

export {
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  getLastAssistantUsage,
  serializeConversation,
  shouldCompact,
  type CompactionDetails,
  type CompactionPreparation,
  type CompactionResult,
  type CompactionSettings,
  type ContextUsageEstimate,
};

function unwrapCompactionResult<T>(result: Result<T, Error>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

export function prepareCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  return unwrapCompactionResult(prepareCompactionCore(pathEntries, settings));
}

export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model,
  reserveTokens: number,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
): Promise<string> {
  return unwrapCompactionResult(
    await generateSummaryCore(
      currentMessages,
      model,
      reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
      thinkingLevel,
      streamFn as unknown as CoreStreamFn | undefined,
      openClawAgentCoreRuntime,
    ),
  );
}

export async function compact(
  preparation: CompactionPreparation,
  model: Model,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
  thinkingLevel?: ThinkingLevel,
  streamFn?: StreamFn,
): Promise<CompactionResult> {
  return unwrapCompactionResult(
    await compactCore(
      preparation,
      model,
      apiKey,
      headers,
      customInstructions,
      signal,
      thinkingLevel,
      streamFn as unknown as CoreStreamFn | undefined,
      openClawAgentCoreRuntime,
    ),
  );
}

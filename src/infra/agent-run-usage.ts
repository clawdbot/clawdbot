/** Cumulative output-token usage for one active agent run. */
type AgentRunUsage = {
  outputTokens: number;
};

type RecordAgentRunOutputTokensParams = {
  runId: string;
  lifecycleGeneration: string;
  outputTokens: number;
  emit: (usage: AgentRunUsage) => boolean;
};

const usageByRun = new Map<string, Map<string, AgentRunUsage>>();

/** Adds one completed model call and emits the new generation-scoped total. */
export function recordAgentRunOutputTokens(
  params: RecordAgentRunOutputTokensParams,
): AgentRunUsage | undefined {
  const outputTokens = Math.floor(params.outputTokens);
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
    return undefined;
  }
  const usageByGeneration = usageByRun.get(params.runId) ?? new Map<string, AgentRunUsage>();
  const previous = usageByGeneration.get(params.lifecycleGeneration);
  const usage = {
    outputTokens: (previous?.outputTokens ?? 0) + outputTokens,
  };
  if (!params.emit(usage)) {
    return undefined;
  }
  usageByGeneration.set(params.lifecycleGeneration, usage);
  usageByRun.set(params.runId, usageByGeneration);
  return usage;
}

export function clearAgentRunUsage(runId: string, lifecycleGeneration?: string): void {
  if (lifecycleGeneration === undefined) {
    usageByRun.delete(runId);
    return;
  }
  const usageByGeneration = usageByRun.get(runId);
  usageByGeneration?.delete(lifecycleGeneration);
  if (usageByGeneration?.size === 0) {
    usageByRun.delete(runId);
  }
}

export function resetAgentRunUsageForTest(): void {
  usageByRun.clear();
}

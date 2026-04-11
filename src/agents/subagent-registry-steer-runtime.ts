import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
};

type ReplaceSubagentRunAfterSteerFn = (params: ReplaceSubagentRunAfterSteerParams) => boolean;

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;

export function configureSubagentRegistrySteerRuntime(params: {
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
}) {
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
}

export function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}

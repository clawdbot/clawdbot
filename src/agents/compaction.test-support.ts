import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { CompactionSummarizationInstructions } from "./compaction.js";
import "./compaction.js";

type SummarizeWithFallbackParams = {
  messages: AgentMessage[];
  model: NonNullable<ExtensionContext["model"]>;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  reserveTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  previousSummary?: string;
};

type CompactionTestApi = {
  buildCompactionSummarizationInstructions(
    customInstructions?: string,
    instructions?: CompactionSummarizationInstructions,
  ): string | undefined;
  summarizeWithFallback(params: SummarizeWithFallbackParams): Promise<string>;
};

function getTestApi(): CompactionTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.compactionTestApi")
  ];
  if (!api) {
    throw new Error("compaction test API is unavailable");
  }
  return api as CompactionTestApi;
}

export function buildCompactionSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  return getTestApi().buildCompactionSummarizationInstructions(customInstructions, instructions);
}

export async function summarizeWithFallback(params: SummarizeWithFallbackParams): Promise<string> {
  return await getTestApi().summarizeWithFallback(params);
}
